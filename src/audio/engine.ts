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
  private toneContext: AudioContext | null = null;
  private toneOsc: OscillatorNode | null = null;
  private toneGain: GainNode | null = null;

  private inputDeviceId: string | null = null;

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

  // The preferred microphone. null = let the browser pick the system default.
  // Applied the next time the mic is opened; call restartMic() to switch live.
  setInputDeviceId(deviceId: string | null): void {
    this.inputDeviceId = deviceId;
  }

  async openMic(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: this.inputDeviceId
        ? { deviceId: { exact: this.inputDeviceId } }
        : true,
    });
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

  // Tear down the live mic graph and reopen it with the current input device.
  // Only meaningful while monitoring — the caller gates on status.
  async restartMic(): Promise<void> {
    if (this.stopAnalysis) {
      this.stopAnalysis();
      this.stopAnalysis = null;
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    await this.audioContext?.close();
    this.audioContext = null;
    await this.openMic();
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
    // stop() flushes the final chunk and fires onstop (which creates the take
    // and selects it). The encoded data is already buffered, so stopping the
    // recorder is safe.
    this.mediaRecorder?.stop();
    this.mediaRecorder = null;
    if (this.elapsedInterval !== null) {
      clearInterval(this.elapsedInterval);
      this.elapsedInterval = null;
    }
    // Partial cleanup: close the audio context and analysis but keep the stream
    // alive. Stopping stream tracks on mobile releases the OS mic grant, causing
    // a new permission prompt on the next recording. By holding the stream open,
    // startRecording() can reuse it without re-prompting.
    this.stopTone();
    if (this.toneContext) {
      this.toneContext.close();
      this.toneContext = null;
    }
    if (this.stopAnalysis) {
      this.stopAnalysis();
      this.stopAnalysis = null;
    }
    this.audioContext?.close();
    this.audioContext = null;
    this.callbacks.onPitchClear();
    this.callbacks.onStatusChange("idle");
  }

  async startPlayback(url: string, _selectedRecording: Recording, isPaused: boolean, startProgress = 0): Promise<void> {
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

    // Start from a scrubbed position (e.g. clicking the waveform after a take
    // has finished, when the previous audio element has been torn down). Wait
    // for metadata so the duration is known before mapping progress to time.
    if (startProgress > 0) {
      if (!audio.duration || Number.isNaN(audio.duration)) {
        await new Promise<void>((resolve) => {
          audio.addEventListener("loadedmetadata", () => resolve(), { once: true });
        });
      }
      audio.currentTime = startProgress * audio.duration;
      this.playheadRef.current = startProgress;
    }

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
    this.stopTone();
    if (this.toneContext) {
      this.toneContext.close();
      this.toneContext = null;
    }
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
      // Keep the displayed time in sync — while paused there's no interval
      // running to update it after the scrub settles.
      this.callbacks.onPlaybackMsChange(this.audioElement.currentTime * 1000);
    }
  }

  async playTone(midi: number): Promise<void> {
    this.stopTone();
    if (!this.toneContext) {
      this.toneContext = new AudioContext();
    }
    await this.toneContext.resume();
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    const osc = this.toneContext.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;
    const gain = this.toneContext.createGain();
    gain.gain.value = 0.25;
    osc.connect(gain);
    gain.connect(this.toneContext.destination);
    osc.start();
    this.toneOsc = osc;
    this.toneGain = gain;
  }

  stopTone(): void {
    if (this.toneOsc) {
      try { this.toneOsc.stop(); } catch { /* already stopped */ }
      this.toneOsc.disconnect();
      this.toneOsc = null;
    }
    if (this.toneGain) {
      this.toneGain.disconnect();
      this.toneGain = null;
    }
  }
}
