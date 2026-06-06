import { useEffect, useRef, useState } from "react";
import type { Recording } from "../types";
import { computeWaveformPeaks } from "../utils/waveform";

export function useRecordingPeaks(
  recordings: Recording[],
  shouldCompute: boolean,
): Map<string, Float32Array> {
  const [recordingPeaks, setRecordingPeaks] = useState<Map<string, Float32Array>>(
    () => new Map(),
  );
  const computedPeaksRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!shouldCompute) return;
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
    return () => {
      cancelled = true;
    };
  }, [recordings, shouldCompute]);

  return recordingPeaks;
}
