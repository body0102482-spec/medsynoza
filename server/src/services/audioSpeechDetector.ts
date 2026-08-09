import ffmpegStatic from 'ffmpeg-static';
import { execFile } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import wavefile from 'wavefile';

const execFileAsync = promisify(execFile);

// wavefile is CJS — named ESM import fails under Node; use default export.
const WaveFile = (wavefile as unknown as { WaveFile: new (buffer?: Buffer) => {
  toBitDepth: (depth: string) => void;
  toSampleRate: (rate: number) => void;
  getSamples: (channel?: boolean, type?: typeof Float32Array) => unknown;
} }).WaveFile;

const SAMPLE_RATE = 16000;
const FRAME_SIZE = 480; // 30ms @ 16 kHz
const HOP_SIZE = 160; // 10ms
const HOP_MS = 10;
const ABS_RMS_FLOOR = 0.002; // ~ -54 dBFS — below this a frame is digital silence
const NOISE_MULTIPLIER = 2; // frame must exceed the local noise floor by this factor
const MIN_SPEECH_MS = 250; // shortest utterance worth transcribing ("لا" / "نعم")
const MAX_GAP_MS = 400; // merge speech separated by less than this
const PEAK_REQUIRED = 0.006;

function getFfmpegExecutable(): string | null {
  const configured = process.env.FFMPEG_PATH?.trim();
  if (configured) return configured;
  return ffmpegStatic as unknown as string | null;
}

function extensionForMime(mimeType: string): string {
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'm4a';
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('wav')) return 'wav';
  return 'webm';
}

export function wavBufferToFloat32(wavBuffer: Buffer): Float32Array {
  const wav = new WaveFile(wavBuffer);
  wav.toBitDepth('32f');
  wav.toSampleRate(SAMPLE_RATE);
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

/**
 * Decode any supported container (webm / mp4 / m4a / ogg / wav) to 16 kHz mono PCM.
 * Returns null when ffmpeg is unavailable or the file cannot be decoded — callers
 * should fail open in that case rather than blocking transcription.
 */
export async function decodeAudioToPcm16k(
  buffer: Buffer,
  mimeType: string,
): Promise<Float32Array | null> {
  const ffmpeg = getFfmpegExecutable();
  if (!ffmpeg) return null;

  const tempDir = await mkdtemp(join(tmpdir(), 'synoza-audio-'));
  const inputPath = join(tempDir, `input.${extensionForMime(mimeType)}`);
  const wavPath = join(tempDir, 'audio.wav');

  try {
    await writeFile(inputPath, buffer);
    await execFileAsync(
      ffmpeg,
      ['-y', '-i', inputPath, '-ar', String(SAMPLE_RATE), '-ac', '1', '-f', 'wav', wavPath],
      { timeout: 15_000 },
    );
    const wavBuffer = await readFile(wavPath);
    return wavBufferToFloat32(wavBuffer);
  } catch {
    return null;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Frame-based speech energy detector.
 *
 * Unlike a whole-clip RMS average, this tolerates sparse speech (e.g. one sentence
 * inside a long silent recording) while rejecting constant background noise: the
 * threshold is derived from the clip's own noise floor (quietest 20% of frames),
 * so steady fan/HVAC/mic hiss never crosses it no matter how loud, but real speech
 * (which pauses between words) easily does.
 */
export function hasSpeechEnergy(samples: Float32Array): boolean {
  if (samples.length < SAMPLE_RATE * 0.2) return false;

  const frames: number[] = [];
  let peak = 0;
  for (let start = 0; start < samples.length; start += HOP_SIZE) {
    const end = Math.min(start + FRAME_SIZE, samples.length);
    let sumSq = 0;
    for (let i = start; i < end; i += 1) {
      const value = samples[i];
      sumSq += value * value;
      const abs = Math.abs(value);
      if (abs > peak) peak = abs;
    }
    frames.push(Math.sqrt(sumSq / (end - start)));
  }

  const sorted = [...frames].sort((a, b) => a - b);
  const noiseCount = Math.max(2, Math.floor(sorted.length * 0.2));
  let noiseSum = 0;
  for (let i = 0; i < noiseCount; i += 1) noiseSum += sorted[i];
  const noiseFloor = noiseSum / noiseCount;

  const threshold = Math.max(noiseFloor * NOISE_MULTIPLIER, ABS_RMS_FLOOR);

  let bestRunMs = 0;
  let runMs = 0;
  let gapMs = 0;
  for (const rms of frames) {
    if (rms >= threshold) {
      runMs += HOP_MS;
      gapMs = 0;
      if (runMs > bestRunMs) bestRunMs = runMs;
    } else if (runMs > 0) {
      gapMs += HOP_MS;
      if (gapMs > MAX_GAP_MS) runMs = 0;
    }
  }

  return bestRunMs >= MIN_SPEECH_MS && peak >= PEAK_REQUIRED;
}

/**
 * Returns true when the clip contains real speech energy, false when it is
 * silence/constant noise, and null when the audio could not be decoded
 * (callers should fail open).
 */
export async function audioContainsSpeech(
  buffer: Buffer,
  mimeType: string,
): Promise<boolean | null> {
  const samples = await decodeAudioToPcm16k(buffer, mimeType);
  if (samples === null) return null;
  return hasSpeechEnergy(samples);
}
