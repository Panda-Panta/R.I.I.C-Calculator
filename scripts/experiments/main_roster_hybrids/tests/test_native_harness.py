"""Synthetic IPC/cache/budget tests only. No native RIIC simulation is called."""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[4]))
from scripts.experiments.main_roster_hybrids.native_cache import NativeResultCache, CacheEvidenceError, NodeNativeClient, file_sha256
from scripts.experiments.main_roster_hybrids.run_suite import select_recorded_winners, make_problem
from scripts.experiments.main_roster_hybrids.method_registry import load_legacy_common


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


class CacheTests(unittest.TestCase):
    def fixture(self, root):
        identity = {'cache_key': digest('ordered-job+engine'), 'engine_fingerprint': digest('engine'), 'job_json_sha256': digest('ordered-job')}
        raw = root / 'synthetic-raw.json'; raw.write_text('{"synthetic_only":true}', encoding='utf-8')
        record = {'identity': identity, 'valid': True, 'score': 17, 'observed_score': 17,
                  'evidence_type': 'synthetic-harness-only', 'metrics': {'ordinaryFatiguedHours': 0},
                  'provenance': {'kind': 'synthetic-only', 'artifact_files': [{'path': str(raw), 'sha256': file_sha256(raw)}]},
                  'counters': {'physical_f_calls': 1}}
        path = root / 'synthetic-evaluation.json'; path.write_text(json.dumps(record), encoding='utf-8')
        returned = {**record, 'provenance': {**record['provenance'], 'evaluationRecordPath': str(path), 'evaluationRecordSha256': file_sha256(path)}}
        return identity, returned, raw, path

    def test_hit_has_zero_current_physical_cost_and_preserves_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); identity, record, _, _ = self.fixture(root)
            cache = NativeResultCache(root / 'private'); cache.put(identity, record)
            result = cache.get(identity)
            self.assertEqual(result['score'], 17); self.assertTrue(result['cache_hit'])
            self.assertEqual(result['counters']['physical_f_calls'], 0)
            self.assertEqual(result['historical_counters']['physical_f_calls'], 1)
            result['metrics']['ordinaryFatiguedHours'] = 999
            self.assertEqual(cache.get(identity)['metrics']['ordinaryFatiguedHours'], 0)

    def test_changed_raw_or_record_is_rejected_not_returned_as_zero(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); identity, record, raw, _ = self.fixture(root)
            cache = NativeResultCache(root / 'private'); cache.put(identity, record)
            raw.write_text('{"changed":true}', encoding='utf-8')
            with self.assertRaises(CacheEvidenceError): cache.get(identity)
            self.assertEqual(cache.rejected, 1)

    def test_engine_or_entire_job_identity_mismatch_cannot_hit(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); identity, record, _, _ = self.fixture(root)
            cache = NativeResultCache(root / 'private'); cache.put(identity, record)
            changed = {**identity, 'engine_fingerprint': digest('other-engine')}
            with self.assertRaises(CacheEvidenceError): cache.get(changed)
            self.assertIsNone(cache.get({**identity, 'cache_key': digest('different-window')}))

    def test_unknown_unbacked_score_cannot_enter_cache(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); identity, _, _, _ = self.fixture(root)
            cache = NativeResultCache(root / 'private')
            with self.assertRaises(CacheEvidenceError): cache.put(identity, {'identity': identity, 'valid': True, 'score': 0})

    def test_old_analysis_metrics_are_explicitly_rejected_even_with_claimed_same_key(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); identity, record, _, _ = self.fixture(root)
            cache = NativeResultCache(root / 'private'); cache.put(identity, record)
            with self.assertRaisesRegex(CacheEvidenceError, 'analysis schema'):
                cache.get({**identity, 'analysis_schema': 'current-required-v2'})
            with self.assertRaisesRegex(CacheEvidenceError, 'analysis schema'):
                cache.put({**identity, 'analysis_schema': 'current-required-v2'}, record)

    def test_cross_scene_same_job_rebinds_edit_cost_without_rewriting_f_or_strict(self):
        class SyntheticCache:
            def get(self, prepared):
                return {'valid': True, 'score': 17, 'observed_score': 17, 'cache_hit': True,
                        'metrics': {'change_cost': 99, 'domainPrimaryHourlyScore': 4, 'strictEligibility': False,
                                    'ordinaryFatiguedHours': 0}, 'provenance': {'synthetic-only': True}}
        client = object.__new__(NodeNativeClient)
        client.logical_evaluator_requests = 0
        client.cache = SyntheticCache()
        client.request = lambda *_args, **_kwargs: {'status': 'ready', 'changeCost': 3, 'primaryHourlyScore': 8,
                                                   'domainAdmission': 'ready-bound-materialization'}
        result = client.evaluate([1], fidelity='full', seed=42)
        self.assertEqual(result['metrics']['change_cost'], 3)
        self.assertEqual(result['metrics']['domainPrimaryHourlyScore'], 8)
        self.assertEqual(result['observed_score'], 17)
        self.assertFalse(result['metrics']['strictEligibility'])
        self.assertEqual(result['current_request']['vector'], [1])


class OutcomeTests(unittest.TestCase):
    def test_short_never_final_and_quality_does_not_rewrite_observed_f(self):
        def row(value, fidelity='full', fatigue=0, strict=True):
            return {'valid': True, 'fidelity': fidelity, 'native_complete': True, 'score': value, 'observed_score': value,
                    'metrics': {'ordinaryFatiguedHours': fatigue, 'strictEligibility': strict}}
        winners = select_recorded_winners([row(999, 'short'), row(100, fatigue=2), row(90, strict=False)])
        self.assertEqual(winners['bestObservedF']['observed_score'], 100)
        self.assertEqual(winners['qualityAcceptedWinner']['observed_score'], 90)
        self.assertFalse(winners['qualityAcceptedWinner']['metrics']['strictEligibility'])
        self.assertIsNone(select_recorded_winners([row(999, 'short')])['bestObservedF'])

    def test_real_old_problem_charges_initial_cache_duplicate_short_and_unsupported(self):
        legacy = os.environ.get('RIIC_ROSTER_METHODS_ROOT')
        if not legacy: self.skipTest('Set explicit read-only RIIC_ROSTER_METHODS_ROOT')
        common = load_legacy_common(legacy)
        calls = []
        def evaluator(vector, *, fidelity, seed):
            calls.append((vector, fidelity, seed))
            if seed != 42: return {'valid': False, 'score': None, 'reason': 'unsupported-seed'}
            return {'valid': True, 'score': 17, 'cache_hit': True, 'evidence_type': 'synthetic-harness-only'}
        domain = {'schemaVersion': 1, 'initial': [0], 'publicSpec': {'id': 'synthetic-harness', 'domains': [2], 'initial': [0],
                  'unary': [[1, 2]], 'factors': [], 'forbidden': [], 'resources': [], 'metadata': {}}}
        problem = make_problem(common, domain, evaluator, 4)
        self.assertEqual(problem.history, [])
        problem.evaluate([0]); problem.evaluate([0]); problem.evaluate([1], fidelity='short'); bad = problem.evaluate([1], seed=43)
        self.assertEqual(len(problem.history), 4); self.assertEqual(problem.remaining, 0)
        self.assertIsNone(bad['score']); self.assertEqual(bad['seed'], 43); self.assertEqual(calls[-1][2], 43)
        self.assertEqual(len(calls), 4); self.assertFalse(problem.evaluate([0])['counted'])
        self.assertNotIn('materializations', problem.spec)


if __name__ == '__main__': unittest.main()
