import type { Recording, View } from "../types";
import { formatDateLabel, formatDuration, formatTime } from "../utils/format";

interface SidebarProps {
  effectiveView: View;
  recordings: Recording[];
  selectedRecording: Recording | null;
  onSetView: (view: View) => void;
  onPlayRecording: (rec: Recording) => void;
  onDeleteRecording: (rec: Recording) => void;
}

function RecordingsList({
  recordings,
  selectedRecording,
  onPlayRecording,
  onDeleteRecording,
}: Omit<SidebarProps, "effectiveView" | "onSetView">) {
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
  effectiveView,
  recordings,
  selectedRecording,
  onSetView,
  onPlayRecording,
  onDeleteRecording,
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
    </aside>
  );
}

export { RecordingsList };
