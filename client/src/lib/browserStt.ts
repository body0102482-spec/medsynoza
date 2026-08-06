import { IS_MOBILE, maxRecordDurationMs } from './mobileAudio';
import {
  acquireMicrophoneStream,
  appendFinalTranscriptFromEvent,
  buildSessionTranscript,
  collapseSttRepetition,
  claimSpeechRecognition,
  longestTranscriptFromEvent,
  getSpeechRecognitionCtor,
  isIgnorableSpeechError,
  markRecognitionEnded,
  releaseMicrophoneStream,
  releaseSpeechRecognition,
  waitForRecognitionCooldown,
  waitForSpeechRecognition,
} from './speechRecognition';
import {
  fixArabicSpeechTranscript,
  looksLikeSttHallucination,
  shouldForceArabicTranscription,
  transcriptionNeedsArabicFix,
} from './arabicSttFix';

const IS_IOS = typeof navigator !== 'undefined' && /iPhone|iPad|iPod/i.test(navigator.userAgent);
/** End-of-utterance silence before auto-submit (voice note + live call browser STT). */
const LIVE_CALL_SILENCE_MS = IS_MOBILE ? 2200 : 1800;
const LIVE_CALL_MIN_SPEECH_MS = IS_MOBILE ? 400 : 320;

export function isBrowserSttSupported(): boolean {
  return !!getSpeechRecognitionCtor();
}

// Chrome's Web Speech API depends on Google's speech servers; when they are
// unreachable (firewall/region issues) recognition fails with 'network'.
// After such a runtime failure we permanently switch this tab to the
// MediaRecorder + server transcription path.
let browserSttRuntimeFailed = false;

export function markBrowserSttRuntimeFailure(): void {
  browserSttRuntimeFailed = true;
}

/** Device/browser STT (Web Speech API) — no OpenAI transcription. */
export function shouldUseBrowserStt(): boolean {
  return isBrowserSttSupported() && !browserSttRuntimeFailed;
}

export function resolveBrowserSttLang(lang: string, sessionLang: string): string {
  if (shouldForceArabicTranscription(sessionLang)) return 'ar-EG';
  if (sessionLang === 'EN') return 'en-US';
  if (sessionLang === 'AR') return 'ar-EG';
  // AUTO: follow the stage-aware lang from the UI (patient → AR, examiner → EN).
  if (lang.toLowerCase().startsWith('en')) return 'en-US';
  if (lang.toLowerCase().startsWith('ar')) return 'ar-EG';
  return 'en-US';
}

export interface BrowserSttSession {
  stop: () => void;
  abort: () => void;
}

export interface StartBrowserSttOptions {
  lang: string;
  sessionLang?: string;
  liveCall?: boolean;
  manualStop?: boolean;
  maxDurationMs?: number;
  onInterim?: (text: string) => void;
  onResult: (text: string) => void;
  onError: (code: string) => void;
}

function validateTranscript(raw: string, expectArabic: boolean, codeSwitch = false): string | null {
  const collapsed = collapseSttRepetition(raw.trim());
  const text = fixArabicSpeechTranscript(collapsed, expectArabic, codeSwitch);
  if (!text || text.length < 2 || looksLikeSttHallucination(text, !expectArabic)) return null;
  if (looksLikeSttRepetitionLoop(text)) return null;
  if (!expectArabic) return text;
  if (/[\u0600-\u06FF]/.test(text)) return text;
  if (transcriptionNeedsArabicFix(text, true)) return null;
  return text;
}

function restartDelayMs(): number {
  if (IS_IOS) return 500;
  if (IS_MOBILE) return 350;
  return 120;
}

function looksLikeSttRepetitionLoop(text: string): boolean {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 10) return false;
  const unique = new Set(words);
  return unique.size <= 3;
}

/**
 * Web Speech API — audio stays on device; only text goes to chat AI.
 * On mobile: do NOT open getUserMedia before recognition (blocks mic on Android).
 */
export async function startBrowserStt(
  options: StartBrowserSttOptions,
): Promise<BrowserSttSession | null> {
  const Ctor = getSpeechRecognitionCtor();
  if (!Ctor) {
    options.onError('not-supported');
    return null;
  }

  await waitForRecognitionCooldown();

  if (IS_MOBILE) {
    releaseMicrophoneStream();
    await waitForSpeechRecognition(IS_IOS ? 200 : 150);
  } else {
    const mic = await acquireMicrophoneStream();
    if (mic !== 'granted') {
      options.onError(mic === 'denied' ? 'not-allowed' : 'not-supported');
      return null;
    }
  }

  const recognition = new Ctor();
  claimSpeechRecognition(recognition);
  recognition.lang = resolveBrowserSttLang(options.lang, options.sessionLang || 'AR');
  recognition.interimResults = true;

  const isLiveCall = !!options.liveCall;
  const manualStop = !isLiveCall && options.manualStop !== false;

  // Mobile: single-utterance cycles (same as live call) — continuous=true causes phrase loops on Android/iOS.
  recognition.continuous = IS_MOBILE ? false : true;

  const expectArabic = shouldForceArabicTranscription(options.sessionLang || 'AR');
  const codeSwitch = (options.sessionLang || 'AR') === 'AUTO';
  const defaultLiveMax = IS_MOBILE ? 20_000 : 15_000;
  const maxMs = options.maxDurationMs ?? (isLiveCall ? defaultLiveMax : maxRecordDurationMs());
  const startedAt = Date.now();

  let delivered = false;
  let userRequestedStop = false;
  let committedFinal = '';
  let latestTranscript = '';
  let maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;
  let firstSpeechAt = 0;
  let lastSpeechAt = 0;

  const cleanupTimers = () => {
    if (maxDurationTimer) {
      clearTimeout(maxDurationTimer);
      maxDurationTimer = null;
    }
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
  };

  const scheduleSilenceStop = () => {
    if (!isLiveCall || delivered) return;
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      silenceTimer = null;
      if (delivered || !latestTranscript.trim()) return;
      const speechMs = firstSpeechAt ? Date.now() - firstSpeechAt : 0;
      if (speechMs < LIVE_CALL_MIN_SPEECH_MS) return;
      if (Date.now() - lastSpeechAt < LIVE_CALL_SILENCE_MS - 40) return;
      try {
        recognition.stop();
      } catch {
        finish('result', latestTranscript);
      }
    }, LIVE_CALL_SILENCE_MS);
  };

  const finish = (code: 'result' | 'error', payload?: string) => {
    if (delivered) return;
    delivered = true;
    cleanupTimers();
    markRecognitionEnded();
    releaseSpeechRecognition(recognition);

    if (code === 'error') {
      options.onError(payload || 'start-failed');
      return;
    }

    const cleaned = collapseSttRepetition((payload || '').trim());
    const valid = validateTranscript(cleaned, expectArabic, codeSwitch);
    if (!valid) {
      options.onError('no-speech');
      return;
    }
    options.onResult(valid);
  };

  const withinTimeLimit = () => Date.now() - startedAt < maxMs - 200;

  const shouldKeepListening = () => !delivered && !userRequestedStop && withinTimeLimit();

  const tryRestart = () => {
    if (!shouldKeepListening()) {
      if (latestTranscript.trim()) finish('result', latestTranscript);
      else finish('error', 'no-speech');
      return;
    }
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (!shouldKeepListening()) return;
      try {
        recognition.start();
      } catch {
        finish(latestTranscript.trim() ? 'result' : 'error', latestTranscript.trim() || 'no-speech');
      }
    }, restartDelayMs());
  };

  recognition.onresult = (event) => {
    if (IS_MOBILE) {
      const longest = longestTranscriptFromEvent(event);
      latestTranscript = collapseSttRepetition(
        manualStop && committedFinal
          ? buildSessionTranscript(committedFinal, longest)
          : longest,
      );
      if (event.resultIndex < event.results.length) {
        committedFinal = appendFinalTranscriptFromEvent(committedFinal, event);
      }
    } else {
      latestTranscript = buildSessionTranscript(committedFinal, event);
      committedFinal = appendFinalTranscriptFromEvent(committedFinal, event);
    }
    if (latestTranscript.trim()) {
      const now = Date.now();
      if (!firstSpeechAt) firstSpeechAt = now;
      lastSpeechAt = now;
      if (isLiveCall) scheduleSilenceStop();
    }
    if (latestTranscript) options.onInterim?.(latestTranscript);
  };

  recognition.onerror = (event) => {
    if (delivered) return;

    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      finish('error', 'not-allowed');
      return;
    }

    if (latestTranscript.trim() && (event.error === 'network' || event.error === 'audio-capture')) {
      finish('result', latestTranscript);
      return;
    }

    if (event.error === 'network') {
      // Speech service unreachable — don't loop restarts; let the caller
      // fall back to recorder + server transcription.
      markBrowserSttRuntimeFailure();
      finish('error', 'network');
      return;
    }

    if (isIgnorableSpeechError(event.error)) {
      if (manualStop && shouldKeepListening()) {
        tryRestart();
        return;
      }
      if (latestTranscript.trim()) {
        finish('result', latestTranscript);
        return;
      }
      finish('error', 'no-speech');
      return;
    }

    if (shouldKeepListening() && manualStop) {
      tryRestart();
      return;
    }

    if (latestTranscript.trim()) finish('result', latestTranscript);
    else finish('error', 'start-failed');
  };

  recognition.onend = () => {
    if (delivered) return;

    if (userRequestedStop || !withinTimeLimit()) {
      if (latestTranscript.trim()) finish('result', latestTranscript);
      else finish('error', 'no-speech');
      return;
    }

    // Mobile live / single-shot: pause ended → send what we heard.
    if (isLiveCall || (IS_MOBILE && !manualStop)) {
      if (latestTranscript.trim()) finish('result', latestTranscript);
      else if (shouldKeepListening()) tryRestart();
      else finish('error', 'no-speech');
      return;
    }

    // Long record: keep session alive until user taps stop.
    if (manualStop && shouldKeepListening()) {
      tryRestart();
      return;
    }

    if (latestTranscript.trim()) finish('result', latestTranscript);
    else finish('error', 'no-speech');
  };

  maxDurationTimer = setTimeout(() => {
    if (delivered) return;
    userRequestedStop = true;
    try {
      recognition.stop();
    } catch {
      finish(latestTranscript.trim() ? 'result' : 'error', latestTranscript.trim() || 'no-speech');
    }
  }, maxMs);

  try {
    recognition.start();
  } catch {
    cleanupTimers();
    markRecognitionEnded();
    releaseSpeechRecognition(recognition);
    options.onError('start-failed');
    return null;
  }

  return {
    stop: () => {
      userRequestedStop = true;
      try {
        recognition.stop();
      } catch {
        // ignore
      }
    },
    abort: () => {
      userRequestedStop = true;
      cleanupTimers();
      try {
        recognition.abort();
      } catch {
        // ignore
      }
    },
  };
}
