import type { Recording } from "../types";
import { getStartOfDay } from "./format";

export function computeProgressStats(recordings: Recording[]) {
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const todayStart = getStartOfDay(now);

  let sessionsThisWeek = 0;
  const recordingDays = new Set<number>();
  const dailyCounts = new Map<number, number>();

  for (const r of recordings) {
    if (r.createdAt >= weekAgo) sessionsThisWeek++;
    const dayStart = getStartOfDay(r.createdAt);
    recordingDays.add(dayStart);
    dailyCounts.set(dayStart, (dailyCounts.get(dayStart) || 0) + 1);
  }

  let streak = 0;
  let day = todayStart;
  if (!recordingDays.has(day)) {
    day -= 24 * 60 * 60 * 1000;
  }
  while (recordingDays.has(day)) {
    streak++;
    day -= 24 * 60 * 60 * 1000;
  }

  const dailySessions: { label: string; count: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const dayStart = getStartOfDay(now - i * 24 * 60 * 60 * 1000);
    let label = "";
    if (i === 0) label = "today";
    else if (i === 13) label = "2 wks ago";
    dailySessions.push({ label, count: dailyCounts.get(dayStart) || 0 });
  }

  return { sessionsThisWeek, streak, dailySessions };
}
