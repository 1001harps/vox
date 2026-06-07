import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";

export interface LiveWaveformHandle {
  drawFrame: (peak: number) => void;
}

export const LiveWaveform = forwardRef<LiveWaveformHandle>(
  function LiveWaveform(_props, ref) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const waveRef = useRef<number[]>([]);

    const sizeCanvas = useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = canvas.clientWidth * dpr;
      canvas.height = canvas.clientHeight * dpr;
      canvas.getContext("2d")?.setTransform(dpr, 0, 0, dpr, 0, 0);
    }, []);

    const drawFrame = useCallback((peak: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.width / dpr;
      const height = canvas.height / dpr;

      const wave = waveRef.current;
      wave.push(peak);

      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = "#555";

      const slot = 3; // px per bar (bar + gap)
      const barW = 2;
      const maxBars = Math.max(1, Math.floor(width / slot));

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

      const midY = height / 2;
      for (let i = 0; i < bars.length; i++) {
        const h = Math.max(1, bars[i] * height);
        ctx.fillRect(i * slot, midY - h / 2, barW, h);
      }
    }, []);

    useImperativeHandle(ref, () => ({
      drawFrame,
    }), [drawFrame]);

    // Reset wave when mounted (new recording)
    useEffect(() => {
      waveRef.current = [];
    }, []);

    useEffect(() => {
      sizeCanvas();
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ro = new ResizeObserver(() => {
        sizeCanvas();
      });
      ro.observe(canvas);
      return () => ro.disconnect();
    }, [sizeCanvas]);

    return <canvas ref={canvasRef} className="transport-live-waveform" />;
  }
);

export interface PlaybackWaveformHandle {
  render: () => void;
}

interface PlaybackWaveformProps {
  peaks: Float32Array | null;
  playheadRef: React.RefObject<number>;
  onSeek: (progress: number) => void;
  // Reports the scrubbed position during a drag (and null on release) so the
  // transport can preview the time at the finger/cursor.
  onScrub?: (progress: number | null) => void;
  // When there's live audio (playing/paused) we seek continuously during the
  // drag; otherwise (a finished take) we only move the visual playhead and
  // commit the seek on release, so playback isn't torn down on every move.
  seekDuringDrag?: boolean;
}

export const PlaybackWaveform = forwardRef<PlaybackWaveformHandle, PlaybackWaveformProps>(
  function PlaybackWaveform({ peaks, playheadRef, onSeek, onScrub, seekDuringDrag = false }, ref) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const isDraggingRef = useRef(false);
    const lastProgressRef = useRef(0);

    const sizeCanvas = useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = canvas.clientWidth * dpr;
      canvas.height = canvas.clientHeight * dpr;
      canvas.getContext("2d")?.setTransform(dpr, 0, 0, dpr, 0, 0);
    }, []);

    const renderWaveform = useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.width / dpr;
      const height = canvas.height / dpr;
      ctx.clearRect(0, 0, width, height);
      if (!peaks || peaks.length === 0) return;

      // Draw as many fixed-width bars as the canvas can hold (matching the live
      // preview's density) rather than squeezing all source peaks into the
      // width — on a narrow canvas that left sub-pixel bars that washed out.
      const slot = 3; // px per bar (bar + gap)
      const barW = 2;
      const bars = Math.max(1, Math.min(peaks.length, Math.floor(width / slot)));
      const midY = height / 2;
      const progress = playheadRef.current ?? 0;

      for (let i = 0; i < bars; i++) {
        // Aggregate the source peaks that fall into this bar.
        const start = Math.floor((i * peaks.length) / bars);
        const end = Math.floor(((i + 1) * peaks.length) / bars);
        let peak = 0;
        for (let j = start; j < end; j++) {
          if (peaks[j] > peak) peak = peaks[j];
        }
        const barHeight = peak * height;
        const x = i * slot;
        ctx.fillStyle = i / bars <= progress ? "#333" : "#ccc";
        ctx.fillRect(x, midY - barHeight / 2, barW, barHeight);
      }
    }, [peaks, playheadRef]);

    useImperativeHandle(ref, () => ({
      render: renderWaveform,
    }), [renderWaveform]);

    useEffect(() => {
      sizeCanvas();
      renderWaveform();
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ro = new ResizeObserver(() => {
        sizeCanvas();
        renderWaveform();
      });
      ro.observe(canvas);
      return () => ro.disconnect();
    }, [sizeCanvas, renderWaveform]);

    function getProgress(clientX: number): number {
      const canvas = canvasRef.current;
      if (!canvas) return 0;
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      return Math.max(0, Math.min(1, x / rect.width));
    }

    // Preview a scrub position: always report the time and move the visual
    // playhead. With live audio we seek immediately; otherwise we just paint
    // the playhead and defer the actual seek to release.
    function preview(progress: number) {
      lastProgressRef.current = progress;
      onScrub?.(progress);
      if (seekDuringDrag) {
        onSeek(progress);
      } else {
        playheadRef.current = progress;
        renderWaveform();
      }
    }

    function handlePointerDown(e: React.MouseEvent | React.TouchEvent) {
      isDraggingRef.current = true;
      const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
      preview(getProgress(clientX));
    }

    function handlePointerMove(e: React.MouseEvent | React.TouchEvent) {
      if (!isDraggingRef.current) return;
      const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
      preview(getProgress(clientX));
    }

    function handlePointerUp() {
      if (!isDraggingRef.current) return;
      isDraggingRef.current = false;
      // Commit the deferred seek for a finished take (live audio was already
      // tracking during the drag).
      if (!seekDuringDrag) onSeek(lastProgressRef.current);
      onScrub?.(null);
    }

    return (
      <button
        className="transport-waveform-btn"
        onMouseDown={handlePointerDown}
        onMouseMove={handlePointerMove}
        onMouseUp={handlePointerUp}
        onMouseLeave={handlePointerUp}
        onTouchStart={handlePointerDown}
        onTouchMove={handlePointerMove}
        onTouchEnd={handlePointerUp}
      >
        <canvas ref={canvasRef} />
      </button>
    );
  }
);
