import { useEffect, useRef, useState } from "react";

interface SettingsProps {
  variant: "desktop" | "mobile";
  devices: MediaDeviceInfo[];
  selectedDeviceId: string | null;
  onSelectDevice: (id: string | null) => void;
  // Called when the panel is opened, so the caller can refresh device labels.
  onOpen?: () => void;
}

function GearIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

interface PanelContentProps {
  devices: MediaDeviceInfo[];
  selectedDeviceId: string | null;
  onSelectDevice: (id: string | null) => void;
  onClose?: () => void;
}

function PanelContent({
  devices,
  selectedDeviceId,
  onSelectDevice,
  onClose,
}: PanelContentProps) {
  return (
    <>
      <div className="settings-header">
        <span className="settings-title">Settings</span>
        {onClose && (
          <button
            className="settings-close"
            onClick={onClose}
            aria-label="Close settings"
          >
            ×
          </button>
        )}
      </div>
      <label className="settings-field">
        <span className="settings-field-label">Microphone</span>
        <select
          className="settings-select"
          value={selectedDeviceId ?? ""}
          onChange={(e) => onSelectDevice(e.target.value || null)}
        >
          <option value="">System default</option>
          {devices.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || "Microphone"}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

export function Settings({
  variant,
  devices,
  selectedDeviceId,
  onSelectDevice,
  onOpen,
}: SettingsProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  function toggle() {
    setOpen((prev) => {
      const next = !prev;
      if (next) onOpen?.();
      return next;
    });
  }

  // Desktop dropdown closes when clicking outside of it.
  useEffect(() => {
    if (variant !== "desktop" || !open) return;
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [variant, open]);

  // Escape closes the panel in either variant.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const gear = (
    <button
      className={`settings-gear${variant === "mobile" ? " settings-gear-floating" : ""}`}
      onClick={toggle}
      aria-label="Settings"
      aria-expanded={open}
    >
      <GearIcon />
    </button>
  );

  if (variant === "desktop") {
    return (
      <div className="settings settings-desktop" ref={rootRef}>
        {gear}
        {open && (
          <div className="settings-dropdown">
            <PanelContent
              devices={devices}
              selectedDeviceId={selectedDeviceId}
              onSelectDevice={onSelectDevice}
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      {gear}
      {open && (
        <div className="settings-sheet-backdrop" onClick={() => setOpen(false)}>
          <div className="settings-sheet" onClick={(e) => e.stopPropagation()}>
            <PanelContent
              devices={devices}
              selectedDeviceId={selectedDeviceId}
              onSelectDevice={onSelectDevice}
              onClose={() => setOpen(false)}
            />
          </div>
        </div>
      )}
    </>
  );
}
