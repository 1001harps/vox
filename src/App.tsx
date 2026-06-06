import { useEffect, useMemo, useRef, useState } from "react";
import {
  IndexedDBStorage,
  type RecordingStorage,
} from "./storage";
import type { Recording, View } from "./types";
import {
  formatDuration,
  groupRecordingsByDate,
} from "./utils/format";
import { computeProgressStats } from "./utils/progress";
import { computeWaveformPeaks } from "./utils/waveform";
import { AudioEngine, type Status } from "./audio/engine";
import { PitchGraph, type PitchGraphHandle } from "./components/PitchGraph";
import { type LiveWaveformHandle, type PlaybackWaveformHandle } from "./components/Waveform";
import { Transport } from "./components/Transport";
import { ProgressBar } from "./components/ProgressBar";
import { Sidebar, RecordingsList } from "./components/Sidebar";

const storage: RecordingStorage = new IndexedDBStorage();

function App() {
  const [status, setStatus] = useState<Status>("idle");
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [view, setView] = useState<View>("practice");
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

  const pitchDisplayRef = useRef<HTMLSpanElement | null>(null);
  const peaksRef = useRef<Float32Array | null>(null);
  const [recordingPeaks, setRecordingPeaks] = useState<
    Map<string, Float32Array>
  >(new Map());
  const computedPeaksRef = useRef<Set<string>>(new Set());

  // Component handles for imperative canvas rendering
  const pitchGraphRef = useRef<PitchGraphHandle>(null);
  const liveWaveformRef = useRef<LiveWaveformHandle>(null);
  const playbackWaveformRef = useRef<PlaybackWaveformHandle>(null);

  const engineRef = useRef<AudioEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = new AudioEngine(storage, {
      onStatusChange: setStatus,
      onPausedChange: setIsPaused,
      onElapsedMsChange: setElapsedMs,
      onPlaybackMsChange: setPlaybackMs,
      onRecordingCreated: (recording) => {
        setRecordings((prev) => [recording, ...prev]);
        selectRecording(recording);
      },
      onPitchUpdate: (noteName, inTune) => {
        const pitchEl = pitchDisplayRef.current;
        if (pitchEl) {
          pitchEl.textContent = noteName;
          pitchEl.style.color = inTune ? "#2e9e4f" : "#111";
        }
      },
      onPitchClear: () => {
        const pitchEl = pitchDisplayRef.current;
        if (pitchEl) {
          pitchEl.textContent = "\u2014";
          pitchEl.style.color = "#111";
        }
      },
      onRenderGraph: () => pitchGraphRef.current?.render(),
      onLiveWaveformFrame: (peak) => liveWaveformRef.current?.drawFrame(peak),
      onPlaybackWaveformRender: () => playbackWaveformRef.current?.render(),
    });
  }
  const engine = engineRef.current;

  async function selectRecording(rec: Recording) {
    setSelectedRecording(rec);
    const peaks = await computeWaveformPeaks(rec.url);
    peaksRef.current = peaks;
    setWaveformPeaks(peaks);
    engine.getPlayheadRef().current = 0;
    setPlaybackMs(0);
  }

  function handleWaveformSeek(progress: number) {
    engine.seekTo(progress);
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

  // Clean up the audio graph on unmount.
  useEffect(() => () => engine.teardown(), [engine]);

  async function startMonitor() {
    await engine.startMonitor();
  }

  async function startRecording() {
    await engine.startRecording();
  }

  function stopRecording() {
    engine.stopRecording();
  }

  async function startPlayback(url: string) {
    if (!selectedRecording) return;
    await engine.startPlayback(url, selectedRecording, isPaused);
  }

  function pausePlayback() {
    engine.pausePlayback();
  }

  async function resumePlayback() {
    if (!selectedRecording) return;
    await engine.resumePlayback(selectedRecording);
  }

  // Dismiss the loaded take and return to live mic monitoring.
  async function closeRecording() {
    setSelectedRecording(null);
    setWaveformPeaks(null);
    peaksRef.current = null;
    engine.getPlayheadRef().current = 0;
    setPlaybackMs(0);
    await engine.closeRecording();
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
      engine.getPlayheadRef().current = 0;
    }
  }

  useEffect(() => {
    if (view !== "recordings" && !isDesktop) return;
    let cancelled = false;

    async function computeRemaining() {
      for (const rec of recordings) {
        if (cancelled) return;
        if (computedPeaksRef.current.has(rec.id)) continue;
        computedPeaksRef.current.add(rec.id);
        const peaks = await computeWaveformPeaks(rec.url);
        if (cancelled) return;
        setRecordingPeaks((prev) => {
          const next = new Map(prev);
          next.set(rec.id, peaks);
          return next;
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    computeRemaining();
    return () => { cancelled = true; };
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

  const progressStats = useMemo(() => computeProgressStats(recordings), [recordings]);
  const groupedRecordings = useMemo(() => groupRecordingsByDate(recordings), [recordings]);

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

  return (
    <div className="app">
      <Sidebar
        effectiveView={effectiveView}
        groupedRecordings={groupedRecordings}
        recordingPeaks={recordingPeaks}
        selectedRecording={selectedRecording}
        onSetView={setView}
        onPlayRecording={playRecording}
        onDeleteRecording={deleteRecording}
      />
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
                <span ref={pitchDisplayRef}>{"\u2014"}</span>
              </div>
              <div className="stats-label">current</div>
            </div>
            <div className="stats-divider" />
            <div className="stats-col">
              <div className="stats-value">{formatDuration(elapsedMs)}</div>
              <div className="stats-label">elapsed</div>
            </div>
          </div>

          <PitchGraph ref={pitchGraphRef} historyRef={engine.getHistoryRef()}>
            {status === "idle" && !selectedRecording && (
              <button className="graph-overlay" onClick={startMonitor}>
                <svg viewBox="0 0 100 100" className="graph-overlay-icon">
                  <polygon points="30,20 30,80 80,50" fill="currentColor" />
                </svg>
              </button>
            )}
          </PitchGraph>

          <Transport
            transportState={transportState}
            armed={armed}
            elapsedMs={elapsedMs}
            playbackMs={playbackMs}
            totalMs={totalMs}
            waveformPeaks={waveformPeaks}
            playheadRef={engine.getPlayheadRef()}
            liveWaveformRef={liveWaveformRef}
            playbackWaveformRef={playbackWaveformRef}
            selectedRecording={selectedRecording}
            onSeek={handleWaveformSeek}
            onClose={closeRecording}
            onStartRecording={startRecording}
            onStopRecording={stopRecording}
            onPlayRecording={playRecording}
            onPausePlayback={pausePlayback}
            onResumePlayback={resumePlayback}
          />
        </div>

        {effectiveView === "recordings" && (
          <div className="recordings-view">
            <RecordingsList
              groupedRecordings={groupedRecordings}
              recordingPeaks={recordingPeaks}
              selectedRecording={selectedRecording}
              onPlayRecording={playRecording}
              onDeleteRecording={deleteRecording}
            />
          </div>
        )}

        {effectiveView === "progress" && (
          <ProgressBar
            stats={progressStats}
            totalRecordings={recordings.length}
          />
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
