import ffmpegStatic from 'ffmpeg-static';
import { execFile } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import wavefile from 'wavefile';
import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@xenova/transformers';

const execFileAsync = promisify(execFile);

// wavefile is CJS — named ESM import fails under Node; use default export.
const WaveFile = (wavefile as unknown as { WaveFile: new (buffer?: Buffer) => {
  toBitDepth: (depth: string) => void;
  toSampleRate: (rate: number) => void;
  getSamples: (channel?: boolean, type?: typeof Float32Array) => unknown;
} }).WaveFile;

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

function wavBufferToFloat32(wavBuffer: Buffer): Float32Array {
  const wav = new WaveFile(wavBuffer);
  wav.toBitDepth('32f');
  wav.toSampleRate(16000);
  const rawSamples = wav.getSamples(false, Float32Array) as unknown;

  if (Array.isArray(rawSamples)) {
    const channels = rawSamples as Float32Array[];
    if (channels.length > 1) {
      const merged = new Float32Array(channels[0].length);
      const scale = Math.sqrt(2);
      for (let i = 0; i < merged.length; i += 1) {
        merged[i] = (scale * (channels[0][i] + channels[1][i])) / 2;
      }
      return merged;
    }
    return channels[0];
  }

  if (rawSamples instanceof Float32Array) {
    return rawSamples;
  }

  return Float32Array.from(rawSamples as ArrayLike<number>);
}

function measureAudioLevel(samples: Float32Array): { rms: number; peak: number } {
  let sumSq = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i];
    sumSq += value * value;
    const abs = Math.abs(value);
    if (abs > peak) peak = abs;
  }
  return { rms: Math.sqrt(sumSq / samples.length), peak };
}

function audioLooksLikeSpeech(samples: Float32Array): boolean {
  const { rms, peak } = measureAudioLevel(samples);
  // Browser noise suppression and laptop microphones can produce quiet but valid speech.
  // Keep this below the client VAD threshold so accepted recordings are not rejected here.
  return rms >= 0.0025 && peak >= 0.01;
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

    if (!audioLooksLikeSpeech(audioData)) {
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
