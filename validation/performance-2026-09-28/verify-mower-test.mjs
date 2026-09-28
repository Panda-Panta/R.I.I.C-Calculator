import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import jpeg from 'jpeg-js'
import { createServer } from 'vite'

const source = 'C:/Users/Panda-Panta/Downloads/Mower Test/'
const mode = process.argv[2] ?? 'ideal'
const hours = Number(process.argv[3] ?? 24)
const warmupHours = Number(process.argv[4] ?? 0)
const maxStepHours = Number(process.argv[5] ?? .25)
const trace = process.argv[6] === 'trace'
const omitBackups = process.argv[7] === 'no-backups'
const omitRunners = process.argv[8] === 'no-runners'
const noWake = process.argv[9] === 'no-wake'
if (!['ideal', 'grandet'].includes(mode) || !Number.isFinite(hours) || hours <= 0 || !Number.isFinite(warmupHours) || warmupHours < 0 || !Number.isFinite(maxStepHours) || maxStepHours <= 0) {
  throw new Error('usage: verify-mower-test.mjs <ideal|grandet> [sampleHours] [warmupHours] [maxStepHours]')
}
const bytes = readFileSync(source + '排班表.jpeg')
const picture = jpeg.decode(bytes)
const hash = value => createHash('sha256').update(value).digest('hex')
const server = await createServer({ configFile: false, appType: 'custom', server: { middlewareMode: true, watch: null, hmr: false, ws: false }, optimizeDeps: { noDiscovery: true, include: [] } })
try {
  const { decode16QrFromRgba } = await server.ssrLoadModule('/src/workbench/compat/mowerQrCodec.ts')
  const { importMowerJson } = await server.ssrLoadModule('/src/workbench/compat/mowerJson.ts')
  const { runCalculationBridge } = await server.ssrLoadModule('/src/workbench/calculationBridge.ts')
  const { OPERATOR_MAP } = await server.ssrLoadModule('/src/domain/operators.ts')
  const { mowerReportMetrics } = await server.ssrLoadModule('/src/workbench/mowerReportMetrics.ts')
  const decoded = decode16QrFromRgba(picture.data, picture.width, picture.height)
  const fixture = readFileSync(new URL('../mower-output-2026-09-27/roster.json', import.meta.url), 'utf8')
  if (JSON.stringify(JSON.parse(decoded)) !== JSON.stringify(JSON.parse(fixture))) throw new Error('Mower Test QR roster differs from cached fixture')
  const workspace = importMowerJson(decoded)
  if (omitBackups) workspace.compatibility.backupPlans = []
  if (omitRunners) for (const facility of Object.values(workspace.mainPlan.facilities)) for (const slot of facility.slots) slot.replacements = slot.replacements.filter(id => !['但书', '龙舌兰'].includes(OPERATOR_MAP.get(id)?.name ?? id))
  const started = performance.now()
  const result = runCalculationBridge(workspace, {
    engine: 'simulation',
    simulationOptions: { warmupHours, sampleHours: hours, maxStepHours, maxEvents: 1_000_000, warmupModel: 'hourly', recordSegments: true, experimentalDisableIdealWake: noWake,
      production: { outputMode: 'potential', runOrderMode: mode, seed: 42, droneTarget: 'exp' } },
    simulationAssumptions: { restingThreshold: .65, freeRoom: false, fiammettaFool: false },
  })
  const report = result.simulationReport
  const events = report?.production?.events ?? []
  const completed = events.filter(event => event.type === 'order-completed')
  const specialRunnerIds = new Set((report?.inputs.schedule.runOrderPolicies.flatMap(policy => policy.orderedOperatorIds) ?? []).filter(id => ['但书', '龙舌兰'].includes(OPERATOR_MAP.get(id)?.name)))
  const temporaryRunnerHours = report?.segments.reduce((sum, segment) => sum + [...specialRunnerIds].filter(id => Object.entries(segment.occupants).some(([slot,occupant]) => slot.startsWith('room_') && occupant === id)).length * (segment.end - segment.start), 0)
  const specialOccupancySamples = report?.segments.filter(segment => Object.entries(segment.occupants).some(([slot,occupant]) => slot.startsWith('room_') && specialRunnerIds.has(occupant))).slice(0, 4).map(segment => ({ start: segment.start, end: segment.end, slots: Object.entries(segment.occupants).filter(([slot,occupant]) => slot.startsWith('room_') && specialRunnerIds.has(occupant)) }))
  const room21Transitions = []
  if (trace) for (const segment of report?.segments ?? []) {
    const team = Object.entries(segment.occupants).filter(([slot]) => slot.startsWith('room_2_1_')).sort(([a], [b]) => a.localeCompare(b)).map(([, id]) => id)
    if (JSON.stringify(team) !== JSON.stringify(room21Transitions.at(-1)?.team)) room21Transitions.push({ time: segment.start, team })
  }
  console.log(JSON.stringify({
    source, screenshotSha256: hash(bytes), decodedRosterSha256: hash(decoded), fixtureMatches: true,
    mode, hours, warmupHours, maxStepHours, omitBackups, omitRunners, noWake, seconds: (performance.now() - started) / 1000, success: result.success, error: result.error,
    elapsedHours: report?.elapsedHours, segments: report?.segments.length,
    score82: result.report?.summary?.totalScore82, mowerMetrics: report ? mowerReportMetrics(report) : null,
    productionEvents: events.length, droneGenerationEvents: events.filter(event => event.type === 'drone-generated').length,
    completedOrders: completed.length, idealConversions: events.filter(event => event.type === 'run-order-ideal').length,
    manufacturing: report?.production?.manufacturing,
    roomEfficiencies: report?.rooms.filter(room => room.roomType === 'manufacture' || room.roomType === 'trading').map(room => ({ roomId: room.roomId, averageEfficiencyPercent: room.averageEfficiencyPercent })),
    temporaryRunnerHours, specialRunnerIds: [...specialRunnerIds], specialOccupancySamples, fiammettaEvents: report?.events.filter(event => event.type === 'fiammetta').length,
    nearbyRosterEvents: report?.events.filter(event => event.time >= 1.16 && event.time <= 1.20),
    ...(trace ? { room21Transitions, fiammettaTimeline: report?.events.filter(event => event.type === 'fiammetta').map(event => ({ time: event.time, operators: event.operators })), backupTimeline: report?.events.filter(event => event.type === 'backup-plan').map(event => ({ time: event.time, name: event.backupName, index: event.backupIndex, active: event.active, timing: event.timing })) } : {}),
    diagnostics: report?.diagnostics.filter(d => /FAILED|STALLED|LIMIT|UNAVAILABLE|UNSUPPORTED/.test(d.code)),
  }))
} finally {
  await server.close()
}
