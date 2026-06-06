import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IndexedDBStorage,
  type RecordingData,
  type RecordingStorage,
} from "./storage";
import type { HistoryBuffer, Recording, Status, View } from "./types";
import {
  formatDuration,
  formatTime,
  groupRecordingsByDate,
} from "./utils/format";
import { computeProgressStats } from "./utils/progress";
import { computeWaveformPeaks } from "./utils/waveform";
import { startAnalysis } from "./audio/analysis";
import { PitchGraph, type PitchGraphHandle } from "./components/PitchGraph";
import { LiveWaveform, PlaybackWaveform, type LiveWaveformHandle, type PlaybackWaveformHandle } from "./components/Waveform";

// idle = nothing running, monitoring = live graph only, recording = monitor +
// capture, playing = playing back a recorded clip.

// A saved take. In-memory representation with object URL for playback.

// Which screen is showing.

const storage: RecordingStorage = new IndexedDBStorage();

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
  const pitchDisplayRef = useRef<HTMLSpanElement | null>(null);
  const historyRef = useRef<HistoryBuffer>({ samples: [], start: 0 });

  // Recording capture + playback element.
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const recordStartRef = useRef<number>(0); // ms epoch when capture started
  const analyserRef = useRef<AnalyserNode | null>(null);
  const peaksRef = useRef<Float32Array | null>(null);
  const playheadRef = useRef<number>(0);
  const waveformRafRef = useRef<number | null>(null);
  const [recordingPeaks, setRecordingPeaks] = useState<
    Map<string, Float32Array>
  >(new Map());
  const computedPeaksRef = useRef<Set<string>>(new Set());

  // Component handles for imperative canvas rendering
  const pitchGraphRef = useRef<PitchGraphHandle>(null);
  const liveWaveformRef = useRef<LiveWaveformHandle>(null);
  const playbackWaveformRef = useRef<PlaybackWaveformHandle>(null);

  async function selectRecording(rec: Recording) {
    setSelectedRecording(rec);
    const peaks = await computeWaveformPeaks(rec.url);
    peaksRef.current = peaks;
    setWaveformPeaks(peaks);
    playheadRef.current = 0;
    setPlaybackMs(0);
  }

  function handleWaveformSeek(progress: number) {
    if (!audioElRef.current || !selectedRecording) return;
    audioElRef.current.currentTime = progress * audioElRef.current.duration;
    playheadRef.current = progress;
    playbackWaveformRef.current?.render();
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

  const stopAnalysisRef = useRef<(() => void) | null>(null);

  // The detect-smooth-graph loop, run against any analyser node -- the live mic
  // while recording, or the recorded clip on playback. Identical pitch handling
  // either way, so playback is graphed exactly as if the mic were live.
  const runAnalysis = useCallback(
    (analyser: AnalyserNode, sampleRate: number) => {
      analyserRef.current = analyser;
      stopAnalysisRef.current = startAnalysis(analyser, sampleRate, historyRef, {
        onRenderGraph: () => pitchGraphRef.current?.render(),
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
        onFrame: (_timeData, peak) => liveWaveformRef.current?.drawFrame(peak),
      });
    },
    [],
  );

  // Tear down the audio graph + RAF loop, shared by both record and playback.
  const teardown = useCallback(() => {
    stopAnalysisRef.current?.();
    stopAnalysisRef.current = null;
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
    const pitchEl = pitchDisplayRef.current;
    if (pitchEl) {
      pitchEl.textContent = "\u2014";
      pitchEl.style.color = "#111";
    }
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
        playbackWaveformRef.current?.render();
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
          playbackWaveformRef.current?.render();
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
    playbackWaveformRef.current?.render();
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

          <PitchGraph ref={pitchGraphRef} historyRef={historyRef}>
            {status === "idle" && !selectedRecording && (
              <button className="graph-overlay" onClick={startMonitor}>
                <svg viewBox="0 0 100 100" className="graph-overlay-icon">
                  <polygon points="30,20 30,80 80,50" fill="currentColor" />
                </svg>
              </button>
            )}
          </PitchGraph>

          <div className="transport">
            <div className="transport-waveform">
              {transportState === "idle"
                ? <div className="wf-flat" />
                : transportState === "recording"
                ? <LiveWaveform ref={liveWaveformRef} />
                : (
                  <>
                    <PlaybackWaveform
                      ref={playbackWaveformRef}
                      peaks={waveformPeaks}
                      playheadRef={playheadRef}
                      onSeek={handleWaveformSeek}
                    />
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
