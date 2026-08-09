import ffmpegStatic from 'ffmpeg-static';
import { execFile } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@xenova/transformers';
import { hasSpeechEnergy, wavBufferToFloat32 } from './audioSpeechDetector.js';

const execFileAsync = promisify(execFile);

function resolveWhisperLanguage(language: string, forceArabic?: boolean): 'ar' | 'en' | 'auto' {
  if (forceArabic) return 'ar';
  const code = language.toLowerCase();
  if (code === 'auto' || code === 'auto-detect') return 'auto';
  if (code.startsWith('ar')) return 'ar';
  if (code.startsWith('en')) return 'en';
  return 'auto';
}

let transcriberPromise: Promise<AutomaticSpeechRecognitionPipeline> | null = null;

function resolveLocalWhisperModel(): string {
  // Keep the API process stable on low-memory development machines.
  return process.env.LOCAL_WHISPER_MODEL?.trim() || 'Xenova/whisper-tiny';
}

async function getFfmpegExecutable(): Promise<string> {
  const configured = process.env.FFMPEG_PATH?.trim();
  if (configured) return configured;

  const bundledFfmpeg = ffmpegStatic as unknown as string | null;
  if (typeof bundledFfmpeg === 'string' && bundledFfmpeg.length > 0) {
    return bundledFfmpeg;
  }

  throw new Error('local-stt-ffmpeg-missing');
}

function extensionForMime(mimeType: string): string {
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'm4a';
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('wav')) return 'wav';
  return 'webm';
}

async function convertToWav16kMono(inputPath: string, outputPath: string): Promise<void> {
  const ffmpeg = await getFfmpegExecutable();
  await execFileAsync(ffmpeg, ['-y', '-i', inputPath, '-ar', '16000', '-ac', '1', '-f', 'wav', outputPath]);
}

function pickTranscriptText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) {
    for (let i = result.length - 1; i >= 0; i -= 1) {
      const text = pickTranscriptText(result[i]);
      if (text) return text;
    }
    return '';
  }
  if (result && typeof result === 'object' && 'text' in result) {
    const text = (result as { text?: unknown }).text;
    return typeof text === 'string' ? text : '';
  }
  return '';
}

async function getTranscriber(): Promise<AutomaticSpeechRecognitionPipeline> {
  if (!transcriberPromise) {
    env.cacheDir = process.env.TRANSFORMERS_CACHE_DIR?.trim() || join(process.cwd(), '.cache', 'transformers');
    env.allowLocalModels = true;
    env.allowRemoteModels = true;

    const model = resolveLocalWhisperModel();
    console.info('[local-stt] loading model', model);
    transcriberPromise = pipeline('automatic-speech-recognition', model, {
      quantized: true,
    }) as Promise<AutomaticSpeechRecognitionPipeline>;
  }
  return transcriberPromise;
}

export function isLocalSttEnabled(): boolean {
  return (process.env.STT_PROVIDER || 'openai').toLowerCase() === 'local';
}

/** Transcribe audio using on-device Whisper via @xenova/transformers (no OpenAI STT API). */
export async function transcribeWithLocalWhisper(
  buffer: Buffer,
  mimeType: string,
  language: string,
  forceArabic?: boolean,
): Promise<string> {
  const lang = resolveWhisperLanguage(language, forceArabic);

  const tempDir = await mkdtemp(join(tmpdir(), 'synoza-stt-'));
  const inputPath = join(tempDir, `input.${extensionForMime(mimeType)}`);
  const wavPath = join(tempDir, 'audio.wav');

  try {
    await writeFile(inputPath, buffer);
    await convertToWav16kMono(inputPath, wavPath);
    const wavBuffer = await readFile(wavPath);
    const audioData = wavBufferToFloat32(wavBuffer);

    if (audioData.length < 1600) {
      throw new Error('recording-too-short');
    }

    if (!hasSpeechEnergy(audioData)) {
      throw new Error('recording-too-short');
    }

    const run = async (whisperLanguage: 'arabic' | 'english') => {
      const transcriber = await getTranscriber();
      const result = await transcriber(audioData, {
        language: whisperLanguage,
        task: 'transcribe',
        return_timestamps: false,
        chunk_length_s: 30,
        stride_length_s: 5,
        generation_kwargs: {
          no_speech_threshold: 0.75,
          logprob_threshold: -1.0,
          compression_ratio_threshold: 2.4,
        },
      });
      return pickTranscriptText(result).trim();
    };

    if (lang === 'auto') {
      // Local Whisper cannot omit language; try Arabic then English and keep the stronger match.
      const arabicText = await run('arabic');
      const arabicChars = (arabicText.match(/[\u0600-\u06FF]/g) || []).length;
      if (arabicChars >= 2) return arabicText;
      const englishText = await run('english');
      const latinChars = (englishText.match(/[a-zA-Z]/g) || []).length;
      return latinChars >= arabicChars ? englishText || arabicText : arabicText || englishText;
    }

    return await run(lang === 'ar' ? 'arabic' : 'english');
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
