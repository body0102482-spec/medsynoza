import api from './api';
import { shouldForceArabicTranscription } from './arabicSttFix';

/** Text-only turns (browser STT already done) — AI reply only. */
export const TEXT_TURN_TIMEOUT_MS = 30_000;
/** Audio turns — Whisper transcription + AI reply. */
export const VOICE_TURN_TIMEOUT_MS = 60_000;

export interface VoiceTurnMeta {
  endpoint: 'chat' | 'examiner';
  stage: string;
  maneuverId?: string;
}

export interface VoiceTurnResponse {
  transcript: string;
  studentMessage: {
    id: string;
    role: string;
    content: string;
    stage: string;
    createdAt: string;
  };
  replyMessage: {
    id: string;
    role: string;
    content: string;
    stage: string;
    createdAt: string;
  };
}

export async function postTextTurn(
  sessionId: string,
  transcript: string,
  meta: VoiceTurnMeta,
): Promise<VoiceTurnResponse> {
  const res = await api.post<VoiceTurnResponse>(
    `/sessions/${sessionId}/voice-turn`,
    {
      transcript,
      endpoint: meta.endpoint,
      stage: meta.stage,
      maneuverId: meta.maneuverId,
    },
    { timeout: TEXT_TURN_TIMEOUT_MS },
  );

  return res.data;
}

export async function postVoiceTurn(
  sessionId: string,
  blob: Blob,
  language: string,
  sessionLang: string,
  meta: VoiceTurnMeta,
): Promise<VoiceTurnResponse> {
  const expectArabic = shouldForceArabicTranscription(sessionLang);
  const audioBase64 = await blobToBase64(blob);
  const requestLanguage =
    sessionLang === 'AUTO' ? 'auto' : expectArabic ? 'ar-EG' : language;

  const res = await api.post<VoiceTurnResponse>(
    `/sessions/${sessionId}/voice-turn`,
    {
      audioBase64,
      mimeType: blob.type || 'audio/webm',
      language: requestLanguage,
      forceArabic: expectArabic,
      endpoint: meta.endpoint,
      stage: meta.stage,
      maneuverId: meta.maneuverId,
    },
    { timeout: VOICE_TURN_TIMEOUT_MS },
  );

  return res.data;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('read-failed'));
        return;
      }
      const base64 = result.split(',')[1];
      if (!base64) {
        reject(new Error('read-failed'));
        return;
      }
      resolve(base64);
    };
    reader.onerror = () => reject(new Error('read-failed'));
    reader.readAsDataURL(blob);
  });
}
