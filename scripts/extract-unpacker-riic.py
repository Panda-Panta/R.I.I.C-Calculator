#!/usr/bin/env python3
"""Export installed RIIC tables through an external ArknightsUnpacker checkout.

Run with the unpacker's Python environment. No private decoder code or game data
is bundled here; only the explicit new output directory is written.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tomllib
import traceback

sys.dont_write_bytecode = True
TABLES = ("building_data", "character_table", "gamedata_const", "item_table", "data_version")


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", errors="backslashreplace")


def fingerprint(path):
    before = path.stat()
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    after = path.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise RuntimeError(f"Input changed while hashing: {path}")
    return {"sha256": digest.hexdigest(), "bytes": after.st_size}


def copy_verified(source, target, expected):
    before = fingerprint(source)
    if before != expected:
        raise RuntimeError(f"Input changed since extraction: {source}")
    if target.exists():
        if fingerprint(target) != expected:
            raise RuntimeError(f"Conflicting preserved input: {target.name}")
    else:
        with source.open("rb") as stream, target.open("xb") as destination:
            shutil.copyfileobj(stream, destination)
    if fingerprint(target) != expected or fingerprint(source) != expected:
        raise RuntimeError(f"Input or preserved copy changed: {source}")


def git_metadata(root):
    def git(*args, required=True):
        result = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True, encoding="utf-8", errors="replace")
        if required and result.returncode:
            raise RuntimeError(f"Cannot inspect unpacker Git metadata: {result.stderr.strip()}")
        return result.stdout.strip()
    commit = git("rev-parse", "HEAD")
    if len(commit) != 40 or any(char not in "0123456789abcdef" for char in commit):
        raise RuntimeError("Unpacker Git HEAD is not a full commit SHA")
    status = git("status", "--porcelain", "--untracked-files=normal")
    return {"toolGitCommit": commit, "toolGitRef": git("symbolic-ref", "--short", "-q", "HEAD", required=False) or "detached HEAD",
            "toolGitDirty": bool(status), "toolGitStatus": status.splitlines()}


def source_files(root):
    paths = list((root / "src" / "arknights_unpacker").rglob("*.py"))
    paths += [root / "pyproject.toml", root / "uv.lock", root / "vendor" / "sources.json"]
    paths += [root / "vendor" / "ark_fbs" / "CN" / (name + ".py") for name in (*TABLES[:-1], "resource_manifest")]
    paths += list((root / "vendor" / "lz4ak").glob("*.py"))
    return [{"path": path.relative_to(root).as_posix(), **fingerprint(path)} for path in sorted(set(paths)) if path.is_file()]


def inside(path, root):
    return path == root or root in path.parents


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("unpacker-root", "game-root", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    args = parser.parse_args()
    try:
        args.unpacker_root = args.unpacker_root.resolve(strict=True)
        args.game_root = args.game_root.resolve(strict=True)
        args.output = args.output.resolve()
    except OSError as error:
        parser.error(str(error))
    if not args.unpacker_root.is_dir() or not args.game_root.is_dir():
        parser.error("--unpacker-root and --game-root must be existing directories")
    if args.output.exists() or args.output.is_symlink():
        parser.error("--output must be a new directory; existing outputs are never overwritten")
    if inside(args.output, args.game_root) or inside(args.output, args.unpacker_root):
        parser.error("--output must be outside the game and unpacker directories")
    return parser, args


def main():
    parser, args = parse_args()
    tool_root, game_root, output = args.unpacker_root, args.game_root, args.output
    if not (tool_root / "src" / "arknights_unpacker" / "extraction" / "tables.py").is_file():
        parser.error("--unpacker-root does not contain the expected production table loader")
    sys.path.insert(0, str(tool_root / "src"))
    before_sources = source_files(tool_root)
    metadata = git_metadata(tool_root)
    import arknights_unpacker
    from arknights_unpacker.extraction.tables import load_local_tables
    from arknights_unpacker.extraction.decoder import DECODER_VERSION
    from arknights_unpacker.gamedata.normalize import normalize_table
    from arknights_unpacker.library.discover import discover_installation
    if not inside(Path(arknights_unpacker.__file__).resolve(), tool_root):
        raise RuntimeError("Imported unpacker does not belong to --unpacker-root")
    project_version = tomllib.loads((tool_root / "pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]
    if project_version != arknights_unpacker.__version__:
        raise RuntimeError("Unpacker pyproject and package versions disagree")
    installation = discover_installation(game_root)
    game_root = installation.root.resolve()
    if inside(output, game_root):
        parser.error("--output must be outside the resolved installation root")
    output.mkdir(parents=True, exist_ok=False)
    receipt = {"retrievedAt": timestamp(), "toolVersion": project_version, **metadata,
               "toolRoot": str(tool_root), "gameRoot": str(game_root), "pythonExecutable": sys.executable,
               "pythonVersion": sys.version, "decoderVersion": DECODER_VERSION, "toolSourceFiles": before_sources,
               "requestedTables": sorted(TABLES), "missingTables": sorted(TABLES), "complete": False, "diagnostics": []}
    try:
        input_metadata = []
        for layer, root in installation.source_roots.items():
            manifest = root / "hot_update_list.json"
            if manifest.is_file():
                input_metadata.append({"label": layer + "-manifest", "sourcePath": str(manifest), **fingerprint(manifest)})
        raw, normalized, preserved = output / "raw-tables", output / "normalized-tables", output / "raw-inputs"
        result = load_local_tables(game_root, raw, names=set(TABLES),
            emit=lambda event: print(json.dumps(event, ensure_ascii=False), flush=True))
        receipt.update({"version": result.version, "resourceVersion": result.resource_version,
                        "missingTables": sorted(set(TABLES) - result.tables.keys()), "diagnostics": result.diagnostics})
        if not result.complete or receipt["missingTables"] or result.diagnostics:
            raise RuntimeError("Production extraction is incomplete or has diagnostics")
        schema_commits = sorted({table.field_evidence["schemaCommit"] for table in result.tables.values() if "schemaCommit" in table.field_evidence})
        if len(schema_commits) != 1:
            raise RuntimeError(f"Expected one explicit production schema commit, found {schema_commits}")
        receipt["schemaCommit"] = schema_commits[0]
        if len(receipt["schemaCommit"]) != 40 or any(char not in "0123456789abcdef" for char in receipt["schemaCommit"]):
            raise RuntimeError("Production schema evidence does not contain a full commit SHA")
        receipt["outputFiles"] = {path.name: fingerprint(path) for path in sorted(raw.glob("*.json"))}
        normalized.mkdir()
        normalization_diagnostics = []
        for name in TABLES[:-1]:
            write_json(normalized / (name + ".json"), normalize_table(name, result.tables[name].data, normalization_diagnostics))
        (normalized / "data_version.txt").write_bytes(result.tables["data_version"].data["raw"].encode("utf-8"))
        if normalization_diagnostics:
            raise RuntimeError("Normalization diagnostics: " + "; ".join(normalization_diagnostics))
        normalizer_path = "src/arknights_unpacker/gamedata/normalize.py"
        normalizer_hash = next(file["sha256"] for file in before_sources if file["path"] == normalizer_path)
        normalization = {"version": result.version, "resourceVersion": result.resource_version,
            "normalizer": normalizer_path, "normalizerSha256": normalizer_hash, "diagnostics": normalization_diagnostics,
            "outputFiles": {path.name: fingerprint(path) for path in sorted(normalized.iterdir())}, "preservedRawInputs": {}}
        preserved.mkdir()
        for name, table in result.tables.items():
            source = Path(table.source.path)
            expected = {"sha256": table.source.sha256, "bytes": source.stat().st_size}
            target = preserved / source.name
            copy_verified(source, target, expected)
            normalization["preservedRawInputs"][name] = {"path": str(target), **expected}
        source_receipt = json.loads((raw / "sources.json").read_text(encoding="utf-8"))
        index = Path(source_receipt["manifest"])
        input_metadata.append({"label": "active-index", "sourcePath": str(index),
                               "sha256": source_receipt["manifest_sha256"], "bytes": index.stat().st_size})
        for entry in input_metadata:
            source = Path(entry["sourcePath"])
            target = preserved / (entry["label"] + source.suffix)
            copy_verified(source, target, {key: entry[key] for key in ("sha256", "bytes")})
            entry["preservedPath"] = str(target)
            if entry["label"].endswith("manifest"):
                value = json.loads(target.read_text(encoding="utf-8"))
                entry.update({key: value.get(key) for key in ("manifestVersion", "versionId", "manifestName")})
        if before_sources != source_files(tool_root) or metadata != git_metadata(tool_root):
            raise RuntimeError("Unpacker sources or Git metadata changed during extraction")
        checks = []
        for name, table in result.tables.items():
            for kind, path in (("original-ab", Path(table.source.path)), ("preserved-ab", Path(normalization["preservedRawInputs"][name]["path"]))):
                actual = fingerprint(path)
                checks.append({"table": name, "kind": kind, "path": str(path), "sha256": table.source.sha256,
                               "actual": actual["sha256"], "matched": actual["sha256"] == table.source.sha256})
        for entry in input_metadata:
            for kind, key in (("original", "sourcePath"), ("preserved", "preservedPath")):
                actual = fingerprint(Path(entry[key]))
                checks.append({"kind": kind + "-" + entry["label"], "path": entry[key], "sha256": entry["sha256"],
                               "actual": actual["sha256"], "matched": actual["sha256"] == entry["sha256"] and actual["bytes"] == entry["bytes"]})
        if not all(check["matched"] for check in checks):
            raise RuntimeError("Final source and preserved-input verification failed")
        receipt.update({"complete": True, "status": "succeeded", "completedAt": timestamp(),
            "evidenceBoundary": "Installed active-manifest PC extraction; schema omissions and unmapped enums remain explicit. Server freshness and live-game behavior are not verified."})
        write_json(output / "normalization-receipt.json", normalization)
        write_json(output / "source-input-audit.json", {"sourceMetadata": input_metadata})
        write_json(output / "final-source-verification.json", {"verifiedAt": timestamp(), "allMatched": True, "checks": checks,
                   "metadataGameRoot": str(game_root), "boundary": "Explicit installation discovery only; user settings and SQLite are not opened."})
        write_json(output / "extraction-receipt.json", receipt)
        print(json.dumps({"status": "succeeded", "version": result.version, "resourceVersion": result.resource_version,
                          "output": str(output), "tables": len(result.tables), "sourceHashChecks": len(checks),
                          "toolGitCommit": metadata["toolGitCommit"], "toolGitDirty": metadata["toolGitDirty"]}, ensure_ascii=False), flush=True)
        return 0
    except Exception as error:
        receipt.update({"complete": False, "status": "failed", "failedAt": timestamp(), "error": str(error)})
        receipt["diagnostics"] = [*receipt.get("diagnostics", []), str(error)]
        write_json(output / "extraction-receipt.json", receipt)
        write_json(output / "failure.json", {"error": str(error), "traceback": traceback.format_exc(), "outputPreserved": str(output)})
        print(f"Extraction failed; diagnostics retained in {output}: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
