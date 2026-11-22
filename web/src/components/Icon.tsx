/**
 * A small, hand-drawn icon set on a 20px grid with a 1.6px stroke. Inline SVG,
 * so icons inherit `currentColor` and need no font or network request.
 */
const PATHS: Record<string, React.ReactNode> = {
  play: <path d="M6.5 4.5v11l9-5.5z" fill="currentColor" stroke="none" />,
  pause: (
    <g fill="currentColor" stroke="none">
      <rect x="5.5" y="4.5" width="3" height="11" rx="0.8" />
      <rect x="11.5" y="4.5" width="3" height="11" rx="0.8" />
    </g>
  ),
  prevBeat: (
    <>
      <path d="M5 5v10" />
      <path d="M15 5l-7 5 7 5z" fill="currentColor" stroke="none" />
    </>
  ),
  nextBeat: (
    <>
      <path d="M15 5v10" />
      <path d="M5 5l7 5-7 5z" fill="currentColor" stroke="none" />
    </>
  ),
  repeat: (
    <>
      <path d="M4 9.5V8a2.5 2.5 0 0 1 2.5-2.5H15" />
      <path d="M13 3.5l2 2-2 2" />
      <path d="M16 10.5V12a2.5 2.5 0 0 1-2.5 2.5H5" />
      <path d="M7 16.5l-2-2 2-2" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 6h7M15 6h1M4 14h1M9 14h7" />
      <circle cx="13" cy="6" r="2" />
      <circle cx="7" cy="14" r="2" />
    </>
  ),
  info: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 9v4.5M10 6.6v.1" />
    </>
  ),
  panel: (
    <>
      <rect x="3" y="4" width="14" height="12" rx="2" />
      <path d="M12 4v12" />
    </>
  ),
  close: <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />,
  stepBack: <path d="M12 5l-5 5 5 5" />,
  stepFwd: <path d="M8 5l5 5-5 5" />,
  chevronDown: <path d="M6 8l4 4 4-4" />,
};

export function Icon({ name, size = 20, className }: { name: keyof typeof PATHS | string; size?: number; className?: string }) {
  return (
    <svg
      className={`icon ${className ?? ""}`}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {PATHS[name]}
    </svg>
  );
}

/** The CardioVis mark: a heart outline crossed by one ECG complex. */
export function BrandMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden className="brand-mark">
      <path
        d="M12 20.5s-7.5-4.6-7.5-10.4A4.1 4.1 0 0 1 12 7.6a4.1 4.1 0 0 1 7.5 2.5c0 5.8-7.5 10.4-7.5 10.4z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M2.5 12.5h5l1.4-2.6 2.2 5.6 1.8-4.4 1 1.4h7.6"
        stroke="var(--c-vector)"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
