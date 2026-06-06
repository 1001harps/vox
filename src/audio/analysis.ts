import type { HistoryBuffer } from "../types";
import { detectPitch, freqToMidi, noteFromPitch, WINDOW_MS } from "./pitch";

export interface AnalysisCallbacks {
  onRenderGraph: () => void;
  onPitchUpdate: (noteName: string, inTune: boolean) => void;
  onPitchClear: () => void;
  onFrame: (timeData: Float32Array, peak: number) => void;
}

// Start the pitch analysis loop. Returns a function that stops the loop.
export function startAnalysis(
  analyser: AnalyserNode,
  sampleRate: number,
  historyRef: { current: HistoryBuffer },
  callbacks: AnalysisCallbacks,
): () => void {
  const timeData = new Float32Array(analyser.fftSize);

  // Stabilize the reading: gate quiet noise, median-filter jitter, require
  // big jumps to persist before committing (octave-distance jumps -- the
  // most likely detection error -- need much longer), then ease the
  // displayed pitch toward the committed note so transitions ramp instead
  // of jumping squarely.
  const NOISE_GATE = 0.015; // RMS below this counts as silence
  const MEDIAN_WINDOW = 3; // median of recent raw readings smooths jitter
  const SNAP_CENTS = 60; // within this, readings are treated as the same note
  const CONFIRM_FRAMES = 3; // a normal jump must persist this long to commit
  const OCTAVE_CONFIRM_FRAMES = 9; // octave jumps must persist much longer
  const DISPLAY_EASE = 0.25; // how fast the displayed pitch eases to target
  const HOLD_MS = 750; // keep showing the last note this long after silence

  // True when `a` is within ~1 semitone of an octave (or two) away from `b`
  // -- i.e. the gap looks like an octave-doubling/halving error, not a leap.
  const nearOctave = (a: number, b: number) => {
    const c = Math.abs(1200 * Math.log2(a / b));
    return Math.abs(c - 1200) < 100 || Math.abs(c - 2400) < 100;
  };

  let smoothed = -1; // displayed pitch (eases toward target)
  let target = -1; // the note we currently believe is being sung
  let lastGoodTime = 0;
  let recentRaw: number[] = [];
  let candidate = -1; // a pending note-change waiting to be confirmed
  let candidateFrames = 0;
  historyRef.current = { samples: [], start: 0 };

  let rafId: number | null = null;

  const tick = () => {
    analyser.getFloatTimeDomainData(timeData);
    // RMS of the waveform -> perceived loudness, roughly 0..1
    let sum = 0;
    for (let i = 0; i < timeData.length; i++) {
      sum += timeData[i] * timeData[i];
    }
    const vol = Math.sqrt(sum / timeData.length);

    // Noise gate: ignore detections when the signal is too quiet to be a note.
    const raw = vol >= NOISE_GATE ? detectPitch(timeData, sampleRate) : -1;
    const now = performance.now();

    if (raw > 0) {
      // Median-filter the raw readings to smooth frame-to-frame jitter.
      recentRaw.push(raw);
      if (recentRaw.length > MEDIAN_WINDOW) recentRaw.shift();
      const sorted = [...recentRaw].sort((a, b) => a - b);
      const value = sorted[Math.floor(sorted.length / 2)];

      const cents = (a: number, b: number) =>
        Math.abs(1200 * Math.log2(a / b));

      if (target < 0) {
        target = value; // first note after silence: lock on immediately
        smoothed = value;
        candidate = -1;
        candidateFrames = 0;
      } else if (cents(value, target) <= SNAP_CENTS) {
        target = value; // same note: follow the voice (drift, vibrato)
        candidate = -1;
        candidateFrames = 0;
      } else {
        // Big jump: a real note change or (more often) an octave error. Only
        // commit once it persists; octave-distance jumps must persist longer.
        const need = nearOctave(value, target)
          ? OCTAVE_CONFIRM_FRAMES
          : CONFIRM_FRAMES;
        if (candidate > 0 && cents(value, candidate) <= SNAP_CENTS) {
          candidateFrames++;
        } else {
          candidate = value;
          candidateFrames = 1;
        }
        if (candidateFrames >= need) {
          target = candidate;
          candidate = -1;
          candidateFrames = 0;
        }
      }

      // Ease the displayed pitch toward the target in log space, so any
      // transition ramps smoothly (like a voice) instead of a square jump.
      smoothed *= Math.pow(target / smoothed, DISPLAY_EASE);
      lastGoodTime = now;
      const note = noteFromPitch(smoothed);
      const inTune = Math.abs(note.cents) <= 5;
      callbacks.onPitchUpdate(note.name, inTune);
    } else {
      recentRaw = [];
      candidate = -1;
      candidateFrames = 0;
      if (now - lastGoodTime > HOLD_MS) {
        smoothed = -1;
        target = -1;
        callbacks.onPitchClear();
      }
    }

    const history = historyRef.current;
    history.samples.push({ t: now, midi: raw > 0 ? freqToMidi(smoothed) : NaN });
    const cutoff = now - WINDOW_MS;
    while (history.start < history.samples.length && history.samples[history.start].t < cutoff) history.start++;
    if (history.start > 512) {
      history.samples.splice(0, history.start);
      history.start = 0;
    }

    callbacks.onRenderGraph();

    // Peak amplitude of this frame (matches the saved-take waveform's
    // max-abs scaling, so live and played-back waveforms look alike).
    let peak = 0;
    for (let i = 0; i < timeData.length; i++) {
      const a = Math.abs(timeData[i]);
      if (a > peak) peak = a;
    }
    callbacks.onFrame(timeData, peak);

    rafId = requestAnimationFrame(tick);
  };
  tick();

  return () => {
    if (rafId !== null) cancelAnimationFrame(rafId);
  };
}
