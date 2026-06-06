import type { View, Status } from "../types";

interface HeaderProps {
  effectiveView: View;
  status: Status;
  onSetView: (view: View) => void;
}

export function Header({ effectiveView, status, onSetView }: HeaderProps) {
  return (
    <header className="header">
      {effectiveView === "practice" && (
        <>
          <h1 className="header-title">Practice</h1>
          {(status === "monitoring" || status === "recording") && (
            <span className="header-live">
              <span className="live-dot" /> live
            </span>
          )}
        </>
      )}
      {effectiveView === "recordings" && (
        <>
          <h1 className="header-title">Recordings</h1>
          <button
            className="header-progress-btn"
            onClick={() => onSetView("progress")}
          >
            <svg
              viewBox="0 0 20 20"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <rect x="3" y="10" width="3" height="7" rx="0.5" />
              <rect x="8.5" y="6" width="3" height="11" rx="0.5" />
              <rect x="14" y="3" width="3" height="14" rx="0.5" />
            </svg>
            Progress
          </button>
        </>
      )}
      {effectiveView === "progress" && (
        <>
          <button
            className="header-back-btn"
            onClick={() => onSetView("recordings")}
          >
            <svg
              viewBox="0 0 20 20"
              width="20"
              height="20"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M13 4L7 10L13 16" />
            </svg>
          </button>
          <h1 className="header-title">Progress</h1>
          <span className="header-range">2 weeks</span>
        </>
      )}
    </header>
  );
}
