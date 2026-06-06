import { useRef } from "react";
import type { RecordingStorage } from "../storage";
import type { Recording } from "../types";
import { AudioEngine, type Status } from "../audio/engine";
import type { PitchGraphHandle } from "../components/PitchGraph";
import type { LiveWaveformHandle, PlaybackWaveformHandle } from "../components/Waveform";

interface UseAudioEngineOptions {
  storage: RecordingStorage;
  pitchDisplayRef: React.RefObject<HTMLSpanElement | null>;
  pitchGraphRef: React.RefObject<PitchGraphHandle | null>;
  liveWaveformRef: React.RefObject<LiveWaveformHandle | null>;
  playbackWaveformRef: React.RefObject<PlaybackWaveformHandle | null>;
  onStatusChange: (status: Status) => void;
  onPausedChange: (paused: boolean) => void;
  onElapsedMsChange: (ms: number) => void;
  onPlaybackMsChange: (ms: number) => void;
  onRecordingCreated: (recording: Recording) => void;
}

export function useAudioEngine({
  storage,
  pitchDisplayRef,
  pitchGraphRef,
  liveWaveformRef,
  playbackWaveformRef,
  onStatusChange,
  onPausedChange,
  onElapsedMsChange,
  onPlaybackMsChange,
  onRecordingCreated,
}: UseAudioEngineOptions): AudioEngine {
  const engineRef = useRef<AudioEngine | null>(null);

  if (!engineRef.current) {
    engineRef.current = new AudioEngine(storage, {
      onStatusChange,
      onPausedChange,
      onElapsedMsChange,
      onPlaybackMsChange,
      onRecordingCreated,
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

  return engineRef.current;
}
