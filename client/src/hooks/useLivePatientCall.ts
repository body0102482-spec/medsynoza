import { useCallback, useEffect, useRef, useState } from 'react';
import { markBrowserSttRuntimeFailure, shouldUseBrowserStt, startBrowserStt, type BrowserSttSession } from '../lib/browserStt';
import { primeSpeechOutput, speakText, stopSpeaking } from '../lib/speech';
import { abortActiveSpeechRecognition, releaseMicrophoneStream, waitForSpeechRecognition } from '../lib/speechRecognition';
import {
  getMicConstraints,
  IS_MOBILE,
  minLiveCallBlobBytes,
  recorderTimesliceMs,
  unlockMobileAudio,
} from '../lib/mobileAudio';
import {
  isAudioRecordingSupported,
  pickAudioMimeType,
  transcribeAudioBlob,
} from '../lib/transcribe';
import {
  postTextTurn,
  postVoiceTurn,
  TEXT_TURN_TIMEOUT_MS,
  VOICE_TURN_TIMEOUT_MS,
  type VoiceTurnMeta,
  type VoiceTurnResponse,
} from '../lib/voiceTurn';
import { withTimeout } from '../lib/withTimeout';

interface UseLiveVoiceCallOptions {
  listenLang: string;
  speakLang: string;
  sessionLang?: string;
  sendMessage: (text: string) => Promise<{ success: boolean; reply?: string }>;
  voiceTurn?: {
    sessionId: string;
    getRequestMeta: () => VoiceTurnMeta;
    onTurn?: (result: VoiceTurnResponse) => void;
  };
  /** When false, patient/examiner replies appear in chat only (no TTS). */
  speakReplies?: boolean;
  disabled?: boolean;
  onError?: (code: string) => void;
}

/** @deprecated Use useLiveVoiceCall — kept for imports */
export type UseLivePatientCallOptions = UseLiveVoiceCallOptions;

/** Pause before auto-submit — long enough for natural breaths (~1s) without cutting speech. */
const SILENCE_MS = IS_MOBILE ? 2200 : 1800;
const MIN_SPEECH_MS = IS_MOBILE ? 350 : 380;
const MAX_RECORDING_MS = IS_MOBILE ? 9000 : 12000;
const NO_SPEECH_TIMEOUT_MS = IS_MOBILE ? 7000 : 6000;
/** Absolute silence floor (~-54 dBFS). Real speech almost always exceeds this. */
const SPEECH_RMS_THRESHOLD = 0.002;
/**
 * Speech must exceed the running background-noise estimate by this factor.
 * Steady fan/HVAC/hiss never crosses it no matter how loud, so a silent
 * student cannot start a turn — but quiet speech in a quiet room can.
 */
const NOISE_MULTIPLIER = 2;
/** Ignore brief noise spikes — speech must stay above the gate for ~4 analyser frames (~85ms). */
const MIN_SPEECH_FRAMES = 4;
/** Give the noise-floor estimate time to settle before it gates speech. */
const NOISE_WARMUP_MS = 400;
const POST_TURN_LISTEN_DELAY_MS = IS_MOBILE ? 450 : 80;
const BROWSER_STT_RESTART_DELAY_MS = IS_MOBILE ? 350 : 80;
/** Client patience for text turns (browser STT path). */
const TEXT_TURN_CLIENT_MS = TEXT_TURN_TIMEOUT_MS;
/** Client patience for audio turns (recorder + Whisper). */
const VOICE_TURN_CLIENT_MS = VOICE_TURN_TIMEOUT_MS;
const BUSY_WATCHDOG_MS = VOICE_TURN_CLIENT_MS + 8_000;
const MAX_SOFT_RETRIES = 3;

function rmsFromAnalyser(analyser: AnalyserNode, buffer: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(buffer);
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) {
    sum += buffer[i] * buffer[i];
  }
  return Math.sqrt(sum / buffer.length);
}

function setStreamMuted(stream: MediaStream | null, muted: boolean) {
  stream?.getAudioTracks().forEach((track) => {
    track.enabled = !muted;
  });
}

function classifyTurnError(err: unknown): {
  code: string;
  status?: number;
  fatal: boolean;
  softRetry: boolean;
} {
  const code = err instanceof Error ? err.message : '';
  const response = (err as {
    response?: { status?: number; data?: { code?: string; error?: string } };
  })?.response;
  const status = response?.status;
  const serverCode = response?.data?.code;
  if (
    serverCode === 'transcription-auth-failed' ||
    serverCode === 'transcription-quota-exceeded'
  ) {
    return { code: serverCode, status, fatal: true, softRetry: false };
  }
  if (status === 503) {
    return { code: 'transcription-unavailable', status, fatal: true, softRetry: false };
  }
  if (code === 'turn-timeout' || code === 'transcription-timeout') {
    return { code: 'network', status, fatal: false, softRetry: true };
  }
  if (
    status === 422 ||
    status === 400 ||
    code === 'transcription-invalid' ||
    serverCode === 'recording-too-short' ||
    serverCode === 'transcription-not-arabic' ||
    code === 'recording-too-short'
  ) {
    return { code: 'unclear-audio', status, fatal: false, softRetry: true };
  }
  if (status !== undefined || code) {
    return { code: 'transcription-failed', status, fatal: false, softRetry: true };
  }
  return { code: 'network', fatal: false, softRetry: true };
}

export function useLiveVoiceCall({
  listenLang,
  speakLang,
  sessionLang = 'AR',
  sendMessage,
  voiceTurn,
  speakReplies = false,
  disabled,
  onError,
}: UseLiveVoiceCallOptions) {
  const [isLiveCall, setIsLiveCall] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [isMicListening, setIsMicListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const liveRef = useRef(false);
  const busyRef = useRef(false);
  const speakingRef = useRef(false);
  const listeningRef = useRef(false);
  const busyWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listenOnceRef = useRef<() => void>(() => undefined);
  const sendRef = useRef(sendMessage);
  const voiceTurnRef = useRef(voiceTurn);
  const onErrorRef = useRef(onError);
  const speakRepliesRef = useRef(speakReplies);
  const listenLangRef = useRef(listenLang);
  const speakLangRef = useRef(speakLang);
  const sessionLangRef = useRef(sessionLang);
  const streamRef = useRef<MediaStream | null>(null);
  const browserSttRef = useRef<BrowserSttSession | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const vadFrameRef = useRef<number | null>(null);
  const noSpeechTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxRecordingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speechStartedAtRef = useRef(0);
  const mimeTypeRef = useRef('audio/webm');
  const softRetryCountRef = useRef(0);
  const turnSeqRef = useRef(0);
  const processingTurnRef = useRef(false);
  /** After English browser-STT misses (accent), force recorder+Whisper for this call. */
  const forceServerSttRef = useRef(false);
  const enMissCountRef = useRef(0);

  sendRef.current = sendMessage;
  voiceTurnRef.current = voiceTurn;
  onErrorRef.current = onError;
  speakRepliesRef.current = speakReplies;
  listenLangRef.current = listenLang;
  speakLangRef.current = speakLang;
  sessionLangRef.current = sessionLang;

  const setListening = useCallback((active: boolean) => {
    listeningRef.current = active;
    setIsMicListening(active);
  }, []);

  const setSpeaking = useCallback((active: boolean) => {
    speakingRef.current = active;
    setIsSpeaking(active);
  }, []);

  const isSupported =
    typeof window !== 'undefined' && (shouldUseBrowserStt() || isAudioRecordingSupported());

  const clearTimers = useCallback(() => {
    if (vadFrameRef.current !== null) {
      cancelAnimationFrame(vadFrameRef.current);
      vadFrameRef.current = null;
    }
    if (noSpeechTimerRef.current) {
      clearTimeout(noSpeechTimerRef.current);
      noSpeechTimerRef.current = null;
    }
    if (maxRecordingTimerRef.current) {
      clearTimeout(maxRecordingTimerRef.current);
      maxRecordingTimerRef.current = null;
    }
  }, []);

  const clearBusyWatchdog = useCallback(() => {
    if (busyWatchdogRef.current) {
      clearTimeout(busyWatchdogRef.current);
      busyWatchdogRef.current = null;
    }
  }, []);

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const closeAudioContext = useCallback(() => {
    const ctx = audioContextRef.current;
    audioContextRef.current = null;
    if (ctx && ctx.state !== 'closed') {
      void ctx.close().catch(() => undefined);
    }
  }, []);

  const stopRecorder = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        recorderRef.current = null;
      }
      return;
    }
    recorderRef.current = null;
  }, []);

  const scheduleListen = useCallback((delayMs = POST_TURN_LISTEN_DELAY_MS) => {
    if (!liveRef.current || busyRef.current || speakingRef.current || listeningRef.current) return;
    setTimeout(() => {
      if (liveRef.current && !busyRef.current && !speakingRef.current && !listeningRef.current) {
        void listenOnceRef.current();
      }
    }, delayMs);
  }, []);

  const endBusy = useCallback(() => {
    busyRef.current = false;
    processingTurnRef.current = false;
    setIsBusy(false);
    clearBusyWatchdog();
    setStreamMuted(streamRef.current, false);
    scheduleListen();
  }, [clearBusyWatchdog, scheduleListen]);

  const startBusy = useCallback(() => {
    busyRef.current = true;
    setIsBusy(true);
    clearBusyWatchdog();
    busyWatchdogRef.current = setTimeout(() => {
      if (!busyRef.current || !liveRef.current) return;
      // Clear a stuck busy state so listening can resume even if a late turn is mid-flight.
      processingTurnRef.current = false;
      busyRef.current = false;
      setIsBusy(false);
      onErrorRef.current?.('network');
      scheduleListen(200);
    }, BUSY_WATCHDOG_MS);
  }, [clearBusyWatchdog, scheduleListen]);

  const ensureStream = useCallback(async (): Promise<MediaStream | null> => {
    if (streamRef.current?.active) return streamRef.current;

    releaseMicrophoneStream(false);

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: getMicConstraints(),
    });
    streamRef.current = stream;
    return stream;
  }, []);

  const playReply = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !liveRef.current) return;

      if (!speakRepliesRef.current) {
        return;
      }

      const speak = speakLangRef.current.startsWith('ar') ? 'ar-EG' : speakLangRef.current;
      speakingRef.current = true;
      setSpeaking(true);
      // Mute mic during TTS to prevent echo / re-triggering STT.
      setStreamMuted(streamRef.current, true);
      abortActiveSpeechRecognition();
      try {
        const result = await speakText(trimmed, speak);
        if (!result.ok) {
          onErrorRef.current?.('tts-failed');
        }
      } catch {
        onErrorRef.current?.('tts-failed');
      } finally {
        speakingRef.current = false;
        setSpeaking(false);
        setStreamMuted(streamRef.current, false);
      }
    },
    [setSpeaking],
  );

  const stopCall = useCallback(() => {
    liveRef.current = false;
    setIsLiveCall(false);
    busyRef.current = false;
    speakingRef.current = false;
    processingTurnRef.current = false;
    softRetryCountRef.current = 0;
    forceServerSttRef.current = false;
    enMissCountRef.current = 0;
    setIsBusy(false);
    setListening(false);
    setSpeaking(false);
    speechStartedAtRef.current = 0;
    browserSttRef.current?.abort();
    browserSttRef.current = null;
    abortActiveSpeechRecognition();
    releaseMicrophoneStream(true);
    clearTimers();
    clearBusyWatchdog();
    stopRecorder();
    closeAudioContext();
    releaseStream();
    stopSpeaking();
  }, [clearBusyWatchdog, clearTimers, closeAudioContext, releaseStream, setListening, setSpeaking, stopRecorder]);

  const finishRecording = useCallback(() => {
    if (!listeningRef.current) return;
    setListening(false);
    clearTimers();
    const recorder = recorderRef.current;
    if (recorder && recorder.state === 'recording') {
      try {
        recorder.requestData();
      } catch {
        // Some browsers don't support requestData.
      }
      stopRecorder();
      return;
    }
    stopRecorder();
  }, [clearTimers, setListening, stopRecorder]);

  const handleTurnFailure = useCallback(
    (err: unknown) => {
      const classified = classifyTurnError(err);
      if (classified.fatal) {
        onErrorRef.current?.(classified.code);
        stopCall();
        return;
      }
      if (classified.softRetry) {
        softRetryCountRef.current += 1;
        // Unclear audio / accented speech: keep listening silently — never spam
        // "Could not transcribe audio" during a live call.
        if (classified.code === 'unclear-audio') {
          if (softRetryCountRef.current >= MAX_SOFT_RETRIES * 2) {
            softRetryCountRef.current = 0;
          }
          return;
        }
        if (softRetryCountRef.current >= MAX_SOFT_RETRIES) {
          onErrorRef.current?.(classified.code);
          softRetryCountRef.current = 0;
        } else {
          onErrorRef.current?.(classified.code);
        }
        return;
      }
      onErrorRef.current?.(classified.code);
    },
    [stopCall],
  );

  const processTextTurn = useCallback(
    async (transcript: string) => {
      if (processingTurnRef.current) return false;
      processingTurnRef.current = true;
      const turn = voiceTurnRef.current;

      try {
        if (turn) {
          const result = await withTimeout(
            postTextTurn(
              turn.sessionId,
              transcript,
              turn.getRequestMeta(),
              sessionLangRef.current,
              listenLangRef.current,
            ),
            TEXT_TURN_CLIENT_MS,
            'turn-timeout',
          );
          if (!liveRef.current) return false;
          softRetryCountRef.current = 0;
          turn.onTurn?.(result);
          await playReply(result.replyMessage.content);
          return !!result.transcript?.trim();
        }

        if (!transcript?.trim() || !liveRef.current) return false;

        const result = await sendRef.current(transcript);
        if (!liveRef.current) return false;

        if (result.success && result.reply?.trim()) {
          softRetryCountRef.current = 0;
          await playReply(result.reply);
        }

        return true;
      } finally {
        processingTurnRef.current = false;
      }
    },
    [playReply],
  );

  const processTurn = useCallback(
    async (blob: Blob) => {
      if (processingTurnRef.current) return false;
      processingTurnRef.current = true;
      const turn = voiceTurnRef.current;

      try {
        if (turn) {
          const result = await withTimeout(
            postVoiceTurn(
              turn.sessionId,
              blob,
              listenLangRef.current,
              sessionLangRef.current,
              turn.getRequestMeta(),
            ),
            VOICE_TURN_CLIENT_MS,
            'turn-timeout',
          );
          if (!liveRef.current) return false;
          softRetryCountRef.current = 0;
          turn.onTurn?.(result);
          await playReply(result.replyMessage.content);
          return !!result.transcript?.trim();
        }

        const transcript = await withTimeout(
          transcribeAudioBlob(blob, listenLangRef.current, sessionLangRef.current),
          VOICE_TURN_CLIENT_MS,
          'turn-timeout',
        );

        if (!transcript?.trim() || !liveRef.current) return false;

        const result = await sendRef.current(transcript);
        if (!liveRef.current) return false;

        if (result.success && result.reply?.trim()) {
          softRetryCountRef.current = 0;
          await playReply(result.reply);
        }

        return true;
      } finally {
        processingTurnRef.current = false;
      }
    },
    [playReply],
  );

  const listenOnceWithBrowser = useCallback(async () => {
    if (!liveRef.current || disabled || busyRef.current || speakingRef.current || listeningRef.current) {
      return;
    }

    if (IS_MOBILE) {
      await waitForSpeechRecognition(BROWSER_STT_RESTART_DELAY_MS);
    }

    releaseMicrophoneStream(false);
    listeningRef.current = true;
    setIsMicListening(true);

    const session = await startBrowserStt({
      lang: listenLangRef.current,
      sessionLang: sessionLangRef.current,
      liveCall: true,
      onResult: (transcript) => {
        browserSttRef.current = null;
        setListening(false);
        if (!liveRef.current) return;

        startBusy();
        void (async () => {
          try {
            await processTextTurn(transcript);
          } catch (err) {
            handleTurnFailure(err);
          } finally {
            endBusy();
          }
        })();
      },
      onError: (code) => {
        browserSttRef.current = null;
        setListening(false);
        if (!liveRef.current) return;

        if (code === 'no-speech' || code === 'transcription-invalid') {
          // Accented English often yields browser no-speech — switch to Whisper capture.
          if (sessionLangRef.current === 'EN') {
            enMissCountRef.current += 1;
            if (enMissCountRef.current >= 1) {
              forceServerSttRef.current = true;
              scheduleListen(120);
              return;
            }
          }
          scheduleListen(IS_MOBILE ? 400 : 150);
          return;
        }
        if (code === 'not-allowed') {
          onErrorRef.current?.('not-allowed');
          stopCall();
          return;
        }
        if (code === 'not-supported') {
          onErrorRef.current?.('not-supported');
          stopCall();
          return;
        }
        if ((code === 'network' || code === 'start-failed') && isAudioRecordingSupported()) {
          markBrowserSttRuntimeFailure();
          // Recorder + server STT is an automatic fallback. Do not show a stale
          // browser-network error while that fallback is available.
          scheduleListen(150);
          return;
        }
        scheduleListen(IS_MOBILE ? 700 : 300);
      },
    });

    if (!session) {
      setListening(false);
      if (liveRef.current) scheduleListen(300);
      return;
    }

    browserSttRef.current = session;
  }, [disabled, endBusy, handleTurnFailure, processTextTurn, scheduleListen, setListening, startBusy, stopCall]);

  const listenOnce = useCallback(async () => {
    // Prefer browser STT (works for Arabic on Android). Force server Whisper when:
    // - browser STT unavailable, or
    // - English browser STT already missed once (accent / en-US mismatch).
    const useBrowser =
      shouldUseBrowserStt() &&
      !forceServerSttRef.current &&
      sessionLangRef.current !== 'EN';

    // For English: try browser once, then Whisper. First EN attempt can try browser
    // if we haven't forced server yet — but on Android Chrome, en-US browser STT is
    // weak for non-native accents, so default EN live calls straight to Whisper.
    const preferWhisperForEnglish = sessionLangRef.current === 'EN';

    if (!preferWhisperForEnglish && useBrowser) {
      await listenOnceWithBrowser();
      return;
    }

    if (preferWhisperForEnglish && shouldUseBrowserStt() && !forceServerSttRef.current && !IS_MOBILE) {
      // Desktop EN: browser STT is usually fine.
      await listenOnceWithBrowser();
      return;
    }

    if (!liveRef.current || disabled || busyRef.current || speakingRef.current || listeningRef.current) {
      return;
    }

    listeningRef.current = true;
    setIsMicListening(true);
    speechStartedAtRef.current = 0;

    try {
      const stream = await ensureStream();
      if (!stream || !liveRef.current) {
        setListening(false);
        return;
      }
      setStreamMuted(stream, false);

      mimeTypeRef.current = pickAudioMimeType() || (IS_MOBILE ? 'audio/mp4' : 'audio/webm');
      const chunks: Blob[] = [];
      const recorder = new MediaRecorder(stream, { mimeType: mimeTypeRef.current });
      recorderRef.current = recorder;

      const startedAt = Date.now();
      let silenceStartedAt = 0;
      let peakRms = 0;
      let speechFrames = 0;
      let noiseFloor = Infinity;
      let speechGate = SPEECH_RMS_THRESHOLD;
      // Give the noise estimate a moment to settle before it can block or allow speech.
      const noiseWarmupUntil = startedAt + NOISE_WARMUP_MS;
      const turnId = ++turnSeqRef.current;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };

      recorder.onerror = () => {
        setListening(false);
        clearTimers();
        recorderRef.current = null;
        onErrorRef.current?.('audio-capture');
        scheduleListen(300);
      };

      recorder.onstop = async () => {
        clearTimers();
        recorderRef.current = null;
        setListening(false);

        // Drop stale stops from a previous listen cycle.
        if (turnId !== turnSeqRef.current) return;

        const elapsed = Date.now() - startedAt;
        const blob = new Blob(chunks, { type: mimeTypeRef.current });

        if (!liveRef.current) return;

        if (
          elapsed < MIN_SPEECH_MS ||
          blob.size < minLiveCallBlobBytes()
        ) {
          scheduleListen(150);
          return;
        }

        // Never send a clip the client VAD did not register as speech — it is
        // silence or background noise. Whisper would otherwise turn that noise into
        // words and the AI would answer "input" the student never said.
        if (speechStartedAtRef.current === 0) {
          scheduleListen(150);
          return;
        }

        startBusy();

        try {
          await processTurn(blob);
        } catch (err) {
          handleTurnFailure(err);
        } finally {
          endBusy();
        }
      };

      const AudioCtx =
        window.AudioContext ||
        (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
        audioContextRef.current = AudioCtx ? new AudioCtx() : null;
      }
      const audioContext = audioContextRef.current;
      if (!audioContext) {
        setListening(false);
        onErrorRef.current?.('audio-capture');
        scheduleListen(300);
        return;
      }
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }

      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const sampleBuffer = new Float32Array(analyser.fftSize) as Float32Array<ArrayBuffer>;

      const monitor = () => {
        if (!listeningRef.current || !liveRef.current) return;

        const rms = rmsFromAnalyser(analyser, sampleBuffer);
        const now = Date.now();

        if (speechStartedAtRef.current) {
          // End-of-utterance: speech ends once volume drops well below the adaptive
          // gate (or far below the utterance peak) for SILENCE_MS.
          const stillTalking =
            rms >= speechGate * 0.85 || (peakRms > 0 && rms >= peakRms * 0.3);
          if (stillTalking) {
            peakRms = Math.max(peakRms, rms);
            silenceStartedAt = 0;
          } else {
            if (!silenceStartedAt) silenceStartedAt = now;
            const speechDuration = now - speechStartedAtRef.current;
            const silenceDuration = now - silenceStartedAt;
            if (speechDuration >= MIN_SPEECH_MS && silenceDuration >= SILENCE_MS) {
              finishRecording();
              return;
            }
          }
        } else {
          // No speech yet — track a running estimate of the background noise so the
          // gate adapts to the room: quiet rooms gate low, noisy rooms gate high.
          if (noiseFloor === Infinity || rms < noiseFloor) noiseFloor = rms;
          else noiseFloor += (rms - noiseFloor) * (now < noiseWarmupUntil ? 0.1 : 0.02);
          speechGate = Math.max(SPEECH_RMS_THRESHOLD, noiseFloor * NOISE_MULTIPLIER);

          if (now >= noiseWarmupUntil && rms >= speechGate) {
            speechFrames += 1;
            // Only treat a sustained run as speech — a single noise spike (keyboard,
            // door, click) must not start an utterance.
            if (speechFrames >= MIN_SPEECH_FRAMES) {
              speechStartedAtRef.current = now;
              peakRms = rms;
              silenceStartedAt = 0;
              if (noSpeechTimerRef.current) {
                clearTimeout(noSpeechTimerRef.current);
                noSpeechTimerRef.current = null;
              }
            }
          } else {
            speechFrames = 0;
          }
        }

        vadFrameRef.current = requestAnimationFrame(monitor);
      };

      noSpeechTimerRef.current = setTimeout(() => {
        if (listeningRef.current && !speechStartedAtRef.current && liveRef.current) {
          finishRecording();
        }
      }, NO_SPEECH_TIMEOUT_MS);

      maxRecordingTimerRef.current = setTimeout(() => {
        // Always force-submit after max duration once speech was detected.
        if (listeningRef.current && speechStartedAtRef.current) {
          finishRecording();
        } else if (listeningRef.current) {
          finishRecording();
        }
      }, MAX_RECORDING_MS);

      // Android MediaRecorder + timeslice often produces corrupt mp4/webm that
      // Whisper rejects ("Could not transcribe"). Prefer a single contiguous blob.
      if (IS_MOBILE) {
        recorder.start();
      } else {
        recorder.start(recorderTimesliceMs());
      }
      vadFrameRef.current = requestAnimationFrame(monitor);
    } catch (err) {
      setListening(false);
      const name = err instanceof DOMException ? err.name : '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        onErrorRef.current?.('not-allowed');
        stopCall();
        return;
      }
      onErrorRef.current?.('start-failed');
      scheduleListen(400);
    }
  }, [
    disabled,
    ensureStream,
    finishRecording,
    clearTimers,
    stopCall,
    processTurn,
    startBusy,
    endBusy,
    scheduleListen,
    setListening,
    listenOnceWithBrowser,
    handleTurnFailure,
  ]);

  listenOnceRef.current = () => {
    void listenOnce();
  };

  const toggleLiveCall = useCallback(() => {
    if (!isSupported) {
      onErrorRef.current?.('not-supported');
      return;
    }
    if (isLiveCall) {
      stopCall();
      return;
    }
    if (speakRepliesRef.current) {
      primeSpeechOutput();
    }
    void unlockMobileAudio();
    softRetryCountRef.current = 0;
    forceServerSttRef.current = sessionLangRef.current === 'EN' && IS_MOBILE;
    enMissCountRef.current = 0;
    liveRef.current = true;
    setIsLiveCall(true);
    void listenOnce();
  }, [isLiveCall, isSupported, listenOnce, stopCall]);

  useEffect(
    () => () => {
      liveRef.current = false;
      clearTimers();
      clearBusyWatchdog();
      browserSttRef.current?.abort();
      browserSttRef.current = null;
      abortActiveSpeechRecognition();
      releaseMicrophoneStream(true);
      stopRecorder();
      closeAudioContext();
      releaseStream();
      stopSpeaking();
    },
    [clearBusyWatchdog, clearTimers, closeAudioContext, releaseStream, stopRecorder],
  );

  return { isLiveCall, isBusy, isMicListening, isSpeaking, isSupported, toggleLiveCall, stopCall };
}

export const useLivePatientCall = useLiveVoiceCall;
