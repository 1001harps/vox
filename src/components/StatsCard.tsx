import { forwardRef } from "react";
import { formatDuration } from "../utils/format";

interface StatsCardProps {
  elapsedMs: number;
}

export const StatsCard = forwardRef<HTMLSpanElement, StatsCardProps>(
  function StatsCard({ elapsedMs }, ref) {
    return (
      <div className="stats-card">
        <div className="stats-col">
          <div className="stats-value">
            <span ref={ref}>{"\u2014"}</span>
          </div>
          <div className="stats-label">current</div>
        </div>
        <div className="stats-divider" />
        <div className="stats-col">
          <div className="stats-value">{formatDuration(elapsedMs)}</div>
          <div className="stats-label">elapsed</div>
        </div>
      </div>
    );
  }
);
