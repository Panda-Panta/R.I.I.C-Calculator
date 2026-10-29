"""Private ordered-job cache and serial Node IPC. No simulator or hidden public F table."""
from __future__ import annotations

import copy
import hashlib
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time

sys.dont_write_bytecode = True


def file_sha256(path: str | Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


class CacheEvidenceError(ValueError):
    pass


class NativeResultCache:
    """Keys are supplied by Node JSON.stringify(actual_job), never Python sort_keys."""

    def __init__(self, root: str | Path):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.hits = 0
        self.misses = 0
        self.rejected = 0
        self.elapsed_ms = 0.0

    @staticmethod
    def _identity(prepared: dict) -> dict:
        identity = prepared.get('identity', prepared)
        result = {key: identity.get(key) for key in ('cache_key', 'engine_fingerprint', 'job_json_sha256')}
        if any(not isinstance(value, str) or len(value) != 64 or any(char not in '0123456789abcdef' for char in value) for value in result.values()):
            raise CacheEvidenceError('Missing exact ordered-job/engine identity')
        return result

    def _path(self, identity: dict) -> Path:
        return self.root / (identity['cache_key'] + '.json')

    def put(self, prepared: dict, evaluation: dict) -> Path:
        identity = self._identity(prepared)
        if self._identity(evaluation) != identity:
            raise CacheEvidenceError('Evaluation identity does not match prepared actual job')
        if prepared.get('analysis_schema') is not None and evaluation.get('analysis_schema') != prepared['analysis_schema']:
            raise CacheEvidenceError('Evaluation analysis schema mismatch')
        provenance = evaluation.get('provenance', {})
        path = provenance.get('evaluationRecordPath')
        expected = provenance.get('evaluationRecordSha256')
        if not path or not expected or file_sha256(path) != expected:
            raise CacheEvidenceError('Cache requires a real persisted evaluator record')
        record = json.loads(Path(path).read_text(encoding='utf-8'))
        if self._identity(record) != identity:
            raise CacheEvidenceError('Persisted evaluation identity mismatch')
        if prepared.get('analysis_schema') is not None and record.get('analysis_schema') != prepared['analysis_schema']:
            raise CacheEvidenceError('Persisted analysis schema mismatch')
        for artifact in record.get('provenance', {}).get('artifact_files', []):
            if file_sha256(artifact['path']) != artifact['sha256']:
                raise CacheEvidenceError('Native evidence file changed')
        entry = {**identity, 'schemaVersion': 1, 'evaluationRecordPath': str(Path(path).resolve()), 'evaluationRecordSha256': expected,
                 'analysis_schema': record.get('analysis_schema'),
                 'origin': record.get('provenance', {}).get('kind', 'unknown'), 'cachedAt': time.time()}
        target = self._path(identity)
        if target.exists():
            # Keep the first physical evidence; duplicate logical queries do not create new F.
            old = json.loads(target.read_text(encoding='utf-8'))
            if old['evaluationRecordSha256'] != expected:
                self.get(prepared)  # Validate the existing immutable source instead of overwriting it.
            return target
        with target.open('x', encoding='utf-8') as stream:
            json.dump(entry, stream, ensure_ascii=False, allow_nan=False, indent=2)
        return target

    def get(self, prepared: dict) -> dict | None:
        started = time.perf_counter()
        try:
            identity = self._identity(prepared)
            path = self._path(identity)
            if not path.exists():
                self.misses += 1
                return None
            entry = json.loads(path.read_text(encoding='utf-8'))
            if any(entry.get(key) != value for key, value in identity.items()):
                raise CacheEvidenceError('Cache identity changed')
            record_path = Path(entry['evaluationRecordPath'])
            if file_sha256(record_path) != entry['evaluationRecordSha256']:
                raise CacheEvidenceError('Cached evaluator record changed')
            record = json.loads(record_path.read_text(encoding='utf-8'))
            if self._identity(record) != identity:
                raise CacheEvidenceError('Cached actual job/engine mismatch')
            if prepared.get('analysis_schema') is not None and (entry.get('analysis_schema') != prepared['analysis_schema']
                    or record.get('analysis_schema') != prepared['analysis_schema']):
                raise CacheEvidenceError('Cached analysis schema mismatch; re-import raw native evidence with the current extractor')
            for artifact in record.get('provenance', {}).get('artifact_files', []):
                if file_sha256(artifact['path']) != artifact['sha256']:
                    raise CacheEvidenceError('Cached native artifact changed')
            self.hits += 1
            result = copy.deepcopy(record)
            result['cache_hit'] = True
            result['cache_origin'] = entry['origin']
            result['current_physical_f_calls'] = 0
            result['historical_counters'] = result.get('counters', {})
            result['historical_timing'] = result.get('timing', {})
            result['timing'] = {'native_elapsed_ms': 0, 'native_cpu_user_ms': 0, 'native_cpu_system_ms': 0,
                                'cache_lookup_ms': (time.perf_counter() - started) * 1000}
            result['counters'] = {'candidate_invocations': 0, 'physical_f_calls': 0,
                                  'reused_physical_records': 1, 'physical_native_reports': 0}
            result['provenance'] = {**result.get('provenance', {}), 'evaluationRecordPath': str(record_path),
                                    'evaluationRecordSha256': entry['evaluationRecordSha256'], 'cacheEntryPath': str(path),
                                    'reuseIsNotColdRuntimeSpeedup': True}
            return result
        except (OSError, ValueError, KeyError) as error:
            self.rejected += 1
            raise CacheEvidenceError(str(error)) from error
        finally:
            self.elapsed_ms += (time.perf_counter() - started) * 1000


class NodeNativeClient:
    """One persistent Node process, one request at a time; no parallel native F."""

    def __init__(self, *, node: str, evaluator: str | Path, case: str | Path, domain: str | Path,
                 engine_binding: str | Path, out: str | Path, cache: NativeResultCache,
                 allow_native: bool = False, max_physical_f: int = 0, timeout: float = 1800):
        self.out = Path(out).resolve()
        self.out.mkdir(parents=True, exist_ok=True)
        self.cache = cache
        self.timeout = timeout
        self._sequence = 0
        self._lock = threading.Lock()
        self._responses = queue.Queue()
        self.ipc_ms = 0.0
        self.logical_evaluator_requests = 0
        self.events = []
        self._stderr = (self.out / 'native.stderr.log').open('x', encoding='utf-8')
        command = [node, str(evaluator), '--case', str(case), '--domain', str(domain), '--engine-binding', str(engine_binding),
                   '--out', str(self.out / 'native'), '--allow-native', 'yes' if allow_native else 'no', '--max-physical-f', str(max_physical_f)]
        env = {**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'}
        self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self._stderr,
                                        text=True, encoding='utf-8', env=env, bufsize=1)

        def reader():
            try:
                for line in self.process.stdout:
                    self._responses.put(line)
            finally:
                self._responses.put(None)

        self._reader = threading.Thread(target=reader, daemon=True)
        self._reader.start()
        self.protocol = self.request('hello')

    def request(self, operation: str, **payload) -> dict:
        with self._lock:
            started = time.perf_counter()
            self._sequence += 1
            number = self._sequence
            self.process.stdin.write(json.dumps({'id': number, 'op': operation, **payload}, ensure_ascii=False, allow_nan=False) + '\n')
            self.process.stdin.flush()
            line = self._responses.get(timeout=self.timeout)
            if line is None:
                raise RuntimeError(f'Native evaluator exited: {self.process.poll()}; see native.stderr.log')
            response = json.loads(line)
            if response.get('id') != number:
                raise RuntimeError('Native JSONL request/response order mismatch')
            self.ipc_ms += (time.perf_counter() - started) * 1000
            if 'error' in response:
                raise RuntimeError(response['error']['message'])
            return response['result']

    def import_incumbent(self, initial) -> dict:
        prepared = self.request('prepare', vector=list(initial), fidelity='full', seed=42)
        result = self.request('import-incumbent', vector=list(initial))
        if result.get('status') == 'ready':
            self.cache.put(prepared, result['evaluation'])
        self.events.append({'kind': 'incumbent-cache-import', 'status': result.get('status'), 'reason': result.get('reason'),
                            'logical_queries': 0, 'physical_f_calls': 0})
        return result

    def evaluate(self, vector, *, fidelity='full', seed=42) -> dict:
        # Problem.evaluate owns query charging, including cache hits/duplicates/unsupported seeds.
        self.logical_evaluator_requests += 1
        prepared = self.request('prepare', vector=list(vector), fidelity=fidelity, seed=seed)
        if prepared.get('status') != 'ready':
            return {'valid': False, 'score': None, 'reason': prepared.get('reason', 'unavailable-materialization'),
                    'native_status': prepared.get('status'), 'metrics': {}, 'counters': {'physical_f_calls': 0}}
        try:
            cached = self.cache.get(prepared)
        except CacheEvidenceError as error:
            return {'valid': False, 'score': None, 'reason': 'cache-evidence-rejected: ' + str(error), 'metrics': {},
                    'counters': {'physical_f_calls': 0}}
        if cached is not None:
            # F and strict/runtime facts belong to the exact job; edit cost/G belong to this scene's domain.
            cached.setdefault('metrics', {})['change_cost'] = prepared.get('changeCost')
            cached['metrics']['domainPrimaryHourlyScore'] = prepared.get('primaryHourlyScore')
            cached['metrics']['domainAdmission'] = prepared.get('domainAdmission')
            cached['current_request'] = {'vector': list(vector), 'fidelity': fidelity, 'seed': seed,
                                         'domain_binding': prepared.get('domain_binding'),
                                         'sceneRelativeMetricsRebound': ['change_cost', 'domainPrimaryHourlyScore', 'domainAdmission']}
            return cached
        result = self.request('evaluate', vector=list(vector), fidelity=fidelity, seed=seed, expected_cache_key=prepared['identity']['cache_key'])
        if result.get('provenance', {}).get('evaluationRecordPath'):
            self.cache.put(prepared, result)
        return result

    def stats(self) -> dict:
        return {**self.request('stats'), 'python_ipc_elapsed_ms': self.ipc_ms,
                'python_evaluator_requests': self.logical_evaluator_requests,
                'cache_hits': self.cache.hits, 'cache_misses': self.cache.misses, 'cache_rejected': self.cache.rejected,
                'cache_lookup_ms': self.cache.elapsed_ms}

    def close(self):
        if self.process.poll() is None:
            try:
                self.request('close')
            finally:
                self.process.stdin.close()
                self.process.wait(timeout=10)
        self._stderr.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
