import { useCallback, useEffect, useState } from "react";

// Enumerates the available audio input devices and keeps the list fresh as
// devices are plugged in / removed. Device labels are only populated once the
// user has granted mic permission, so call refresh() after the mic opens (e.g.
// when the settings panel is opened) to pick up the names.
export function useAudioInputDevices() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);

  const refresh = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const all = await navigator.mediaDevices.enumerateDevices();
    setDevices(all.filter((d) => d.kind === "audioinput"));
  }, []);

  useEffect(() => {
    refresh();
    const md = navigator.mediaDevices;
    if (!md?.addEventListener) return;
    md.addEventListener("devicechange", refresh);
    return () => md.removeEventListener("devicechange", refresh);
  }, [refresh]);

  return { devices, refresh };
}
