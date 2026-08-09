import OpenAI, { toFile } from 'openai';
import { audioContainsSpeech } from './audioSpeechDetector.js';
import { fixArabicSpeechTranscript, looksLikeSttHallucination, prioritizeWellbeingTranscript, containsWrongScriptForArabic, transcriptionNeedsArabicFix } from './arabicSttFix.js';

function getOpenAIClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error('transcription-unavailable');
  if (/^(your[-_ ]?openai|replace[-_ ]?me|changeme)/i.test(apiKey)) {
    throw new Error('transcription-auth-failed');
  }
  return new OpenAI({ apiKey });
}

const ENGLISH_WHISPER_PROMPT =
  'OSCE medical interview. Non-native English speaker. Hello doctor. What is your name? How old are you? What brings you here today? Where is the pain?';
const ARABIC_WHISPER_PROMPT = 'دكتور مريض عامية مصرية OSCE';

const PROMPT_HALLUCINATION_PHRASES = [
  'السلام عليكم دكتور',
  'اسمك إيه',
  'عندك كام سنة',
  'إزيك',
  'إيه اللي جابك',
  'متجوز',
  'مصري',
];

export function looksLikePromptHallucination(text: string): boolean {
  const normalized = text.replace(/[؟?،,.]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;

  let hits = 0;
  for (const phrase of PROMPT_HALLUCINATION_PHRASES) {
    if (normalized.includes(phrase)) hits++;
  }
  return hits >= 3;
}

/** When STT returns multiple questions, keep the last one the student actually asked. */
export function extractPrimaryUtterance(text: string, allowLatinOnly = false): string {
  const trimmed = text.trim();
  if (
    !trimmed ||
    looksLikePromptHallucination(trimmed) ||
    looksLikeSttHallucination(trimmed, allowLatinOnly)
  ) {
    throw new Error('transcription-prompt-leak');
  }

  const segments = trimmed
    .split(/[؟?]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1 && !looksLikeSttHallucination(s, allowLatinOnly));

  if (!segments.length) {
    // Keep the full utterance for accented / imperfect English rather than failing the turn.
    if (allowLatinOnly && /[a-zA-Z]/.test(trimmed) && trimmed.length >= 2) {
      return trimmed;
    }
    throw new Error('transcription-prompt-leak');
  }

  if (segments.length === 1) return segments[0];

  const last = segments[segments.length - 1];
  return last.endsWith('؟') || last.endsWith('?') ? last : `${last}?`;
}

export function resolveWhisperLanguage(
  language: string,
  forceArabic?: boolean,
): 'ar' | 'en' | 'auto' {
  if (forceArabic) return 'ar';
  const code = language.toLowerCase().trim();
  if (code === 'auto' || code === 'auto-detect') return 'auto';
  if (code.startsWith('ar')) return 'ar';
  if (code.startsWith('en')) return 'en';
  // Unknown / empty → let Whisper auto-detect (better for code-switching).
  return 'auto';
}

function transcriptionLooksWrong(text: string, expected: 'ar' | 'en' | 'auto'): boolean {
  if (expected === 'auto') return false;
  const arabic = (text.match(/[\u0600-\u06FF]/g) || []).length;
  const latin = (text.match(/[a-zA-Z]/g) || []).length;
  if (expected === 'ar') return latin >= 4 && arabic === 0;
  return arabic >= 6 && latin === 0;
}

function needsWhisperArabicFallback(text: string, lang: 'ar' | 'en' | 'auto'): boolean {
  if (lang === 'auto') return false;
  if (lang !== 'ar') return transcriptionLooksWrong(text, lang);
  if (containsWrongScriptForArabic(text)) return true;
  const fixed = fixArabicSpeechTranscript(text, true);
  return transcriptionLooksWrong(text, lang) || transcriptionNeedsArabicFix(fixed, true);
}

function resolvePrimaryModel(): string {
  return process.env.OPENAI_WHISPER_MODEL || 'gpt-4o-transcribe';
}

async function runWhisper(
  client: OpenAI,
  buffer: Buffer,
  mimeType: string,
  whisperLang: 'ar' | 'en' | 'auto',
  model: string,
  usePrompt: boolean,
): Promise<string> {
  const ext = mimeType.includes('mp4')
    ? 'm4a'
    : mimeType.includes('ogg')
      ? 'ogg'
      : mimeType.includes('wav')
        ? 'wav'
        : 'webm';

  const file = await toFile(buffer, `recording.${ext}`, { type: mimeType });
  const isRealtimeTranscribe = /transcribe/i.test(model);
  const canUsePrompt = usePrompt && !isRealtimeTranscribe && model === 'whisper-1' && whisperLang !== 'auto';

  const result = await client.audio.transcriptions.create({
    file,
    model,
    // Omit language for AUTO so Whisper can keep mixed Arabic/English.
    ...(whisperLang === 'auto' ? {} : { language: whisperLang }),
    ...(canUsePrompt
      ? { prompt: whisperLang === 'ar' ? ARABIC_WHISPER_PROMPT : ENGLISH_WHISPER_PROMPT }
      : {}),
    temperature: 0,
  });

  return result.text.trim();
}

function finalizeTranscript(
  text: string,
  expectArabic: boolean,
  options?: { fast?: boolean },
): string {
  const raw = text.trim().replace(/\s+/g, ' ');
  let normalized = fixArabicSpeechTranscript(raw, expectArabic);

  if (containsWrongScriptForArabic(normalized)) {
    throw new Error('transcription-prompt-leak');
  }

  // English / AUTO: keep accented imperfect speech — never drop a usable Latin utterance.
  if (!expectArabic) {
    if (options?.fast) {
      normalized = prioritizeWellbeingTranscript(normalized);
    }
    try {
      return extractPrimaryUtterance(normalized, true);
    } catch {
      if (/[a-zA-Z\u0600-\u06FF]/.test(normalized) && normalized.length >= 2) {
        return normalized;
      }
      throw new Error('transcription-prompt-leak');
    }
  }

  if (looksLikeSttHallucination(normalized, false)) {
    throw new Error('transcription-prompt-leak');
  }
  if (options?.fast) {
    normalized = prioritizeWellbeingTranscript(normalized);
  }
  normalized = extractPrimaryUtterance(normalized, false);

  if (transcriptionNeedsArabicFix(normalized, true)) {
    throw new Error('transcription-not-arabic');
  }

  return normalized;
}

async function transcribeWithOpenAI(
  buffer: Buffer,
  mimeType: string,
  language: string,
  forceArabic: boolean | undefined,
  options?: { fast?: boolean },
): Promise<string> {
  const client = getOpenAIClient();
  const provider = (process.env.AI_PROVIDER || 'openai').toLowerCase();

  if (provider === 'mock') {
    throw new Error('transcription-unavailable');
  }

  const whisperLang = resolveWhisperLanguage(language, forceArabic);
  const expectArabic = whisperLang === 'ar';
  const primaryModel = resolvePrimaryModel();
  const fallbackModel = 'whisper-1';

  async function attempt(
    lang: 'ar' | 'en' | 'auto',
    model: string,
    usePrompt: boolean,
  ): Promise<string> {
    try {
      return await runWhisper(client, buffer, mimeType, lang, model, usePrompt);
    } catch (err) {
      const status = (err as { status?: number })?.status;
      console.warn('[stt] whisper failed model=%s lang=%s status=%s', model, lang, status ?? 'n/a');
      throw err;
    }
  }

  let text = '';
  try {
    text = await attempt(whisperLang, primaryModel, false);
  } catch {
    // gpt-4o-transcribe often fails on Android MediaRecorder mp4/webm fragments — fall back.
    text = await attempt(whisperLang === 'auto' ? 'auto' : whisperLang, fallbackModel, true);
  }

  // Non-native / accented English: retry with auto-detect / whisper-1 when EN looks weak.
  if (whisperLang === 'en') {
    const arabicChars = (text.match(/[\u0600-\u06FF]/g) || []).length;
    const latinChars = (text.match(/[a-zA-Z]/g) || []).length;
    const weakEnglish =
      !text ||
      text.length < 2 ||
      (arabicChars >= 3 && latinChars === 0) ||
      looksLikePromptHallucination(text);
    if (weakEnglish) {
      for (const [lang, model, prompt] of [
        ['auto', primaryModel, false],
        ['en', fallbackModel, true],
        ['auto', fallbackModel, true],
      ] as const) {
        try {
          const retry = await attempt(lang, model, prompt);
          const retryLatin = (retry.match(/[a-zA-Z]/g) || []).length;
          if (retry && retry.length >= 2 && retryLatin >= latinChars) {
            text = retry;
            if (retryLatin > 0) break;
          }
        } catch {
          // try next
        }
      }
    }
  }

  if (looksLikePromptHallucination(text)) {
    if (options?.fast && expectArabic) {
      throw new Error('transcription-prompt-leak');
    }
    try {
      text = await attempt(whisperLang, fallbackModel, true);
    } catch {
      // keep previous
    }
    if (looksLikePromptHallucination(text) && expectArabic) {
      throw new Error('transcription-prompt-leak');
    }
  }

  if (needsWhisperArabicFallback(text, whisperLang)) {
    try {
      text = await attempt(whisperLang, fallbackModel, true);
    } catch {
      // Keep primary result if whisper retry fails.
    }
  }

  if (transcriptionNeedsArabicFix(text, expectArabic)) {
    if (primaryModel !== fallbackModel) {
      try {
        const whisperText = await attempt(whisperLang, fallbackModel, true);
        return finalizeTranscript(whisperText, expectArabic, options);
      } catch {
        // Fall through.
      }
    }
    throw new Error('transcription-not-arabic');
  }

  // Empty English result → treat as soft unclear audio, not a hard auth/API failure.
  if (!text.trim()) {
    throw new Error('transcription-prompt-leak');
  }

  return finalizeTranscript(text, expectArabic, options);
}

async function transcribeWithOpenAISafe(
  buffer: Buffer,
  mimeType: string,
  language: string,
  forceArabic: boolean | undefined,
  options?: { fast?: boolean },
): Promise<string> {
  try {
    return await transcribeWithOpenAI(buffer, mimeType, language, forceArabic, options);
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (
      message === 'transcription-unavailable' ||
      message === 'transcription-auth-failed' ||
      message === 'transcription-quota-exceeded' ||
      message === 'transcription-prompt-leak' ||
      message === 'transcription-not-arabic' ||
      message === 'recording-too-short'
    ) {
      throw err;
    }

    const openAiError = err as { status?: number; code?: string; message?: string };
    if (openAiError.status === 401 || openAiError.code === 'invalid_api_key') {
      throw new Error('transcription-auth-failed');
    }
    if (openAiError.status === 429) {
      throw new Error('transcription-quota-exceeded');
    }

    // Last-chance: whisper-1 with auto, ignore language forcing tip.
    try {
      console.warn(
        '[stt] primary OpenAI path failed (%s) — last-chance whisper-1/auto',
        message || openAiError.code || openAiError.status || 'unknown',
      );
      const client = getOpenAIClient();
      const raw = await runWhisper(client, buffer, mimeType, 'auto', 'whisper-1', true);
      const expectArabic = resolveWhisperLanguage(language, forceArabic) === 'ar';
      return finalizeTranscript(raw, expectArabic, options);
    } catch (fallbackErr) {
      const fb = fallbackErr instanceof Error ? fallbackErr.message : '';
      if (
        fb === 'transcription-prompt-leak' ||
        fb === 'transcription-not-arabic' ||
        fb === 'recording-too-short'
      ) {
        throw fallbackErr;
      }
      console.error('[stt] OpenAI transcription failed:', err);
      throw new Error('transcription-prompt-leak');
    }
  }
}

/**
 * Reject clips that are silence or steady background noise before spending a
 * Whisper call on them. Whisper hallucinates speech on quiet/noisy input, which
 * previously made the AI answer "random" input while the student was silent.
 * The gate is heuristic and fails open if ffmpeg is unavailable or undecodable.
 */
async function assertAudioHasSpeech(buffer: Buffer, mimeType: string): Promise<void> {
  try {
    const hasSpeech = await audioContainsSpeech(buffer, mimeType);
    if (hasSpeech === false) {
      throw new Error('recording-too-short');
    }
  } catch (err) {
    if (err instanceof Error && err.message === 'recording-too-short') throw err;
    console.warn('[stt] audio speech-gate skipped:', err instanceof Error ? err.message : err);
  }
}

export async function transcribeAudioBuffer(
  buffer: Buffer,
  mimeType: string,
  language: string,
  forceArabic?: boolean,
  options?: { fast?: boolean },
): Promise<string> {
  if (buffer.length < 200) {
    throw new Error('recording-too-short');
  }

  // Read per process start; restart the server after changing STT_PROVIDER/FFMPEG_PATH.
  const sttProvider = (process.env.STT_PROVIDER || 'openai').toLowerCase();
  if (sttProvider === 'local') {
    try {
      const { transcribeWithLocalWhisper } = await import('./localWhisperSttService.js');
      const whisperLang = resolveWhisperLanguage(language, forceArabic);
      const expectArabic = whisperLang === 'ar';
      const raw = await transcribeWithLocalWhisper(buffer, mimeType, language, forceArabic);
      return finalizeTranscript(raw, expectArabic, options);
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      // Preserve validation errors — do not fall back for bad/unclear audio.
      if (
        message === 'recording-too-short' ||
        message === 'transcription-not-arabic' ||
        message === 'transcription-prompt-leak'
      ) {
        throw err;
      }

      const canFallbackToOpenAI =
        !!process.env.OPENAI_API_KEY?.trim() &&
        (process.env.AI_PROVIDER || 'openai').toLowerCase() !== 'mock';

      if (canFallbackToOpenAI) {
        console.warn(
          '[stt] local Whisper failed (%s) — falling back to OpenAI transcription',
          message || (err instanceof Error ? err.name : 'unknown'),
        );
        return transcribeWithOpenAISafe(buffer, mimeType, language, forceArabic, options);
      }

      console.error('[stt] local Whisper failed:', err);
      if (message === 'local-stt-ffmpeg-missing') throw err;
      throw new Error('transcription-unavailable');
    }
  }

  await assertAudioHasSpeech(buffer, mimeType);

  return transcribeWithOpenAISafe(buffer, mimeType, language, forceArabic, options);
}
