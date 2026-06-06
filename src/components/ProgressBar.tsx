interface ProgressStats {
  sessionsThisWeek: number;
  streak: number;
  dailySessions: { label: string; count: number }[];
}

interface ProgressBarProps {
  stats: ProgressStats;
  totalRecordings: number;
}

export function ProgressBar({ stats, totalRecordings }: ProgressBarProps) {
  const maxCount = Math.max(
    1,
    ...stats.dailySessions.map((d) => d.count),
  );

  return (
    <div className="progress-view">
      <div className="progress-stats">
        <div className="progress-stat">
          <div className="progress-stat-value">
            {stats.sessionsThisWeek}
          </div>
          <div className="progress-stat-label">sessions this week</div>
        </div>
        <div className="progress-stat">
          <div className="progress-stat-value">
            {stats.streak}
            <span className="progress-stat-unit">days</span>
          </div>
          <div className="progress-stat-label">streak</div>
        </div>
        <div className="progress-stat progress-stat-desktop">
          <div className="progress-stat-value">
            {totalRecordings}
          </div>
          <div className="progress-stat-label">sessions total</div>
        </div>
      </div>

      <div className="bar-chart-container">
        <div className="bar-chart">
          {stats.dailySessions.map((day, i) => (
            <div key={i} className="bar-chart-bar-container">
              <div
                className="bar-chart-bar"
                style={{
                  height: day.count > 0
                    ? `${Math.max(8, (day.count / maxCount) * 100)}%`
                    : "4px",
                }}
              />
            </div>
          ))}
        </div>
        <div className="bar-chart-labels">
          <span>2 wks ago</span>
          <span>today</span>
        </div>
      </div>
    </div>
  );
}
