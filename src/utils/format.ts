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

export function formatDate(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export function formatDateLabel(ms: number): string {
  const now = Date.now();
  const todayStart = getStartOfDay(now);
  const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;
  const recDay = getStartOfDay(ms);

  if (recDay === todayStart) return "Today";
  if (recDay === yesterdayStart) return "Yesterday";

  const daysAgo = Math.floor((todayStart - recDay) / (24 * 60 * 60 * 1000));
  if (daysAgo >= 2 && daysAgo <= 6) {
    const d = new Date(ms);
    return d.toLocaleDateString(undefined, { weekday: "long" });
  }

  return formatDate(ms);
}

export function getStartOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
