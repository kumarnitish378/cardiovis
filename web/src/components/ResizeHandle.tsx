import { useCallback, useEffect, useRef, useState } from "react";

/** A number persisted in localStorage, clamped on read. */
export function usePersistentSize(key: string, fallback: number, min: number, max: () => number) {
  const [value, setValue] = useState(() => {
    try {
      const raw = Number(localStorage.getItem(key));
      if (Number.isFinite(raw) && raw > 0) return Math.max(min, Math.min(max(), raw));
    } catch {
      /* private mode etc. */
    }
    return fallback;
  });

  const set = useCallback(
    (v: number) => {
      const clamped = Math.round(Math.max(min, Math.min(max(), v)));
      setValue(clamped);
      try {
        localStorage.setItem(key, String(clamped));
      } catch {
        /* as above */
      }
    },
    [key, min, max],
  );

  // Re-clamp when the window shrinks.
  useEffect(() => {
    const onResize = () => setValue((v) => Math.max(min, Math.min(max(), v)));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [min, max]);

  return [value, set] as const;
}

/**
 * A drag handle between two panes. `axis="x"` resizes a width (vertical bar),
 * `axis="y"` a height (horizontal bar). `invert` when the pane being sized
 * sits after the handle (to the right / below), so dragging toward it shrinks it.
 * Keyboard: arrow keys nudge by 16 px; double-click resets.
 */
export function ResizeHandle({
  axis,
  value,
  onChange,
  onReset,
  invert = false,
  label,
  className = "",
}: {
  axis: "x" | "y";
  value: number;
  onChange: (v: number) => void;
  onReset?: () => void;
  invert?: boolean;
  label: string;
  className?: string;
}) {
  const drag = useRef<{ start: number; startValue: number } | null>(null);
  const [active, setActive] = useState(false);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { start: axis === "x" ? e.clientX : e.clientY, startValue: value };
    setActive(true);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const delta = (axis === "x" ? e.clientX : e.clientY) - drag.current.start;
    onChange(drag.current.startValue + (invert ? -delta : delta));
  };
  const end = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    drag.current = null;
    setActive(false);
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const grow = axis === "x" ? (invert ? "ArrowLeft" : "ArrowRight") : invert ? "ArrowUp" : "ArrowDown";
    const shrink = axis === "x" ? (invert ? "ArrowRight" : "ArrowLeft") : invert ? "ArrowDown" : "ArrowUp";
    if (e.key === grow) onChange(value + 16);
    else if (e.key === shrink) onChange(value - 16);
    else return;
    e.preventDefault();
  };

  return (
    <div
      className={`resize-handle ${axis} ${active ? "active" : ""} ${className}`}
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      aria-label={label}
      aria-valuenow={value}
      tabIndex={0}
      title={`${label} - drag, or double-click to reset`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    >
      <span className="grip" />
    </div>
  );
}
