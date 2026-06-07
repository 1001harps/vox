import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, type ReactNode } from "react";
import {
  isBlackKey,
  LANES,
  MAX_MIDI,
  MIN_MIDI,
  NOTE_NAMES,
  noteFromPitch,
  WINDOW_MS,
} from "../audio/pitch";
import type { AudioEngine } from "../audio/engine";
import type { HistoryBuffer } from "../types";

export interface PitchGraphHandle {
  render: () => void;
}

interface PitchGraphProps {
  historyRef: React.RefObject<HistoryBuffer>;
  engine: AudioEngine;
  children?: ReactNode;
}

export const PitchGraph = forwardRef<PitchGraphHandle, PitchGraphProps>(
  function PitchGraph({ historyRef, engine, children }, ref) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const gridCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const holdingRef = useRef(false);
    const holdingMidiRef = useRef<number | null>(null);

    const drawGridToCache = useCallback((width: number, height: number) => {
      if (width <= 0 || height <= 0) return;
      let grid = gridCanvasRef.current;
      if (!grid) {
        grid = document.createElement("canvas");
        gridCanvasRef.current = grid;
      }
      const dpr = window.devicePixelRatio || 1;
      grid.width = width * dpr;
      grid.height = height * dpr;
      const ctx = grid.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const laneH = height / LANES;

      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, width, height);

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

        if (!isBlackKey(midi)) {
          const name = NOTE_NAMES[((midi % 12) + 12) % 12];
          const isC = midi % 12 === 0;
          ctx.fillStyle = isC ? "#555" : "#aaa";
          ctx.font = `${isC ? 600 : 400} 11px system-ui, sans-serif`;
          ctx.fillText(`${name}${Math.floor(midi / 12) - 1}`, 6, mid);
        }
      }

      ctx.strokeStyle = "#ddd";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(width * 0.75, 0);
      ctx.lineTo(width * 0.75, height);
      ctx.stroke();
    }, []);

    const sizeCanvas = useCallback(() => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = container.clientWidth * dpr;
      canvas.height = container.clientHeight * dpr;
      canvas.getContext("2d")?.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawGridToCache(container.clientWidth, container.clientHeight);
    }, [drawGridToCache]);

    const renderGraph = useCallback(() => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;

      const dpr = window.devicePixelRatio || 1;
      const width = canvas.width / dpr;
      const height = canvas.height / dpr;
      const laneH = height / LANES;
      const midiToY = (midi: number) => (MAX_MIDI - midi + 0.5) * laneH;
      const now = performance.now();
      const timeToX = (t: number) => width * 0.75 * (1 - (now - t) / WINDOW_MS);

      const grid = gridCanvasRef.current;
      if (grid && grid.width > 0 && grid.height > 0) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(grid, 0, 0);
        ctx.restore();
      }

      const history = historyRef.current;
      if (!history) return;

      const lastIdx = history.samples.length - 1;
      const last = lastIdx >= history.start ? history.samples[lastIdx] : undefined;
      if (last && !Number.isNaN(last.midi)) {
        const midi = Math.min(MAX_MIDI, Math.max(MIN_MIDI, Math.round(last.midi)));
        const rowTop = (MAX_MIDI - midi) * laneH;
        ctx.fillStyle = "rgba(46, 158, 79, 0.12)";
        ctx.fillRect(0, rowTop, width, laneH);
      }

      ctx.strokeStyle = "#333";
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.beginPath();
      let penDown = false;
      for (let i = history.start; i < history.samples.length; i++) {
        const s = history.samples[i];
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

      if (last && !Number.isNaN(last.midi)) {
        const freq = 440 * Math.pow(2, (last.midi - 69) / 12);
        const inTune = Math.abs(noteFromPitch(freq).cents) <= 5;
        const midi = Math.min(MAX_MIDI, Math.max(MIN_MIDI, last.midi));
        ctx.fillStyle = inTune ? "#2e9e4f" : "#111";
        ctx.beginPath();
        ctx.arc(timeToX(last.t), midiToY(midi), 6, 0, Math.PI * 2);
        ctx.fill();
      }
    }, [historyRef]);

    useImperativeHandle(ref, () => ({
      render: renderGraph,
    }), [renderGraph]);

    useEffect(() => {
      sizeCanvas();
      renderGraph();
      const container = containerRef.current;
      if (!container) return;
      const ro = new ResizeObserver(() => {
        sizeCanvas();
        renderGraph();
      });
      ro.observe(container);
      return () => ro.disconnect();
    }, [sizeCanvas, renderGraph]);

    const yToMidi = useCallback((clientY: number): number | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const y = clientY - rect.top;
      const laneH = rect.height / LANES;
      const row = Math.floor(y / laneH);
      const midi = MAX_MIDI - row;
      if (midi < MIN_MIDI || midi > MAX_MIDI) return null;
      return midi;
    }, []);

    const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
      const midi = yToMidi(e.clientY);
      if (midi === null) return;
      holdingRef.current = true;
      holdingMidiRef.current = midi;
      (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
      engine.playTone(midi);
    }, [engine, yToMidi]);

    const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!holdingRef.current) return;
      const midi = yToMidi(e.clientY);
      if (midi === null || midi === holdingMidiRef.current) return;
      holdingMidiRef.current = midi;
      engine.playTone(midi);
    }, [engine, yToMidi]);

    const handlePointerUp = useCallback(() => {
      if (!holdingRef.current) return;
      holdingRef.current = false;
      holdingMidiRef.current = null;
      engine.stopTone();
    }, [engine]);

    return (
      <div className="pitch-graph-container" ref={containerRef}>
        <canvas
          ref={canvasRef}
          style={{ touchAction: "none" }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        />
        {children}
      </div>
    );
  }
);
