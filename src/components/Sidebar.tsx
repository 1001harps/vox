import type { Recording, View } from "../types";
import { formatDuration, formatTime } from "../utils/format";

interface RecordingsGroup {
  label: string;
  recordings: Recording[];
}

interface SidebarProps {
  effectiveView: View;
  groupedRecordings: RecordingsGroup[];
  recordingPeaks: Map<string, Float32Array>;
  selectedRecording: Recording | null;
  onSetView: (view: View) => void;
  onPlayRecording: (rec: Recording) => void;
  onDeleteRecording: (rec: Recording) => void;
}

function RecordingsList({
  groupedRecordings,
  recordingPeaks,
  selectedRecording,
  onPlayRecording,
  onDeleteRecording,
}: Omit<SidebarProps, "effectiveView" | "onSetView">) {
  if (groupedRecordings.length === 0) {
    return (
      <div className="list-empty">
        No recordings yet. Start practicing to capture one.
      </div>
    );
  }

  return (
    <>
      {groupedRecordings.map((group) => (
        <div key={group.label} className="recordings-group">
          <div className="recordings-date-header">{group.label}</div>
          {group.recordings.map((rec) => {
            const peaks = recordingPeaks.get(rec.id);
            const isSelected = selectedRecording?.id === rec.id;
            return (
              <div key={rec.id} className={`recording-row${isSelected ? " recording-row-selected" : ""}`}>
                <button
                  className="recording-row-play"
                  onClick={() => onPlayRecording(rec)}
                >
                  <div className="recording-info">
                    <span className="recording-time">
                      {formatTime(rec.createdAt)}
                    </span>
                    <span className="recording-duration">
                      {formatDuration(rec.durationMs)}
                    </span>
                  </div>
                </button>
                {peaks && (
                  <div className="waveform-thumbnail">
                    {Array.from({ length: 20 }, (_, i) => {
                      const peakIndex = Math.floor(
                        (i * peaks.length) / 20,
                      );
                      const height = Math.max(
                        4,
                        peaks[peakIndex] * 100,
                      );
                      return (
                        <div
                          key={i}
                          className="waveform-bar"
                          style={{ height: `${height}%` }}
                        />
                      );
                    })}
                  </div>
                )}
                <button
                  className="recording-row-delete"
                  onClick={() => onDeleteRecording(rec)}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      ))}
    </>
  );
}

export function Sidebar({
  effectiveView,
  groupedRecordings,
  recordingPeaks,
  selectedRecording,
  onSetView,
  onPlayRecording,
  onDeleteRecording,
}: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-brand">vox</span>
      </div>
      <nav className="sidebar-nav">
        <button
          className={`sidebar-nav-btn${effectiveView === "practice" ? " sidebar-nav-btn-active" : ""}`}
          onClick={() => onSetView("practice")}
        >
          Practice
        </button>
        <button
          className={`sidebar-nav-btn${effectiveView === "progress" ? " sidebar-nav-btn-active" : ""}`}
          onClick={() => onSetView("progress")}
        >
          Progress
        </button>
      </nav>
      <div className="sidebar-recordings">
        <div className="sidebar-recordings-header">Recordings</div>
        <div className="sidebar-recordings-list">
          <RecordingsList
            groupedRecordings={groupedRecordings}
            recordingPeaks={recordingPeaks}
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
