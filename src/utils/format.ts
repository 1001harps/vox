import type { Recording } from "../types";

export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getHours().toString().padStart(2, "0")}:${
    d.getMinutes().toString().padStart(2, "0")
  }`;
}

export function getStartOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function groupRecordingsByDate(
  recordings: Recording[],
): { label: string; recordings: Recording[] }[] {
  const now = Date.now();
  const todayStart = getStartOfDay(now);
  const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;
  const groups: Map<string, Recording[]> = new Map();

  for (const rec of recordings) {
    const recDay = getStartOfDay(rec.createdAt);
    let label: string;
    if (recDay === todayStart) label = "Today";
    else if (recDay === yesterdayStart) label = "Yesterday";
    else {
      const d = new Date(rec.createdAt);
      label = d.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      });
    }
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(rec);
  }

  return Array.from(groups, ([label, recs]) => ({ label, recordings: recs }));
}
