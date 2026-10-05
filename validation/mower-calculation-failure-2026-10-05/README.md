# Mower full-preview recovery

The original nine-backup roster completed before the full-preview port, but the port stopped the entire simulation when one preview rejected a cyclic arrangement. Native `infra_main` treats this rejection as recoverable and retains the task for subsequent recovery.

The fix retains rejected tasks and their deadlines, applies the existing native stale-task rebuild rules, and finishes shift finalization when preview removes every physical move. In the zero-recognition-time model, unchanged previews wake at the next explicit task, morale boundary, or stale-task deadline instead of polling every microsecond. Native preview rejection and room-return delays remain enabled.

The unchanged fixture is `validation/mower-backup-2026-09-22/roster.json`. All nine backup plans remain enabled. Both gold drones with Fiammetta protection and experience drones without protection completed 72 hours of warmup plus 168 hours of sampling. No duplicate occupancy or ordinary producer work at zero morale was observed during the sampled segments.

The actual built calculation-worker message entry completed the same 240-hour window. Two installed-worker 48-hour checks also returned successful production reports with unchanged input and all nine backups. The long-validated and installed calculation workers have identical SHA-256 hashes.

Final regression results: 2,278 passed, one skipped, zero failed across 221 files. These results combine the initial full run with complete rechecks of five files; two stale failure expectations were corrected and three timeout cases were rechecked. Workspace and isolated-build typechecks passed.

Focused regression command:

```powershell
node node_modules/vitest/vitest.mjs run src/scheduler/mowerPreviewRecovery.spec.ts src/scheduler/mowerTaskExecutor.spec.ts src/scheduler/mowerBackupConvergence.spec.ts --maxWorkers=1 --testTimeout=90000
```

See `acceptance-summary.json` for compact evidence. Full diagnostic outputs and installation backups remain local. This is source simulation and built-worker entry validation; desktop clicks, live Mower device behavior, complete native/game-loop parity, and numerical income accuracy were not revalidated.
