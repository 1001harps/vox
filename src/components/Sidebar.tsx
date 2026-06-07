import { useState, type ReactNode } from "react";
import type { Recording } from "../types";
import { formatDateLabel, formatDuration, formatTime } from "../utils/format";

interface SidebarProps {
  recordings: Recording[];
  selectedRecording: Recording | null;
  onPlayRecording: (rec: Recording) => void;
  onDeleteRecording: (rec: Recording) => void;
  children?: ReactNode;
}

function RecordingsList({
  recordings,
  selectedRecording,
  onPlayRecording,
  onDeleteRecording,
}: SidebarProps) {
  // Rows are collapsed by default; tapping one reveals its actions. Only one
  // row is open at a time (accordion) to keep the list quiet.
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (recordings.length === 0) {
    return (
      <div className="list-empty">
        No recordings yet. Start practicing to capture one.
      </div>
    );
  }

  return (
    <>
      {recordings.map((rec) => {
        const isSelected = selectedRecording?.id === rec.id;
        const isExpanded = expandedId === rec.id;
        return (
          <div
            key={rec.id}
            className={`recording-row${isSelected ? " recording-row-selected" : ""}${isExpanded ? " recording-row-expanded" : ""}`}
          >
            <button
              className="recording-row-main"
              onClick={() =>
                setExpandedId((cur) => (cur === rec.id ? null : rec.id))
              }
              aria-expanded={isExpanded}
            >
              <div className="recording-info">
                <span className="recording-date">
                  {formatDateLabel(rec.createdAt)}
                </span>
                <span className="recording-time">
                  {formatTime(rec.createdAt)}
                </span>
              </div>
              <span className="recording-duration">
                {formatDuration(rec.durationMs)}
              </span>
              <svg
                className="recording-chevron"
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>

            {isExpanded && (
              <div className="recording-actions">
                <button
                  className="recording-action"
                  onClick={() => onPlayRecording(rec)}
                  aria-label="Play recording"
                >
                  <svg viewBox="0 0 24 24" width="18" height="18">
                    <polygon points="8,5 19,12 8,19" fill="currentColor" />
                  </svg>
                </button>
                <a
                  className="recording-action"
                  href={rec.url}
                  download={`vox-${rec.createdAt}.webm`}
                  aria-label="Download recording"
                >
                  <svg
                    viewBox="0 0 20 20"
                    width="18"
                    height="18"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M10 3v10M6 9l4 4 4-4M4 15h12" />
                  </svg>
                </a>
                <button
                  className="recording-action recording-action-delete"
                  onClick={() => onDeleteRecording(rec)}
                  aria-label="Delete recording"
                >
                  <svg
                    viewBox="0 0 24 24"
                    width="18"
                    height="18"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
                  </svg>
                </button>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

export function Sidebar({
  recordings,
  selectedRecording,
  onPlayRecording,
  onDeleteRecording,
  children,
}: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-recordings">
        <div className="sidebar-recordings-header">Recordings</div>
        <div className="sidebar-recordings-list">
          <RecordingsList
            recordings={recordings}
            selectedRecording={selectedRecording}
            onPlayRecording={onPlayRecording}
            onDeleteRecording={onDeleteRecording}
          />
        </div>
      </div>
      {children}
    </aside>
  );
}

export { RecordingsList };
