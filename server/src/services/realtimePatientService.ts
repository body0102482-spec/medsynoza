import type { Case } from '@prisma/client';
import { buildRealtimePatientInstructions } from './aiService.js';

function resolveRealtimeModel(): string {
  const explicit = process.env.OPENAI_REALTIME_MODEL?.trim();
  if (explicit) return explicit;
  const shared = process.env.OPENAI_MODEL?.trim();
  if (shared && /realtime/i.test(shared)) return shared;
  return 'gpt-realtime-mini';
}

function resolveRealtimeLanguage(sessionLanguage: string): 'en' | 'ar' | undefined {
  if (sessionLanguage === 'EN') return 'en';
  if (sessionLanguage === 'AR') return 'ar';
  // AUTO: omit language so the realtime transcription model can detect English or Arabic.
  return undefined;
}

export function normalizeSdp(sdp: string): string {
  const lines = sdp.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split('\n');
  return `${lines.join('\r\n')}\r\n`;
}

/** WebRTC session shape — matches working Nova voice-call config (no manual PCM format). */
export function buildRealtimeSessionConfig(caseData: Case, sessionLanguage: string) {
  const model = resolveRealtimeModel();
  const voice = process.env.OPENAI_REALTIME_VOICE || 'alloy';
  const lang = resolveRealtimeLanguage(sessionLanguage);
  const transcribeModel =
    process.env.OPENAI_REALTIME_TRANSCRIBE_MODEL || 'gpt-4o-transcribe';

  return {
    type: 'realtime',
    model,
    instructions: buildRealtimePatientInstructions(caseData, sessionLanguage),
    audio: {
      input: {
        transcription: {
          model: transcribeModel,
          ...(lang ? { language: lang } : {}),
        },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 700,
          create_response: true,
          interrupt_response: true,
        },
      },
      output: {
        voice,
      },
    },
  };
}

export async function mintRealtimeClientSecret(
  apiKey: string,
  sessionConfig: ReturnType<typeof buildRealtimeSessionConfig>,
): Promise<string> {
  const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      expires_after: {
        anchor: 'created_at',
        seconds: 600,
      },
      session: sessionConfig,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    const err = new Error('realtime-call-failed') as Error & { detail?: string; status?: number };
    err.detail = detail;
    err.status = response.status;
    throw err;
  }

  const data = (await response.json()) as { value?: string };
  if (!data.value) {
    throw new Error('realtime-call-failed');
  }
  return data.value;
}

async function exchangeRealtimeSdp(ephemeralKey: string, sdpOffer: string): Promise<string> {
  const normalizedSdp = normalizeSdp(sdpOffer);
  const form = new FormData();
  form.set('sdp', normalizedSdp);

  const response = await fetch('https://api.openai.com/v1/realtime/calls', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ephemeralKey}`,
    },
    body: form,
  });

  const answerSdp = await response.text();
  if (!response.ok) {
    console.error('[realtime] OpenAI call failed:', response.status, answerSdp);
    throw new Error('realtime-call-failed');
  }

  return answerSdp;
}

export async function createRealtimePatientCallAnswer(
  caseData: Case,
  sessionLanguage: string,
  sdpOffer: string,
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('realtime-unavailable');
  }

  const normalizedSdp = normalizeSdp(sdpOffer);
  if (normalizedSdp.length < 100 || !normalizedSdp.includes('m=audio')) {
    console.warn('[realtime] rejected invalid SDP', { length: normalizedSdp.length });
    throw new Error('invalid-sdp');
  }

  const sessionConfig = buildRealtimeSessionConfig(caseData, sessionLanguage);
  console.info('[realtime] creating call', {
    model: sessionConfig.model,
    transcribe: sessionConfig.audio?.input?.transcription?.model,
    language: sessionConfig.audio?.input?.transcription?.language,
    sdpLength: normalizedSdp.length,
  });

  const ephemeralKey = await mintRealtimeClientSecret(apiKey, sessionConfig);
  return exchangeRealtimeSdp(ephemeralKey, normalizedSdp);
}
