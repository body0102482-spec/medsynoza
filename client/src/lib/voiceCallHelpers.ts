/**
 * Lightweight helpers for chat scroll / voice timeout classification.
 * Verified via TypeScript build (client has no test runner).
 */

/** Distance from bottom considered "stuck to bottom" for auto-scroll. */
export const CHAT_NEAR_BOTTOM_PX = 120;

export function shouldAutoScrollChat(distanceFromBottom: number, forceScroll: boolean): boolean {
  return forceScroll || distanceFromBottom <= CHAT_NEAR_BOTTOM_PX;
}

export type ClassifiedTurnError = {
  code: string;
  fatal: boolean;
  softRetry: boolean;
};

export function classifyVoiceTurnError(err: {
  message?: string;
  status?: number;
}): ClassifiedTurnError {
  const code = err.message ?? '';
  const status = err.status;
  if (status === 503) {
    return { code: 'transcription-unavailable', fatal: false, softRetry: true };
  }
  if (code === 'turn-timeout' || code === 'transcription-timeout') {
    return { code: 'network', fatal: false, softRetry: true };
  }
  if (status === 422 || status === 400 || code === 'transcription-invalid') {
    return { code: 'unclear-audio', fatal: false, softRetry: true };
  }
  if (status !== undefined || code) {
    return { code: 'transcription-failed', fatal: false, softRetry: false };
  }
  return { code: 'network', fatal: false, softRetry: true };
}
