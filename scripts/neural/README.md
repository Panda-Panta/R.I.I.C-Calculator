# Experimental CPU neural roster pipeline

This is an **experimental learned main + ordinary-relief generator**, not a default
optimizer, UI replacement, or claim of superior income. The policy scores legal
next actions from partial-roster features; it does not rank completed rosters.
The decoder never calls a heuristic roster builder to finish its output.

## Full-action pipeline (experimental, not parity-qualified)

The commands below describe the original small pipeline. The full-action pipeline
uses `full-train.mjs`, `full-train-worker.ts`, and the contracts in `full-training/`;
its current status and frozen evaluation evidence are recorded in `UPDATE_PLAN.md`.
Do not interchange their model formats or treat an old smoke run as full acceptance.

The full policy currently uses the 56,177-feature slot/group-aligned catalog.
`latest-native-group-cover-v3` is an explicit opt-in action mode: it excludes
prefixes that cannot admit native injective group replacement coverage. It does
not write the matching witness, repair output, globally ban reused group members,
or prove available beds or long-horizon completion. Legacy defaults remain intact.

The paired source transition `latest-default-to-aligned-group-cover-v4` requires
exclusive `--continue-from` and continuation ID
`aligned-union-native-cover-continuation-v1`. The supported parent is an authenticated
direct aligned-feature-migration TRAIN run. Parameters, inherited update count,
all 24 ordered TRAIN members, feature identity and numerical settings are retained;
the original migration receipt remains separate from the new continuation receipt.
Ordinary resume requires identical source/configuration. Changing the learning rate,
using a continuation as a new migration parent, or silently re-zeroing learned rows
is not supported by this contract and must not be disguised as resume.

External evaluation authenticates model, dataset, lineage, frozen source, input,
physics and actual completion. Incomplete or timed-out simulations remain unknown,
not zero or dropped rows. The exposed DEV result of 2026-10-26 has eight wins and
eight losses against the latest default mathematical reference; no release parity
or equal-resource claim is established. Experimental weights are not defaults.

## Commands

Requires the repository's installed Node 24+ toolchain. No new ML package or GPU
is needed. The launcher resolves the existing Vite/esbuild dependency and builds
isolated temporary Node bundles.

```sh
# Fast mechanism smoke; not multi-day acceptance.
node scripts/neural/run.mjs --output artifacts/neural/experiment/my-smoke \
  --families 3 --sizes 20 --warmup 0 --sample 2 --epochs 5

# Fixed, size-stratified practical curriculum: one train/dev/test family per size.
node scripts/neural/run.mjs --output artifacts/neural/experiment/my-practical \
  --families 12 --sizes 100,200,300,400 --layout 243 \
  --warmup 24 --sample 72 --epochs 60 --timeout-ms 120000

# Exact same source/config only; add --resume to the same command.
# Existing directories without matching manifests are never overwritten.
node --test scripts/neural/*.node-test.mjs
node node_modules/vitest/vitest.mjs run src/optimizer/neural/experiment.spec.ts --maxWorkers=1
```

`--help` lists bounded options. All simulations run sequentially in separate
processes, with a real wall-clock kill timeout; a Promise timeout on the blocked
simulator thread is not used. SIGINT/SIGTERM abort the active child, retain an
atomic checkpoint with a null failure label, then exit. During synchronous training,
the launcher allows 1.5 seconds for graceful shutdown, then force-terminates the
child; completed teacher checkpoints survive, but partial weights are not saved. Explicit resume retries
cancelled records but preserves ordinary failed/timed-out records as evidence.
Training is deterministic and restarts from initialization on resume; already
completed evaluations are retained. No held-out scores select epochs or weights.

## Saved model inference

`checkpoint-model.json` bundles weights, model hash, feature contract, source and
dataset hashes, and limitations. `model.json` is the raw numerical model.

```sh
node scripts/neural/run.mjs infer \
  --checkpoint artifacts/neural/experiment/my-practical/checkpoint-model.json \
  --scenario scenario.json --output decoded.json
```

`scenario.json` contains `{ "workspace": <RosterWorkspace>, "entries":
<OwnedOperatorInput[]> }`. A family object from the experiment manifest has these
fields and can be used directly. For new input, provide the actual owned phases
and levels and an empty supported workspace with explicit frozen dorm keepers
and Free beds. Inference **does not choose dorm keepers**. The v2 envelope checks the exact
all-`src` inference contract (decoder, catalog, stage rules and numerical code),
feature-source hash, version, dimensions, model hash and finite numerical values,
then decodes without a heuristic fallback. Output creation is exclusive.
`complete` only establishes decoder legality; `simulation: null` explicitly
means the exported output has not been simulator-qualified. Output keeps separate
`trainingSourceHash`, `runtimeSourceHash`, `datasetHash` and inference-contract
attribution. All source keys normalize Windows separators to POSIX form, and
missing hashes cannot pass validation.

For an original v1 envelope, an explicit metadata-only migration is available:

```sh
node scripts/neural/migrate-checkpoint.mjs ORIGINAL_CHECKPOINT ORIGINAL_MANIFEST NEW_V2_OUTPUT
```

Migration verifies the old model/manifest hashes and exact equivalence of **all
source-module hashes** with the runtime before writing a new exclusive-output
envelope. It records the original envelope hash; original evidence is never
rewritten or described as having run under newer pipeline code.

## Evidence and restrictions

- Families are split before candidate/trace generation. With at least three
  families per inventory size, each size is stratified separately. Otherwise a
  global family split is recorded. Variants inherit family identity.
- Inventories use deterministic catalog sampling and explicit stage mixtures:
  50% E0 level 1, 25% maximum legal stage/level, 25% E1 level 1 (or E0 for
  unpromotable operators). Every inventory includes 但书 with the same random
  stage distribution; her exact stage is recorded, not promoted for convenience.
- The teacher is the existing `buildSingletonFallback`; only exact legal replay
  followed by a completed `candidateSimulation` / schedule bridge run qualifies
  its trace for training. Failed/incomplete/timed-out labels stay **null**, never
  a fake zero reward. A genuine completed score of zero remains valid.
- Supported curriculum: singleton/neutral production, control, power, unique
  ordinary relief, explicit fixed dorm keepers and beds. Unsupported grouping,
  atomic combos, auxiliary staffing, and forbidden trade references are rejected
  rather than projected away. Ideal run-order references are reported as
  mechanical policy changes, not learned physical placements.
- `tiny` has one level-1 manufacturing slot, one level-3 power slot and a level-5
  dorm: four learned decisions plus one fixed keeper. It proves mechanics, not
  practical full-base performance. `243` learns 52 main/relief assignments with
  four fixed keepers, if complete (52/56 physical placements are neural).
- Fresh initialization, trained model, legal random decoding and teacher use one
  candidate per held-out family, identical simulator settings/seeds and timeouts.
  Reports separate dev and test and retain completion, violations, fallback,
  source-specific placement counts, mechanical changes and nullable scores.
- Model/feature/dataset/source hashes bind artifacts to exact bytes. The launcher
  hashes source before and after bundling and rejects concurrent source changes.
  The immutable bundle provenance is passed to the actual process. Git HEAD is
  supplementary; it does not replace dirty-source hashes.
- A complete finite multi-day run establishes only that synthetic case, not
  universal catalog support, real-game equivalence, or income superiority.

## Output files

- `manifest.json`: exact runnable command, seeds, source hashes, stages, families,
  split, layouts and simulator windows.
- `checkpoint.json`: resumable teachers/evaluations with exact workspaces/traces.
- `dataset.json`: simulator-qualified training-family decision samples only.
- `model.json`, `checkpoint-model.json`: deterministic saved numerical model.
- `report.json`: training diagnostics and all policy comparisons; no superiority
  assertion. Completion rates accompany scores to avoid survivor-only claims.

Raw checkpoints/datasets can be large and are ignored development evidence.
Preserve a compact experimental model plus manifest/report for distribution;
never substitute a smoke model for multi-day evidence without labeling it.
