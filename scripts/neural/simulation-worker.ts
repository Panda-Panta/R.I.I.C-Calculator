import { readFileSync } from 'node:fs';
import { simulateCandidate, type CandidateSimulationJob } from '../../src/optimizer/candidateSimulation';
import { qualifiedScore } from '../../src/optimizer/neural/experiment';
const job: CandidateSimulationJob = JSON.parse(readFileSync(0, 'utf8'));
try {
    const result = simulateCandidate(job);
    process.stdout.write(JSON.stringify({
        completed: result.completed, score: qualifiedScore(result), diagnostics: result.diagnostics, calculationReport: result.calculationReport
    }));
}
catch (error) {
    process.stdout.write(JSON.stringify({
        completed: false, score: null, diagnostics: [String(error)]
    }));
}
