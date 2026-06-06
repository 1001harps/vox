export function TransportGlyph({ type }: {
  type: "record" | "stop" | "play" | "pause";
}) {
  switch (type) {
    case "record":
      return (
        <svg viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="12" cy="12" r="5" fill="#e0392b" />
        </svg>
      );
    case "stop":
      return (
        <svg viewBox="0 0 24 24">
          <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
        </svg>
      );
    case "play":
      return (
        <svg viewBox="0 0 24 24">
          <polygon points="8,5 8,19 19,12" fill="currentColor" />
        </svg>
      );
    case "pause":
      return (
        <svg viewBox="0 0 24 24">
          <rect x="7" y="5" width="3.5" height="14" rx="1" fill="currentColor" />
          <rect x="13.5" y="5" width="3.5" height="14" rx="1" fill="currentColor" />
        </svg>
      );
  }
}
