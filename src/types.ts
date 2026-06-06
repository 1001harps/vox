export type Sample = { t: number; midi: number };

export type Recording = {
  id: string;
  createdAt: number;
  durationMs: number;
  url: string;
};

export type Status = "idle" | "monitoring" | "recording" | "playing";

export type View = "practice" | "recordings" | "progress";

export type HistoryBuffer = { samples: Sample[]; start: number };
