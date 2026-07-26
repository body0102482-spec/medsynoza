import OpenAI from 'openai';
import { toEgyptianColloquial } from './arabicColloquial.js';

function getOpenAIClient(): OpenAI | null {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;
  return new OpenAI({ apiKey });
}

function looksAlreadyColloquial(text: string): boolean {
  return /مش|عايز|عايزة|كده|دلوقتي|إيه|ازيك|عندي/.test(text);
}

export async function synthesizeSpeech(text: string, lang: string): Promise<Buffer> {
  const isArabic = lang.toLowerCase().startsWith('ar');
  // Prefer the exact reply from the patient engine; only colloquialize formal leftovers.
  const raw = text.trim().slice(0, 4096);
  const trimmed = (
    isArabic && !looksAlreadyColloquial(raw) ? toEgyptianColloquial(raw) : raw
  ).trim();
  if (!trimmed) {
    throw new Error('empty-text');
  }

  const client = getOpenAIClient();
  const provider = (process.env.AI_PROVIDER || 'openai').toLowerCase();
  if (!client || provider === 'mock') {
    throw new Error('tts-unavailable');
  }

  const model = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
  const voice = isArabic
    ? process.env.OPENAI_TTS_VOICE_AR || 'nova'
    : process.env.OPENAI_TTS_VOICE_EN || 'alloy';

  const response = await client.audio.speech.create({
    model,
    voice: voice as 'alloy',
    input: trimmed,
    response_format: 'mp3',
    ...(isArabic
      ? {
          instructions:
            process.env.OPENAI_TTS_INSTRUCTIONS_AR ||
            'Speak in natural Egyptian Arabic colloquial (عامية مصرية) like a patient in a Cairo clinic. Warm, clear, conversational tone. Speak the provided text accurately without omitting or inventing content.',
        }
      : {
          instructions:
            'Speak the provided text accurately and clearly without omitting or inventing content.',
        }),
  });

  return Buffer.from(await response.arrayBuffer());
}
