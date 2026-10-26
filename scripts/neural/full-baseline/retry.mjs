/** Retry only a confirmed closed attempt; never mutate the original or infer liveness. */
export function retryBudget(previous, { defaultTimeoutMs, retryTimeoutMs, reason, resume }) {
  if (retryTimeoutMs !== undefined && (!resume || !reason)) throw Error('Retry timeout override requires --resume and diagnosed --retry-reason');
  if (retryTimeoutMs !== undefined && (!Number.isSafeInteger(retryTimeoutMs) || retryTimeoutMs < 100)) throw Error('Invalid retry timeout');
  if (!previous) return defaultTimeoutMs; // Pending first attempts keep original manifest budget.
  if (previous.status === 'running' || !previous.endedUtc) throw Error('Cannot retry running or uncertain process; establish termination first');
  if (previous.status === 'completed') throw Error('Cannot retry completed teacher');
  if (!['EXTERNAL_PROCESS_TIMEOUT','CANCELLED','CHILD_PROCESS_FAILED','unqualified'].includes(previous.status)) throw Error('Unknown attempt status is not retryable');
  if (!reason) throw Error('Retry requires diagnosed reason');
  return retryTimeoutMs ?? defaultTimeoutMs;
}
