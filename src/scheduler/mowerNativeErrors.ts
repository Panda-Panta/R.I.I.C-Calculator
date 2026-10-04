/** Native Python exception categories used by the pinned infra_main/BaseSolver.run boundaries. */
export class MowerExitError extends Error {}
export class MowerRecognizeError extends Error {override name='RecognizeError'}
export class MowerConnectionError extends Error {}
export class MowerConnectionAbortedError extends Error {}
export class MowerAttributeError extends Error {}
/** The native preview rejects this task without changing physical positions.
 * A headless run reports it instead of retrying the same state every microsecond. */
export class MowerShiftPreviewError extends Error {override name='MowerShiftPreviewError'}
/** Native alpha keeps the current task and retries its remaining rooms later. */
export class MowerRoomArrangementDeferred extends Error {
 override name='RoomArrangementDeferred'
 constructor(readonly room:string,readonly cause:unknown){super(cause instanceof Error?cause.message:String(cause))}
}
export function rethrowMowerInfraFatal(error:unknown):void {
 if(error instanceof MowerExitError||
  error instanceof Error&&[MowerConnectionError,MowerConnectionAbortedError,MowerAttributeError].some(type=>error.constructor===type))throw error
}
