import type { ReactNode } from "react";
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
        return (
          <div key={rec.id} className={`recording-row${isSelected ? " recording-row-selected" : ""}`}>
            <button
              className="recording-row-play"
              onClick={() => onPlayRecording(rec)}
            >
              <div className="recording-info">
                <span className="recording-date">
                  {formatDateLabel(rec.createdAt)}
                </span>
                <span className="recording-time">
                  {formatTime(rec.createdAt)}
                </span>
              </div>
            </button>
            <span className="recording-duration">
              {formatDuration(rec.durationMs)}
            </span>
            <a
              className="recording-row-download"
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
              className="recording-row-delete"
              onClick={() => onDeleteRecording(rec)}
            >
              ×
            </button>
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
