import { startAnalysis } from "./analysis";
import type { RecordingStorage, RecordingData } from "../storage";
import type { HistoryBuffer, Recording } from "../types";

export interface AudioEngineCallbacks {
  onStatusChange: (status: Status) => void;
  onPausedChange: (paused: boolean) => void;
  onElapsedMsChange: (ms: number) => void;
  onPlaybackMsChange: (ms: number) => void;
  onRecordingCreated: (recording: Recording) => void;
  onPitchUpdate: (noteName: string, inTune: boolean) => void;
  onPitchClear: () => void;
  onRenderGraph: () => void;
  onLiveWaveformFrame: (peak: number) => void;
  onPlaybackWaveformRender: () => void;
}

export type Status = "idle" | "monitoring" | "recording" | "playing";

export class AudioEngine {
  private audioContext: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private audioElement: HTMLAudioElement | null = null;
  private stopAnalysis: (() => void) | null = null;
  private waveformRaf: number | null = null;
  private recordStartTime = 0;
  private elapsedInterval: number | null = null;
  private playbackInterval: number | null = null;

  private historyRef: { current: HistoryBuffer } = { current: { samples: [], start: 0 } };
  private playheadRef: { current: number } = { current: 0 };

  private callbacks: AudioEngineCallbacks;
  private storage: RecordingStorage;

  constructor(storage: RecordingStorage, callbacks: AudioEngineCallbacks) {
    this.storage = storage;
    this.callbacks = callbacks;
  }

  getHistoryRef() {
    return this.historyRef;
  }

  getPlayheadRef() {
    return this.playheadRef;
  }

  async openMic(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.stream = stream;

    const audioContext = new AudioContext();
    this.audioContext = audioContext;
    await audioContext.resume();

    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);

    this.stopAnalysis = startAnalysis(analyser, audioContext.sampleRate, this.historyRef, {
      onRenderGraph: this.callbacks.onRenderGraph,
      onPitchUpdate: this.callbacks.onPitchUpdate,
      onPitchClear: this.callbacks.onPitchClear,
      onFrame: (_timeData, peak) => this.callbacks.onLiveWaveformFrame(peak),
    });
  }

  async startMonitor(): Promise<void> {
    await this.openMic();
    this.callbacks.onStatusChange("monitoring");
  }

  async startRecording(): Promise<void> {
    if (!this.stream) await this.openMic();

    const recorder = new MediaRecorder(this.stream!);
    this.mediaRecorder = recorder;
    const startedAt = Date.now();
    this.recordStartTime = startedAt;
    this.callbacks.onElapsedMsChange(0);

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

      this.callbacks.onRecordingCreated(recording);

      const data: RecordingData = {
        id: recording.id,
        createdAt: recording.createdAt,
        durationMs: recording.durationMs,
        blob,
      };
      this.storage.save(data);
      this.callbacks.onElapsedMsChange(0);
    };

    recorder.start();
    this.callbacks.onStatusChange("recording");

    this.elapsedInterval = window.setInterval(() => {
      this.callbacks.onElapsedMsChange(Date.now() - this.recordStartTime);
    }, 100);
  }

  stopRecording(): void {
    this.mediaRecorder?.stop();
    this.mediaRecorder = null;
    if (this.elapsedInterval !== null) {
      clearInterval(this.elapsedInterval);
      this.elapsedInterval = null;
    }
    this.callbacks.onStatusChange("monitoring");
  }

  async startPlayback(url: string, _selectedRecording: Recording, isPaused: boolean): Promise<void> {
    this.teardown();

    const audio = new Audio(url);
    this.audioElement = audio;

    const audioContext = new AudioContext();
    this.audioContext = audioContext;
    await audioContext.resume();

    const source = audioContext.createMediaElementSource(audio);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    analyser.connect(audioContext.destination);

    audio.onended = () => this.endPlayback();

    const updatePlayhead = () => {
      if (audio.duration) {
        this.playheadRef.current = audio.currentTime / audio.duration;
        this.callbacks.onPlaybackWaveformRender();
      }
      if (!isPaused) {
        this.waveformRaf = requestAnimationFrame(updatePlayhead);
      }
    };

    this.stopAnalysis = startAnalysis(analyser, audioContext.sampleRate, this.historyRef, {
      onRenderGraph: this.callbacks.onRenderGraph,
      onPitchUpdate: this.callbacks.onPitchUpdate,
      onPitchClear: this.callbacks.onPitchClear,
      onFrame: (_timeData, peak) => this.callbacks.onLiveWaveformFrame(peak),
    });

    await audio.play();
    this.callbacks.onStatusChange("playing");
    this.callbacks.onPausedChange(false);
    updatePlayhead();

    this.playbackInterval = window.setInterval(() => {
      if (audio) {
        this.callbacks.onPlaybackMsChange(audio.currentTime * 1000);
      }
    }, 100);
  }

  pausePlayback(): void {
    this.audioElement?.pause();
    this.callbacks.onPausedChange(true);
    if (this.waveformRaf !== null) {
      cancelAnimationFrame(this.waveformRaf);
      this.waveformRaf = null;
    }
    if (this.playbackInterval !== null) {
      clearInterval(this.playbackInterval);
      this.playbackInterval = null;
    }
  }

  async resumePlayback(_selectedRecording: Recording): Promise<void> {
    if (this.audioElement) {
      await this.audioElement.play();
      this.callbacks.onPausedChange(false);

      const audio = this.audioElement;
      const isPaused = false;
      const updatePlayhead = () => {
        if (audio.duration) {
          this.playheadRef.current = audio.currentTime / audio.duration;
          this.callbacks.onPlaybackWaveformRender();
        }
        if (!isPaused) {
          this.waveformRaf = requestAnimationFrame(updatePlayhead);
        }
      };
      updatePlayhead();

      this.playbackInterval = window.setInterval(() => {
        if (audio) {
          this.callbacks.onPlaybackMsChange(audio.currentTime * 1000);
        }
      }, 100);
    }
  }

  endPlayback(): void {
    this.teardown();
    if (this.waveformRaf !== null) {
      cancelAnimationFrame(this.waveformRaf);
      this.waveformRaf = null;
    }
    if (this.playbackInterval !== null) {
      clearInterval(this.playbackInterval);
      this.playbackInterval = null;
    }
    this.callbacks.onStatusChange("idle");
    this.callbacks.onPausedChange(false);
    this.playheadRef.current = 0;
    this.callbacks.onPlaybackMsChange(0);
    this.callbacks.onPlaybackWaveformRender();
  }

  async closeRecording(): Promise<void> {
    this.teardown();
    if (this.waveformRaf !== null) {
      cancelAnimationFrame(this.waveformRaf);
      this.waveformRaf = null;
    }
    if (this.playbackInterval !== null) {
      clearInterval(this.playbackInterval);
      this.playbackInterval = null;
    }
    try {
      await this.startMonitor();
    } catch {
      this.callbacks.onStatusChange("idle");
    }
  }

  teardown(): void {
    if (this.stopAnalysis) {
      this.stopAnalysis();
      this.stopAnalysis = null;
    }
    if (this.elapsedInterval !== null) {
      clearInterval(this.elapsedInterval);
      this.elapsedInterval = null;
    }
    if (this.playbackInterval !== null) {
      clearInterval(this.playbackInterval);
      this.playbackInterval = null;
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.audioElement) {
      this.audioElement.pause();
      this.audioElement.onended = null;
      this.audioElement = null;
    }
    this.audioContext?.close();
    this.audioContext = null;
    this.callbacks.onPitchClear();
  }

  seekTo(progress: number): void {
    if (this.audioElement) {
      this.audioElement.currentTime = progress * this.audioElement.duration;
      this.playheadRef.current = progress;
      this.callbacks.onPlaybackWaveformRender();
    }
  }
}
