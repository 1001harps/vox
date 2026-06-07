import { useState, type RefObject } from "react";
import type { Recording } from "../types";
import { formatDuration } from "../utils/format";
import { TransportGlyph } from "./TransportGlyph";
import { LiveWaveform, PlaybackWaveform, type LiveWaveformHandle, type PlaybackWaveformHandle } from "./Waveform";

export type TransportState = "idle" | "recording" | "loaded" | "playing" | "paused";

interface TransportProps {
  transportState: TransportState;
  elapsedMs: number;
  playbackMs: number;
  waveformPeaks: Float32Array | null;
  playheadRef: RefObject<number>;
  liveWaveformRef: RefObject<LiveWaveformHandle | null>;
  playbackWaveformRef: RefObject<PlaybackWaveformHandle | null>;
  selectedRecording: Recording | null;
  onSeek: (progress: number) => void;
  onClose: () => void;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onPlayRecording: (rec: Recording) => void;
  onPausePlayback: () => void;
  onResumePlayback: () => void;
}

export function Transport({
  transportState,
  elapsedMs,
  playbackMs,
  waveformPeaks,
  playheadRef,
  liveWaveformRef,
  playbackWaveformRef,
  selectedRecording,
  onSeek,
  onClose,
  onStartRecording,
  onStopRecording,
  onPlayRecording,
  onPausePlayback,
  onResumePlayback,
}: TransportProps) {
  // Position being scrubbed (0–1) while dragging the waveform, or null when
  // not scrubbing. Drives the timestamp preview, which then settles back to
  // the live playback time on release.
  const [scrubProgress, setScrubProgress] = useState<number | null>(null);

  // Idle: nothing to scrub or show, so collapse the whole bar to a single
  // floating record button and let the pitch graph fill the freed space.
  if (transportState === "idle") {
    return (
      <div className="transport-idle">
        <button
          className="transport-btn transport-fab"
          onClick={onStartRecording}
          aria-label="Record"
        >
          <TransportGlyph type="record" />
        </button>
      </div>
    );
  }

  return (
    <div className="transport">
      <div className="transport-waveform">
        {transportState === "recording"
          ? <LiveWaveform ref={liveWaveformRef} />
          : (
            <>
              <PlaybackWaveform
                ref={playbackWaveformRef}
                peaks={waveformPeaks}
                playheadRef={playheadRef}
                onSeek={onSeek}
                onScrub={setScrubProgress}
                seekDuringDrag={transportState === "playing" || transportState === "paused"}
              />
              <button
                className="transport-close-btn"
                onClick={onClose}
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
        <div className="transport-controls">
          <div className="transport-side" />
          <div className="transport-center">
          {transportState === "recording" && (
            <button
              className="transport-btn"
              onClick={onStopRecording}
              aria-label="Stop"
            >
              <TransportGlyph type="stop" />
            </button>
          )}
          {transportState === "loaded" && (
            <button
              className="transport-btn"
              onClick={() =>
                selectedRecording && onPlayRecording(selectedRecording)}
              aria-label="Play"
            >
              <TransportGlyph type="play" />
            </button>
          )}
          {transportState === "playing" && (
            <button
              className="transport-btn"
              onClick={onPausePlayback}
              aria-label="Pause"
            >
              <TransportGlyph type="pause" />
            </button>
          )}
          {transportState === "paused" && (
            <button
              className="transport-btn"
              onClick={onResumePlayback}
              aria-label="Play"
            >
              <TransportGlyph type="play" />
            </button>
          )}
        </div>

          {/* Empty right spacer, balancing .transport-side to keep the
              transport button centered. */}
          <div className="transport-actions" />
        </div>

        <span
          className={`transport-time${transportState === "recording" ? " transport-time-recording" : ""}`}
        >
          {transportState === "recording"
            ? (
              <span className="rec-meta">
                <span className="rec-blink" />
                {formatDuration(elapsedMs)}
              </span>
            )
            : scrubProgress !== null && selectedRecording
            ? formatDuration(scrubProgress * selectedRecording.durationMs)
            : transportState === "playing" || transportState === "paused"
            ? formatDuration(playbackMs)
            : "0:00"}
        </span>
      </div>
    </div>
  );
}
