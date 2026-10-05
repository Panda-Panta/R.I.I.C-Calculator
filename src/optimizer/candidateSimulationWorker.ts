import { simulateCandidateWithProgress, type CandidateSimulationJob } from './candidateSimulation'

self.onmessage = (event: MessageEvent<CandidateSimulationJob>) => {
  // An unexpected failure must reject the batch, never masquerade as a zero score.
  self.postMessage(simulateCandidateWithProgress(event.data, progress => self.postMessage({ type: 'progress', progress })))
}
