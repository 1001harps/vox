import type { RefObject } from "react";
import type { Recording } from "../types";
import { formatDuration } from "../utils/format";
import { TransportGlyph } from "./TransportGlyph";
import { LiveWaveform, PlaybackWaveform, type LiveWaveformHandle, type PlaybackWaveformHandle } from "./Waveform";

export type TransportState = "idle" | "recording" | "loaded" | "playing" | "paused";

interface TransportProps {
  transportState: TransportState;
  elapsedMs: number;
  playbackMs: number;
  totalMs: number;
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
  totalMs,
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
  return (
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
                onSeek={onSeek}
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
              onClick={onStartRecording}
              aria-label="Record"
            >
              <TransportGlyph type="record" />
            </button>
          )}
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

        <span className="transport-time right">
          {transportState === "idle"
            ? "0:00"
            : transportState === "recording"
            ? ""
            : formatDuration(totalMs)}
        </span>

        {(transportState === "loaded" || transportState === "playing" || transportState === "paused") && selectedRecording && (
          <a
            className="transport-download-btn"
            href={selectedRecording.url}
            download={`vox-${selectedRecording.createdAt}.webm`}
            aria-label="Download recording"
          >
            <svg
              viewBox="0 0 20 20"
              width="18"
              height="18"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M10 3v10M6 9l4 4 4-4M4 15h12" />
            </svg>
          </a>
        )}
      </div>
    </div>
  );
}
