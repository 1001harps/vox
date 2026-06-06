import { useCallback, useEffect, useRef, useState } from "react";
import {
  IndexedDBStorage,
  type RecordingData,
  type RecordingStorage,
} from "./storage";

const NOTE_NAMES = [
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
const CLARITY_THRESHOLD = 0.5;

// Autocorrelation pitch detection (after Chris Wilson's PitchDetect).
// Returns the fundamental frequency in Hz, or -1 if no clear pitch.
function detectPitch(buf: Float32Array, sampleRate: number): number {
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
  const c = new Float32Array(n);
  for (let lag = 0; lag < n; lag++) {
    let sum = 0;
    for (let i = 0; i < n - lag; i++) sum += trimmed[i] * trimmed[i + lag];
    c[lag] = sum;
  }

  // Skip the initial downslope, then find the highest correlation peak.
  let d = 0;
  while (d < n - 1 && c[d] > c[d + 1]) d++;
  let maxVal = -1;
  let maxLag = -1;
  for (let lag = d; lag < n; lag++) {
    if (c[lag] > maxVal) {
      maxVal = c[lag];
      maxLag = lag;
    }
  }
  if (maxLag <= 0 || maxLag >= n - 1) return -1;

  // Clarity = peak correlation relative to zero-lag energy (c[0]). Periodic
  // tones approach 1; noise/transients stay low. Reject anything too low.
  if (maxVal / c[0] < CLARITY_THRESHOLD) return -1;

  // Parabolic interpolation around the peak for sub-sample accuracy.
  let t0 = maxLag;
  const x1 = c[maxLag - 1];
  const x2 = c[maxLag];
  const x3 = c[maxLag + 1];
  const a = (x1 + x3 - 2 * x2) / 2;
  const b = (x3 - x1) / 2;
  if (a) t0 = maxLag - b / (2 * a);

  return sampleRate / t0;
}

// Nearest note name + how many cents sharp/flat the pitch is.
function noteFromPitch(freq: number): { name: string; cents: number } {
  const midi = Math.round(12 * Math.log2(freq / 440) + 69);
  const refFreq = 440 * Math.pow(2, (midi - 69) / 12);
  const cents = Math.round(1200 * Math.log2(freq / refFreq));
  const name = NOTE_NAMES[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return { name: `${name}${octave}`, cents };
}

// Piano-roll vertical range: E2 (guitar low E) up to C6.
const MIN_MIDI = 40;
const MAX_MIDI = 84;
const LANES = MAX_MIDI - MIN_MIDI + 1;

// How many seconds of pitch history the X axis spans (now at the right edge).
const WINDOW_MS = 6000;

// One pitch reading over time. `midi` is NaN for frames with no detected pitch,
// which breaks the contour into separate phrases.
type Sample = { t: number; midi: number };

// Continuous MIDI number for a frequency (float, for smooth dot placement).
function freqToMidi(freq: number): number {
  return 69 + 12 * Math.log2(freq / 440);
}

function isBlackKey(midi: number): boolean {
  return [1, 3, 6, 8, 10].includes(((midi % 12) + 12) % 12);
}

// idle = nothing running, monitoring = live graph only, recording = monitor +
// capture, playing = playing back a recorded clip.
type Status = "idle" | "monitoring" | "recording" | "playing";

// A saved take. In-memory representation with object URL for playback.
type Recording = {
  id: string;
  createdAt: number; // ms epoch, captured when recording started
  durationMs: number;
  url: string; // object URL for the captured blob
};

// Which screen is showing.
type View = "practice" | "recordings" | "progress";

const storage: RecordingStorage = new IndexedDBStorage();

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getHours().toString().padStart(2, "0")}:${
    d.getMinutes().toString().padStart(2, "0")
  }`;
}

const WAVEFORM_BARS = 200;

async function computeWaveformPeaks(url: string): Promise<Float32Array> {
  const response = await fetch(url);
  const arrayBuffer = await response.arrayBuffer();
  const audioContext = new OfflineAudioContext(1, 1, 44100);
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
  const channelData = audioBuffer.getChannelData(0);
  const samplesPerBar = Math.floor(channelData.length / WAVEFORM_BARS);
  const peaks = new Float32Array(WAVEFORM_BARS);
  for (let bar = 0; bar < WAVEFORM_BARS; bar++) {
    let max = 0;
    const start = bar * samplesPerBar;
    const end = Math.min(start + samplesPerBar, channelData.length);
    for (let i = start; i < end; i++) {
      const abs = Math.abs(channelData[i]);
      if (abs > max) max = abs;
    }
    peaks[bar] = max;
  }
  return peaks;
}

function getStartOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function groupRecordingsByDate(
  recordings: Recording[],
): { label: string; recordings: Recording[] }[] {
  const now = Date.now();
  const todayStart = getStartOfDay(now);
  const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;
  const groups: Map<string, Recording[]> = new Map();

  for (const rec of recordings) {
    const recDay = getStartOfDay(rec.createdAt);
    let label: string;
    if (recDay === todayStart) label = "Today";
    else if (recDay === yesterdayStart) label = "Yesterday";
    else {
      const d = new Date(rec.createdAt);
      label = d.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      });
    }
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(rec);
  }

  return Array.from(groups, ([label, recs]) => ({ label, recordings: recs }));
}

function computeProgressStats(recordings: Recording[]) {
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const sessionsThisWeek = recordings.filter(
    (r) => r.createdAt >= weekAgo,
  ).length;

  const recordingDays = new Set(
    recordings.map((r) => getStartOfDay(r.createdAt)),
  );
  let streak = 0;
  let day = getStartOfDay(now);
  if (!recordingDays.has(day)) {
    day -= 24 * 60 * 60 * 1000;
  }
  while (recordingDays.has(day)) {
    streak++;
    day -= 24 * 60 * 60 * 1000;
  }

  const dailySessions: { label: string; count: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const dayStart = getStartOfDay(now - i * 24 * 60 * 60 * 1000);
    const dayEnd = dayStart + 24 * 60 * 60 * 1000;
    const count = recordings.filter(
      (r) => r.createdAt >= dayStart && r.createdAt < dayEnd,
    ).length;
    let label = "";
    if (i === 0) label = "today";
    else if (i === 13) label = "2 wks ago";
    dailySessions.push({ label, count });
  }

  return { sessionsThisWeek, streak, dailySessions };
}

// Transport control glyphs. Deliberately unambiguous and mutually exclusive:
// ring+dot = record, square = stop, triangle = play, two bars = pause.
function TransportGlyph({ type }: {
  type: "record" | "stop" | "play" | "pause";
}) {
  switch (type) {
    case "record":
      return (
        <svg viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="12" cy="12" r="5" fill="#e0392b" />
        </svg>
      );
    case "stop":
      return (
        <svg viewBox="0 0 24 24">
          <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
        </svg>
      );
    case "play":
      return (
        <svg viewBox="0 0 24 24">
          <polygon points="8,5 8,19 19,12" fill="currentColor" />
        </svg>
      );
    case "pause":
      return (
        <svg viewBox="0 0 24 24">
          <rect x="7" y="5" width="3.5" height="14" rx="1" fill="currentColor" />
          <rect x="13.5" y="5" width="3.5" height="14" rx="1" fill="currentColor" />
        </svg>
      );
  }
}

function App() {
  const [status, setStatus] = useState<Status>("idle");
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [view, setView] = useState<View>("practice");
  const [pitch, setPitch] = useState(-1);
  const [selectedRecording, setSelectedRecording] = useState<Recording | null>(
    null,
  );
  const [waveformPeaks, setWaveformPeaks] = useState<Float32Array | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [playbackMs, setPlaybackMs] = useState(0);
  const [isDesktop, setIsDesktop] = useState(
    () => window.matchMedia("(min-width: 768px)").matches,
  );

  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const graphRef = useRef<HTMLDivElement | null>(null);
  const historyRef = useRef<Sample[]>([]);

  // Recording capture + playback element.
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const recordStartRef = useRef<number>(0); // ms epoch when capture started
  const liveWaveformCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // Amplitude peaks accumulated over the current take, so the live waveform can
  // show the whole recording so far (Voice-Memos style) instead of a zoomed-in
  // snapshot of the latest buffer.
  const recordingWaveRef = useRef<number[]>([]);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const waveformCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const peaksRef = useRef<Float32Array | null>(null);
  const playheadRef = useRef<number>(0);
  const waveformRafRef = useRef<number | null>(null);
  const isDraggingRef = useRef<boolean>(false);
  const hasDraggedRef = useRef<boolean>(false);
  const [recordingPeaks, setRecordingPeaks] = useState<
    Map<string, Float32Array>
  >(new Map());
  const computedPeaksRef = useRef<Set<string>>(new Set());

  // Match the canvas backing store to its CSS size (and DPR) so it stays crisp.
  const sizeCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const container = graphRef.current;
    if (!canvas || !container) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = container.clientWidth * dpr;
    canvas.height = container.clientHeight * dpr;
    // Setting width/height resets the transform, so re-apply DPR scaling here.
    canvas.getContext("2d")?.setTransform(dpr, 0, 0, dpr, 0, 0);
  }, []);

  const sizeLiveWaveformCanvas = useCallback(() => {
    const canvas = liveWaveformCanvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    canvas.getContext("2d")?.setTransform(dpr, 0, 0, dpr, 0, 0);
  }, []);

  // Draw the piano-roll grid and the buffered pitch history scrolling across
  // time (now at the right edge, older readings trailing left). Imperative +
  // called every frame, so it never triggers a React re-render.
  const renderGraph = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    const laneH = height / LANES;
    // Center of the lane for a (possibly fractional) MIDI value.
    const midiToY = (midi: number) => (MAX_MIDI - midi + 0.5) * laneH;
    // Map a timestamp to X: now -> center, now - WINDOW_MS -> left edge.
    // The right half is "future" (empty) so the contour reads like a playhead.
    const now = performance.now();
    const timeToX = (t: number) => (width / 2) * (1 - (now - t) / WINDOW_MS);

    // Opaque white background so saved PNGs aren't transparent.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);

    // --- Piano-roll grid ---
    ctx.textBaseline = "middle";
    for (let midi = MIN_MIDI; midi <= MAX_MIDI; midi++) {
      const top = (MAX_MIDI - midi) * laneH;
      const mid = top + laneH / 2;

      if (isBlackKey(midi)) {
        ctx.fillStyle = "#f2f2f2";
        ctx.fillRect(0, top, width, laneH);
      }
      ctx.strokeStyle = "#ececec";
      ctx.beginPath();
      ctx.moveTo(0, top);
      ctx.lineTo(width, top);
      ctx.stroke();

      // Label natural notes only; make each C bolder for octave orientation.
      if (!isBlackKey(midi)) {
        const name = NOTE_NAMES[((midi % 12) + 12) % 12];
        const isC = midi % 12 === 0;
        ctx.fillStyle = isC ? "#555" : "#aaa";
        ctx.font = `${isC ? 600 : 400} 11px system-ui, sans-serif`;
        ctx.fillText(`${name}${Math.floor(midi / 12) - 1}`, 6, mid);
      }
    }

    // Faint "now" playhead down the center.
    ctx.strokeStyle = "#ddd";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(width / 2, 0);
    ctx.lineTo(width / 2, height);
    ctx.stroke();

    // --- Pitch contour: connect samples, breaking the line on NaN (silence) ---
    const history = historyRef.current;
    ctx.strokeStyle = "#333";
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.beginPath();
    let penDown = false;
    for (const s of history) {
      if (Number.isNaN(s.midi)) {
        penDown = false;
        continue;
      }
      const x = timeToX(s.t);
      const y = midiToY(Math.min(MAX_MIDI, Math.max(MIN_MIDI, s.midi)));
      if (penDown) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
      penDown = true;
    }
    ctx.stroke();

    // --- Head dot: the most recent reading, colored by how in-tune it is ---
    const last = history[history.length - 1];
    if (last && !Number.isNaN(last.midi)) {
      const freq = 440 * Math.pow(2, (last.midi - 69) / 12);
      const inTune = Math.abs(noteFromPitch(freq).cents) <= 5;
      const midi = Math.min(MAX_MIDI, Math.max(MIN_MIDI, last.midi));
      ctx.fillStyle = inTune ? "#2e9e4f" : "#111";
      ctx.beginPath();
      ctx.arc(timeToX(last.t), midiToY(midi), 6, 0, Math.PI * 2);
      ctx.fill();
    }
  }, []);

  const renderWaveform = useCallback(() => {
    const canvas = waveformCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    ctx.clearRect(0, 0, width, height);
    const peaks = peaksRef.current;
    if (!peaks || peaks.length === 0) return;
    const barWidth = width / peaks.length;
    const midY = height / 2;
    const progress = playheadRef.current;
    for (let i = 0; i < peaks.length; i++) {
      const barHeight = peaks[i] * height;
      const x = i * barWidth;
      ctx.fillStyle = i / peaks.length <= progress ? "#333" : "#ccc";
      ctx.fillRect(x, midY - barHeight / 2, barWidth - 1, barHeight);
    }
  }, []);

  // Size + draw the grid on mount, and re-fit on resize / orientation change.
  useEffect(() => {
    sizeCanvas();
    renderGraph();
    const container = graphRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => {
      sizeCanvas();
      renderGraph();
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, [sizeCanvas, renderGraph]);

  // Re-runs when `status` changes so the canvas gets sized when it mounts on
  // record start (it's only rendered while recording, so a mount-only effect
  // would size it before it exists).
  useEffect(() => {
    sizeLiveWaveformCanvas();
    const canvas = liveWaveformCanvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => {
      sizeLiveWaveformCanvas();
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [sizeLiveWaveformCanvas, status]);

  useEffect(() => {
    const canvas = waveformCanvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    canvas.getContext("2d")?.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderWaveform();
  }, [renderWaveform, waveformPeaks]);

  async function selectRecording(rec: Recording) {
    setSelectedRecording(rec);
    const peaks = await computeWaveformPeaks(rec.url);
    peaksRef.current = peaks;
    setWaveformPeaks(peaks);
    playheadRef.current = 0;
    setPlaybackMs(0);
  }

  function seekToPosition(clientX: number) {
    const canvas = waveformCanvasRef.current;
    if (!canvas || !audioElRef.current || !selectedRecording) return;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const progress = Math.max(0, Math.min(1, x / rect.width));
    audioElRef.current.currentTime = progress * audioElRef.current.duration;
    playheadRef.current = progress;
    renderWaveform();
  }

  function handleWaveformPointerDown(e: React.MouseEvent | React.TouchEvent) {
    isDraggingRef.current = true;
    hasDraggedRef.current = false;
    const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
    seekToPosition(clientX);
  }

  function handleWaveformPointerMove(e: React.MouseEvent | React.TouchEvent) {
    if (!isDraggingRef.current) return;
    hasDraggedRef.current = true;
    const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
    seekToPosition(clientX);
  }

  function handleWaveformPointerUp() {
    isDraggingRef.current = false;
  }

  function handleWaveformClick(e: React.MouseEvent) {
    if (hasDraggedRef.current) {
      e.preventDefault();
      hasDraggedRef.current = false;
      return;
    }
    seekToPosition(e.clientX);
  }

  async function loadRecordings() {
    const data = await storage.getAll();
    const loaded: Recording[] = data.map((d) => ({
      id: d.id,
      createdAt: d.createdAt,
      durationMs: d.durationMs,
      url: URL.createObjectURL(d.blob),
    }));
    setRecordings(loaded);
  }

  const loadedRef = useRef<null | undefined>(null);
  if (loadedRef.current == null) {
    loadedRef.current = undefined;
    loadRecordings();
  }

  // The detect-smooth-graph loop, run against any analyser node -- the live mic
  // while recording, or the recorded clip on playback. Identical pitch handling
  // either way, so playback is graphed exactly as if the mic were live.
  const runAnalysis = useCallback(
    (analyser: AnalyserNode, sampleRate: number) => {
      analyserRef.current = analyser;
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
      historyRef.current = [];

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
          setPitch(smoothed);
        } else {
          // Gap: reset filters so the next phrase starts clean.
          recentRaw = [];
          candidate = -1;
          candidateFrames = 0;
          if (now - lastGoodTime > HOLD_MS) {
            smoothed = -1;
            target = -1;
            setPitch(-1);
          }
        }

        // Append this frame to the history. Plot only frames that actually had a
        // detection (raw > 0); silence pushes NaN so the contour ends immediately
        // instead of trailing the held note across the hold window.
        const history = historyRef.current;
        history.push({ t: now, midi: raw > 0 ? freqToMidi(smoothed) : NaN });
        const cutoff = now - WINDOW_MS;
        while (history.length && history[0].t < cutoff) history.shift();

        renderGraph();

        // Live recording waveform: accumulate one amplitude peak per frame and
        // draw the whole take as bars. While it fits, bars grow left -> right
        // (the waveform "expands" as you record); once it fills the strip, the
        // bars downsample to keep the entire take visible (Voice-Memos style).
        const lwCanvas = liveWaveformCanvasRef.current;
        if (lwCanvas) {
          const lwCtx = lwCanvas.getContext("2d");
          if (lwCtx) {
            const dpr = window.devicePixelRatio || 1;
            const lwWidth = lwCanvas.width / dpr;
            const lwHeight = lwCanvas.height / dpr;

            // Peak amplitude of this frame (matches the saved-take waveform's
            // max-abs scaling, so live and played-back waveforms look alike).
            let peak = 0;
            for (let i = 0; i < timeData.length; i++) {
              const a = Math.abs(timeData[i]);
              if (a > peak) peak = a;
            }
            const wave = recordingWaveRef.current;
            wave.push(peak);

            lwCtx.clearRect(0, 0, lwWidth, lwHeight);
            lwCtx.fillStyle = "#555";

            const slot = 3; // px per bar (bar + gap)
            const barW = 2;
            const maxBars = Math.max(1, Math.floor(lwWidth / slot));

            // Fit the whole take into the strip: take the max of each group once
            // there are more samples than bar slots.
            let bars: number[];
            if (wave.length <= maxBars) {
              bars = wave;
            } else {
              bars = new Array(maxBars);
              for (let i = 0; i < maxBars; i++) {
                const start = Math.floor((i * wave.length) / maxBars);
                const end = Math.floor(((i + 1) * wave.length) / maxBars);
                let m = 0;
                for (let j = start; j < end; j++) {
                  if (wave[j] > m) m = wave[j];
                }
                bars[i] = m;
              }
            }

            const midY = lwHeight / 2;
            for (let i = 0; i < bars.length; i++) {
              const h = Math.max(1, bars[i] * lwHeight);
              lwCtx.fillRect(i * slot, midY - h / 2, barW, h);
            }
          }
        }

        rafRef.current = requestAnimationFrame(tick);
      };
      tick();
    },
    [renderGraph],
  );

  // Tear down the audio graph + RAF loop, shared by both record and playback.
  const teardown = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    analyserRef.current = null;
    if (audioElRef.current) {
      audioElRef.current.pause();
      audioElRef.current.onended = null;
      audioElRef.current = null;
    }
    audioContextRef.current?.close();
    audioContextRef.current = null;
    setPitch(-1);
  }, []);

  // Clean up the audio graph on unmount. (Recording object URLs live for the
  // session; the browser frees them when the page closes.)
  useEffect(() => teardown, [teardown]);

  // Open the mic and start the live pitch graph. Shared by Start and Record so
  // recording can layer onto an already-running monitor (or open the mic itself).
  async function openMic() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;

    const audioContext = new AudioContext();
    audioContextRef.current = audioContext;
    await audioContext.resume();

    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);

    runAnalysis(analyser, audioContext.sampleRate);
  }

  async function startMonitor() {
    await openMic();
    setStatus("monitoring");
  }

  async function startRecording() {
    // Record straight from idle by opening the mic first; if we're already
    // monitoring, just attach the recorder to the live stream.
    if (!streamRef.current) await openMic();

    const recorder = new MediaRecorder(streamRef.current!);
    mediaRecorderRef.current = recorder;
    const startedAt = Date.now();
    recordStartRef.current = startedAt;
    setElapsedMs(0);
    recordingWaveRef.current = [];
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(chunks, {
        type: recorder.mimeType || "audio/webm",
      });
      const recording: Recording = {
        id: crypto.randomUUID(),
        createdAt: startedAt,
        durationMs: Date.now() - startedAt,
        url: URL.createObjectURL(blob),
      };
      // Newest first.
      setRecordings((prev) => [recording, ...prev]);
      selectRecording(recording);
      const data: RecordingData = {
        id: recording.id,
        createdAt: recording.createdAt,
        durationMs: recording.durationMs,
        blob,
      };
      storage.save(data);
      setElapsedMs(0);
    };
    recorder.start();
    setStatus("recording");
  }

  // Stop capturing but leave the mic + graph running, so you can keep going.
  function stopRecording() {
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
    setStatus("monitoring");
  }

  async function startPlayback(url: string) {
    // Playback drives its own audio graph, so release the mic first.
    teardown();

    const audio = new Audio(url);
    audioElRef.current = audio;

    const audioContext = new AudioContext();
    audioContextRef.current = audioContext;
    await audioContext.resume();

    // Route the clip through an analyser (for the graph) and on to the speakers.
    const source = audioContext.createMediaElementSource(audio);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    analyser.connect(audioContext.destination);

    audio.onended = () => endPlayback();

    const updatePlayhead = () => {
      if (audio.duration && selectedRecording) {
        playheadRef.current = audio.currentTime / audio.duration;
        renderWaveform();
      }
      if (!isPaused) {
        waveformRafRef.current = requestAnimationFrame(updatePlayhead);
      }
    };

    runAnalysis(analyser, audioContext.sampleRate);
    await audio.play();
    setStatus("playing");
    setIsPaused(false);
    updatePlayhead();
  }

  function pausePlayback() {
    audioElRef.current?.pause();
    setIsPaused(true);
    if (waveformRafRef.current !== null) {
      cancelAnimationFrame(waveformRafRef.current);
      waveformRafRef.current = null;
    }
  }

  async function resumePlayback() {
    if (audioElRef.current) {
      await audioElRef.current.play();
      setIsPaused(false);
      const audio = audioElRef.current;
      const updatePlayhead = () => {
        if (audio.duration && selectedRecording) {
          playheadRef.current = audio.currentTime / audio.duration;
          renderWaveform();
        }
        if (!isPaused) {
          waveformRafRef.current = requestAnimationFrame(updatePlayhead);
        }
      };
      updatePlayhead();
    }
  }

  // When a take finishes playing, keep it LOADED -- its pitch contour stays on
  // the graph and the transport shows Play to replay -- rather than wiping back
  // to a blank live monitor. Use the × close button to dismiss it back to the mic.
  function endPlayback() {
    teardown();
    if (waveformRafRef.current !== null) {
      cancelAnimationFrame(waveformRafRef.current);
      waveformRafRef.current = null;
    }
    setStatus("idle");
    setIsPaused(false);
    playheadRef.current = 0;
    setPlaybackMs(0);
    renderWaveform();
  }

  // Dismiss the loaded take and return to live mic monitoring.
  async function closeRecording() {
    teardown();
    if (waveformRafRef.current !== null) {
      cancelAnimationFrame(waveformRafRef.current);
      waveformRafRef.current = null;
    }
    setSelectedRecording(null);
    setWaveformPeaks(null);
    peaksRef.current = null;
    playheadRef.current = 0;
    setPlaybackMs(0);
    setIsPaused(false);
    try {
      await startMonitor();
    } catch {
      setStatus("idle");
    }
  }

  // Play a take and switch to the practice view so its pitch contour is visible.
  function playRecording(rec: Recording) {
    setView("practice");
    selectRecording(rec);
    startPlayback(rec.url);
  }

  async function deleteRecording(rec: Recording) {
    if (!confirm("Delete this recording?")) return;
    await storage.delete(rec.id);
    URL.revokeObjectURL(rec.url);
    setRecordings((prev) => prev.filter((r) => r.id !== rec.id));
    if (selectedRecording?.id === rec.id) {
      setSelectedRecording(null);
      setWaveformPeaks(null);
      peaksRef.current = null;
      playheadRef.current = 0;
    }
  }

  useEffect(() => {
    if (status === "recording") {
      const interval = setInterval(() => {
        setElapsedMs(Date.now() - recordStartRef.current);
      }, 100);
      return () => clearInterval(interval);
    }
  }, [status]);

  // Mirror the playback position into state (throttled) so the transport's
  // left time updates without re-rendering every animation frame.
  useEffect(() => {
    if (status === "playing" && !isPaused) {
      const interval = setInterval(() => {
        const audio = audioElRef.current;
        if (audio) setPlaybackMs(audio.currentTime * 1000);
      }, 100);
      return () => clearInterval(interval);
    }
  }, [status, isPaused]);

  useEffect(() => {
    // Compute on the Recordings view (mobile) or whenever the desktop sidebar
    // is visible — otherwise the sidebar rows would never get their thumbnails.
    if (view !== "recordings" && !isDesktop) return;
    recordings.forEach(async (rec) => {
      if (!computedPeaksRef.current.has(rec.id)) {
        computedPeaksRef.current.add(rec.id);
        const peaks = await computeWaveformPeaks(rec.url);
        setRecordingPeaks((prev) => {
          const next = new Map(prev);
          next.set(rec.id, peaks);
          return next;
        });
      }
    });
  }, [view, recordings, isDesktop]);

  // Track wide-viewport (desktop) layout reactively. On desktop the Recordings
  // archive lives in the sidebar, so the full-page "recordings" view is folded
  // into "practice" via `effectiveView` (below) rather than by mutating `view`.
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const progressStats = computeProgressStats(recordings);
  const groupedRecordings = groupRecordingsByDate(recordings);

  // Single source of truth for the transport bar. Derived from the existing
  // engine state so the audio wiring is untouched (see TODO.md §1):
  //   monitoring (mic live, armed) -> idle  ·  paused/playing split on isPaused
  //   cold with a take selected    -> loaded (ready to replay)
  const transportState: "idle" | "recording" | "loaded" | "playing" | "paused" =
    status === "recording"
      ? "recording"
      : status === "playing"
      ? (isPaused ? "paused" : "playing")
      : status === "monitoring"
      ? "idle"
      : selectedRecording
      ? "loaded"
      : "idle";
  // Mic is open and ready to record (vs. cold idle, where the graph overlay
  // is the arm gesture and Record is disabled).
  const armed = status === "monitoring";
  const totalMs = selectedRecording?.durationMs ?? 0;

  // On desktop the Recordings archive is the sidebar, so the full-page
  // "recordings" view collapses into "practice" for rendering purposes.
  const effectiveView = isDesktop && view === "recordings" ? "practice" : view;

  function renderRecordingsList() {
    if (recordings.length === 0) {
      return (
        <div className="list-empty">
          No recordings yet. Start practicing to capture one.
        </div>
      );
    }
    return groupedRecordings.map((group) => (
      <div key={group.label} className="recordings-group">
        <div className="recordings-date-header">{group.label}</div>
        {group.recordings.map((rec) => {
          const peaks = recordingPeaks.get(rec.id);
          const isSelected = selectedRecording?.id === rec.id;
          return (
            <div key={rec.id} className={`recording-row${isSelected ? " recording-row-selected" : ""}`}>
              <button
                className="recording-row-play"
                onClick={() => playRecording(rec)}
              >
                <div className="recording-info">
                  <span className="recording-time">
                    {formatTime(rec.createdAt)}
                  </span>
                  <span className="recording-duration">
                    {formatDuration(rec.durationMs)}
                  </span>
                </div>
              </button>
              {peaks && (
                <div className="waveform-thumbnail">
                  {Array.from({ length: 20 }, (_, i) => {
                    const peakIndex = Math.floor(
                      (i * peaks.length) / 20,
                    );
                    const height = Math.max(
                      4,
                      peaks[peakIndex] * 100,
                    );
                    return (
                      <div
                        key={i}
                        className="waveform-bar"
                        style={{ height: `${height}%` }}
                      />
                    );
                  })}
                </div>
              )}
              <button
                className="recording-row-delete"
                onClick={() =>
                  deleteRecording(rec)}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
    ));
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-header">
          <span className="sidebar-brand">vox</span>
        </div>
        <nav className="sidebar-nav">
          <button
            className={`sidebar-nav-btn${effectiveView === "practice" ? " sidebar-nav-btn-active" : ""}`}
            onClick={() => setView("practice")}
          >
            Practice
          </button>
          <button
            className={`sidebar-nav-btn${effectiveView === "progress" ? " sidebar-nav-btn-active" : ""}`}
            onClick={() => setView("progress")}
          >
            Progress
          </button>
        </nav>
        <div className="sidebar-recordings">
          <div className="sidebar-recordings-header">Recordings</div>
          <div className="sidebar-recordings-list">
            {renderRecordingsList()}
          </div>
        </div>
      </aside>
      <div className="main-pane">
      <header className="header">
        {effectiveView === "practice" && (
          <>
            <h1 className="header-title">Practice</h1>
            {(status === "monitoring" || status === "recording") && (
              <span className="header-live">
                <span className="live-dot" /> live
              </span>
            )}
          </>
        )}
        {effectiveView === "recordings" && (
          <>
            <h1 className="header-title">Recordings</h1>
            <button
              className="header-progress-btn"
              onClick={() => setView("progress")}
            >
              <svg
                viewBox="0 0 20 20"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <rect x="3" y="10" width="3" height="7" rx="0.5" />
                <rect x="8.5" y="6" width="3" height="11" rx="0.5" />
                <rect x="14" y="3" width="3" height="14" rx="0.5" />
              </svg>
              Progress
            </button>
          </>
        )}
        {effectiveView === "progress" && (
          <>
            <button
              className="header-back-btn"
              onClick={() => setView("recordings")}
            >
              <svg
                viewBox="0 0 20 20"
                width="20"
                height="20"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M13 4L7 10L13 16" />
              </svg>
            </button>
            <h1 className="header-title">Progress</h1>
            <span className="header-range">2 weeks</span>
          </>
        )}
      </header>

      <div className="content">
        {
          /* Practice view stays mounted (display toggle) so the canvas keeps its
          size and the live loop never draws to a torn-down canvas. */
        }
        <div
          className="practice-view"
          style={{ display: effectiveView === "practice" ? undefined : "none" }}
        >
          <div className="stats-card">
            <div className="stats-col">
              <div className="stats-value">
                {(() => {
                  const note = pitch > 0 ? noteFromPitch(pitch) : null;
                  const inTune = note ? Math.abs(note.cents) <= 5 : false;
                  return note
                    ? (
                      <span style={{ color: inTune ? "#2e9e4f" : "#111" }}>
                        {note.name}
                      </span>
                    )
                    : (
                      "—"
                    );
                })()}
              </div>
              <div className="stats-label">current</div>
            </div>
            <div className="stats-divider" />
            <div className="stats-col">
              <div className="stats-value">{formatDuration(elapsedMs)}</div>
              <div className="stats-label">elapsed</div>
            </div>
          </div>

          <div className="pitch-graph-container" ref={graphRef}>
            <canvas ref={canvasRef} />
            {status === "idle" && !selectedRecording && (
              <button className="graph-overlay" onClick={startMonitor}>
                <svg viewBox="0 0 100 100" className="graph-overlay-icon">
                  <polygon points="30,20 30,80 80,50" fill="currentColor" />
                </svg>
              </button>
            )}
          </div>

          <div className="transport">
            <div className="transport-waveform">
              {transportState === "idle"
                ? <div className="wf-flat" />
                : transportState === "recording"
                ? <canvas ref={liveWaveformCanvasRef} className="transport-live-waveform" />
                : (
                  <>
                    <button
                      className="transport-waveform-btn"
                      onClick={handleWaveformClick}
                      onMouseDown={handleWaveformPointerDown}
                      onMouseMove={handleWaveformPointerMove}
                      onMouseUp={handleWaveformPointerUp}
                      onMouseLeave={handleWaveformPointerUp}
                      onTouchStart={handleWaveformPointerDown}
                      onTouchMove={handleWaveformPointerMove}
                      onTouchEnd={handleWaveformPointerUp}
                    >
                      <canvas ref={waveformCanvasRef} />
                    </button>
                    <button
                      className="transport-close-btn"
                      onClick={closeRecording}
                      aria-label="Close recording"
                    >
                      <svg
                        viewBox="0 0 20 20"
                        width="18"
                        height="18"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                      >
                        <path d="M5 5l10 10M15 5L5 15" />
                      </svg>
                    </button>
                  </>
                )}
            </div>

            <div className="transport-row">
              <span className="transport-time">
                {transportState === "recording"
                  ? (
                    <span className="rec-meta">
                      <span className="rec-blink" />
                      {formatDuration(elapsedMs)}
                    </span>
                  )
                  : transportState === "playing" || transportState === "paused"
                  ? formatDuration(playbackMs)
                  : "0:00"}
              </span>

              <div className="transport-center">
                {transportState === "idle" && (
                  <button
                    className="transport-btn"
                    onClick={startRecording}
                    disabled={!armed}
                    aria-label="Record"
                  >
                    <TransportGlyph type="record" />
                  </button>
                )}
                {transportState === "recording" && (
                  <button
                    className="transport-btn"
                    onClick={stopRecording}
                    aria-label="Stop"
                  >
                    <TransportGlyph type="stop" />
                  </button>
                )}
                {transportState === "loaded" && (
                  <button
                    className="transport-btn"
                    onClick={() =>
                      selectedRecording && playRecording(selectedRecording)}
                    aria-label="Play"
                  >
                    <TransportGlyph type="play" />
                  </button>
                )}
                {transportState === "playing" && (
                  <button
                    className="transport-btn"
                    onClick={pausePlayback}
                    aria-label="Pause"
                  >
                    <TransportGlyph type="pause" />
                  </button>
                )}
                {transportState === "paused" && (
                  <button
                    className="transport-btn"
                    onClick={resumePlayback}
                    aria-label="Play"
                  >
                    <TransportGlyph type="play" />
                  </button>
                )}
              </div>

              <span className="transport-time right">
                {transportState === "idle"
                  ? "0:00"
                  : transportState === "recording"
                  ? ""
                  : formatDuration(totalMs)}
              </span>
            </div>
          </div>
        </div>

        {effectiveView === "recordings" && (
          <div className="recordings-view">
            {renderRecordingsList()}
          </div>
        )}

        {effectiveView === "progress" && (
          <div className="progress-view">
            <div className="progress-stats">
              <div className="progress-stat">
                <div className="progress-stat-value">
                  {progressStats.sessionsThisWeek}
                </div>
                <div className="progress-stat-label">sessions this week</div>
              </div>
              <div className="progress-stat">
                <div className="progress-stat-value">
                  {progressStats.streak}
                  <span className="progress-stat-unit">days</span>
                </div>
                <div className="progress-stat-label">streak</div>
              </div>
              <div className="progress-stat progress-stat-desktop">
                <div className="progress-stat-value">
                  {recordings.length}
                </div>
                <div className="progress-stat-label">sessions total</div>
              </div>
            </div>

            <div className="bar-chart-container">
              <div className="bar-chart">
                {(() => {
                  const maxCount = Math.max(
                    1,
                    ...progressStats.dailySessions.map((d) => d.count),
                  );
                  return progressStats.dailySessions.map((day, i) => (
                    <div key={i} className="bar-chart-bar-container">
                      <div
                        className="bar-chart-bar"
                        style={{
                          height: day.count > 0
                            ? `${Math.max(8, (day.count / maxCount) * 100)}%`
                            : "4px",
                        }}
                      />
                    </div>
                  ));
                })()}
              </div>
              <div className="bar-chart-labels">
                <span>2 wks ago</span>
                <span>today</span>
              </div>
            </div>
          </div>
        )}
      </div>

      <nav className="tab-bar">
        <button
          className={`tab ${effectiveView === "practice" ? "tab-active" : ""}`}
          onClick={() => setView("practice")}
        >
          <svg
            viewBox="0 0 24 24"
            className="tab-icon"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M2 12C6 4 10 4 12 12C14 20 18 20 22 12" />
          </svg>
          Practice
        </button>
        <button
          className={`tab ${
            effectiveView === "recordings" || effectiveView === "progress" ? "tab-active" : ""
          }`}
          onClick={() => setView("recordings")}
        >
          <svg
            viewBox="0 0 24 24"
            className="tab-icon"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <line x1="4" y1="6" x2="20" y2="6" />
            <line x1="4" y1="12" x2="20" y2="12" />
            <line x1="4" y1="18" x2="20" y2="18" />
          </svg>
          Recordings
        </button>
      </nav>
      </div>
    </div>
  );
}

export default App;
