export const NOTE_NAMES = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
];

// Lenient periodicity check: reject only clearly aperiodic frames (broadband
// noise, transients). Kept low on purpose so it works across all mics and the
// full vocal range -- voice is the priority, not perfect noise rejection.
export const CLARITY_THRESHOLD = 0.5;

// Autocorrelation pitch detection (after Chris Wilson's PitchDetect).
// Returns the fundamental frequency in Hz, or -1 if no clear pitch.
export function detectPitch(buf: Float32Array, sampleRate: number): number {
  const size = buf.length;

  // Bail if the signal is too quiet to have a reliable pitch.
  let rms = 0;
  for (let i = 0; i < size; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / size);
  if (rms < 0.01) return -1;

  // Trim near-silent edges so the correlation locks onto the tone.
  const thres = 0.2;
  let start = 0;
  let end = size - 1;
  for (let i = 0; i < size / 2; i++) {
    if (Math.abs(buf[i]) < thres) {
      start = i;
      break;
    }
  }
  for (let i = 1; i < size / 2; i++) {
    if (Math.abs(buf[size - i]) < thres) {
      end = size - i;
      break;
    }
  }

  const trimmed = buf.subarray(start, end);
  const n = trimmed.length;

  let c0 = 0;
  for (let i = 0; i < n; i++) c0 += trimmed[i] * trimmed[i];
  if (c0 === 0) return -1;

  const minLag = Math.max(1, Math.floor(sampleRate / 1000));
  const maxLag = Math.min(n - 2, Math.ceil(sampleRate / 80));
  const c = new Float32Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag + 1; lag++) {
    let sum = 0;
    for (let i = 0; i < n - lag; i++) sum += trimmed[i] * trimmed[i + lag];
    c[lag] = sum;
  }

  let maxVal = -1;
  let bestLag = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (c[lag] > maxVal) {
      maxVal = c[lag];
      bestLag = lag;
    }
  }
  if (bestLag <= 0) return -1;

  if (maxVal / c0 < CLARITY_THRESHOLD) return -1;

  let t0 = bestLag;
  if (bestLag > minLag && bestLag < maxLag) {
    const x1 = c[bestLag - 1];
    const x2 = c[bestLag];
    const x3 = c[bestLag + 1];
    const a = (x1 + x3 - 2 * x2) / 2;
    const b = (x3 - x1) / 2;
    if (a) t0 = bestLag - b / (2 * a);
  }

  return sampleRate / t0;
}

// Nearest note name + how many cents sharp/flat the pitch is.
export function noteFromPitch(freq: number): { name: string; cents: number } {
  const midi = Math.round(12 * Math.log2(freq / 440) + 69);
  const refFreq = 440 * Math.pow(2, (midi - 69) / 12);
  const cents = Math.round(1200 * Math.log2(freq / refFreq));
  const name = NOTE_NAMES[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return { name: `${name}${octave}`, cents };
}

// Piano-roll vertical range: C2 up to C6.
export const MIN_MIDI = 36;
export const MAX_MIDI = 84;
export const LANES = MAX_MIDI - MIN_MIDI + 1;

// How many seconds of pitch history the X axis spans (now at the right edge).
export const WINDOW_MS = 6000;

// Continuous MIDI number for a frequency (float, for smooth dot placement).
export function freqToMidi(freq: number): number {
  return 69 + 12 * Math.log2(freq / 440);
}

const BLACK_KEYS = "010100101010";
export function isBlackKey(midi: number): boolean {
  return BLACK_KEYS[((midi % 12) + 12) % 12] === "1";
}
