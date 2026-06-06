import type { View } from "../types";

interface TabBarProps {
  effectiveView: View;
  onSetView: (view: View) => void;
}

export function TabBar({ effectiveView, onSetView }: TabBarProps) {
  return (
    <nav className="tab-bar">
      <button
        className={`tab ${effectiveView === "practice" ? "tab-active" : ""}`}
        onClick={() => onSetView("practice")}
      >
        <svg
          viewBox="0 0 24 24"
          className="tab-icon"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <path d="M2 12C6 4 10 4 12 12C14 20 18 20 22 12" />
        </svg>
        Practice
      </button>
      <button
        className={`tab ${
          effectiveView === "recordings" || effectiveView === "progress" ? "tab-active" : ""
        }`}
        onClick={() => onSetView("recordings")}
      >
        <svg
          viewBox="0 0 24 24"
          className="tab-icon"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <line x1="4" y1="6" x2="20" y2="6" />
          <line x1="4" y1="12" x2="20" y2="12" />
          <line x1="4" y1="18" x2="20" y2="18" />
        </svg>
        Recordings
      </button>
    </nav>
  );
}
