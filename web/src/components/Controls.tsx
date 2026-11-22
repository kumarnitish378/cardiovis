import { useCallback, useEffect, useRef } from "react";
import { CAMERA_PRESETS } from "../lib/geometry";
import { useStore } from "../lib/store";
import { Icon } from "./Icon";

const SPEEDS = [0.05, 0.1, 0.25, 0.5, 1];

const LIMB_LEADS = ["I", "II", "III", "aVR", "aVL", "aVF"];

/** Short labels for the camera presets - the long names live in the tooltip. */
const VIEW_SHORT: Record<string, string> = {
  frontal: "Front",
  horizontal: "Top",
  sagittal: "Side",
  oblique: "3D",
};

/**
 * Transport: everything to do with time, in one row between the 3D view and
 * the traces it drives.
 */
export function Controls() {
  const s = useStore();
  const data = s.data;
  if (!data) return null;

  const beats = data.manifest.delineation.beats;
  const timeMs = (s.frame / data.fs) * 1000;
  const step4 = Math.round(data.fs * 0.004);

  return (
    <div className="controls">
      <button
        className="primary play"
        onClick={s.togglePlay}
        aria-label={s.playing ? "Pause" : "Play"}
        title="Play / pause (space)"
      >
        <Icon name={s.playing ? "pause" : "play"} />
      </button>

      <div className="step-group" role="group" aria-label="Step through the recording">
        <button className="icon-btn" onClick={() => s.gotoBeat(s.currentBeat - 1)} title="Previous beat" aria-label="Previous beat">
          <Icon name="prevBeat" size={18} />
        </button>
        <button className="icon-btn" onClick={() => s.step(-step4)} title="Back 4 ms (←)" aria-label="Back 4 ms">
          <Icon name="stepBack" size={18} />
        </button>
        <button className="icon-btn" onClick={() => s.step(step4)} title="Forward 4 ms (→)" aria-label="Forward 4 ms">
          <Icon name="stepFwd" size={18} />
        </button>
        <button className="icon-btn" onClick={() => s.gotoBeat(s.currentBeat + 1)} title="Next beat" aria-label="Next beat">
          <Icon name="nextBeat" size={18} />
        </button>
      </div>

      <div className="scrub-wrap">
        <input
          className="scrub"
          type="range"
          min={0}
          max={data.n - 1}
          value={s.frame}
          onChange={(e) => s.setFrame(Number(e.target.value))}
          aria-label="Position in recording"
          style={{ "--fill": `${(s.frame / Math.max(1, data.n - 1)) * 100}%` } as React.CSSProperties}
        />
      </div>

      <span className="readout" title="Beat / total beats · time from the start of the recording">
        <b>{s.currentBeat + 1}</b>/{beats.length} <span className="sep">·</span> {timeMs.toFixed(0)} ms
      </span>

      <label className="speed" title="Playback speed">
        <select value={s.speed} onChange={(e) => s.setSpeed(Number(e.target.value))} aria-label="Playback speed">
          {SPEEDS.map((v) => (
            <option key={v} value={v}>
              {v}&times;
            </option>
          ))}
        </select>
        <Icon name="chevronDown" size={14} />
      </label>

      <button
        className={`icon-btn toggle ${s.loopBeat ? "on" : ""}`}
        onClick={() => s.setLoopBeat(!s.loopBeat)}
        aria-pressed={s.loopBeat}
        aria-label="Loop the current beat"
        title={s.loopBeat ? "Looping the current beat" : "Playing through the recording"}
      >
        <Icon name="repeat" size={18} />
      </button>
    </div>
  );
}

/** Camera presets: a segmented control floating in the stage. */
export function ViewPresets() {
  const cameraPreset = useStore((s) => s.cameraPreset);
  const setCameraPreset = useStore((s) => s.setCameraPreset);
  return (
    <div className="segmented view-presets" role="radiogroup" aria-label="Camera view">
      {Object.entries(CAMERA_PRESETS).map(([key, p]) => (
        <button
          key={key}
          role="radio"
          aria-checked={cameraPreset === key}
          className={cameraPreset === key ? "active" : ""}
          onClick={() => setCameraPreset(key)}
          title={`${p.label} - ${p.hint}`}
        >
          {VIEW_SHORT[key] ?? p.label}
        </button>
      ))}
    </div>
  );
}

function Switch({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="switch-row">
      <span className="switch-text">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </span>
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch" aria-hidden />
    </label>
  );
}

/**
 * Display options: a popover from the stage's top-right corner on wide
 * screens, a bottom sheet on phones.
 */
export function SceneOptions() {
  const s = useStore();
  const data = s.data;
  const ref = useRef<HTMLDivElement>(null);
  const open = s.controlsExpanded;
  const setOpen = s.setControlsExpanded;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, setOpen]);

  if (!data) return null;

  return (
    <div className="scene-options" ref={ref}>
      <button
        className={`icon-btn floating ${open ? "on" : ""}`}
        onClick={() => setOpen(!open)}
        title="Display options"
        aria-label="Display options"
        aria-expanded={open}
      >
        <Icon name="sliders" />
      </button>

      {open && (
        <div className="popover options-card" role="dialog" aria-label="Display options">
          <div className="popover-head">
            <span>Display</span>
            <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Close">
              <Icon name="close" size={18} />
            </button>
          </div>

          <div className="popover-section">
            <Switch checked={s.showLabels} onChange={s.setShowLabels} label="Lead labels" />
            <Switch checked={s.showAnatomy} onChange={s.setShowAnatomy} label="Anatomy labels" />
            <Switch checked={s.showAllLeadAxes} onChange={s.setShowAllLeadAxes} label="All lead axes" />
            <Switch checked={s.showConduction} onChange={s.setShowConduction} label="Conduction colour" hint="Illustrative" />
            <Switch checked={s.showMotion} onChange={s.setShowMotion} label="Contraction" hint="Illustrative" />
            <Switch checked={s.showFlow} onChange={s.setShowFlow} label="Blood flow" hint="Illustrative" />
            <Switch checked={s.showModelDipole} onChange={s.setShowModelDipole} label="Modelled dipole" hint="Illustrative" />
            <div className="slider-row">
              <span>Trail</span>
              <input
                type="range"
                min={60}
                max={900}
                step={20}
                value={s.trailMs}
                onChange={(e) => s.setTrailMs(Number(e.target.value))}
                style={{ "--fill": `${((s.trailMs - 60) / 840) * 100}%` } as React.CSSProperties}
              />
              <span className="mono">{s.trailMs} ms</span>
            </div>
          </div>

          <div className="popover-section">
            <span className="eyebrow">Key</span>
            <div className="key">
              <span>
                <i className="swatch vector" /> Heart vector
              </span>
              <span>
                <i className="swatch lead" /> Lead axis
              </span>
              <span>
                <i className="swatch projection" /> Projection
              </span>
            </div>
          </div>

          <div className="popover-section">
            <span className="eyebrow">Signal</span>
            <div className="segmented full" title={data.manifest.signal.filter.description}>
              <button className={!s.showRaw ? "active" : ""} onClick={() => s.setShowRaw(false)}>
                Filtered
              </button>
              <button className={s.showRaw ? "active" : ""} onClick={() => s.setShowRaw(true)}>
                Unfiltered
              </button>
            </div>
          </div>

          <div className="popover-section">
            <span className="eyebrow">VCG</span>
            <div className="segmented full">
              <button className={s.vcgChoice === "primary" ? "active" : ""} onClick={() => s.setVcgChoice("primary")}>
                {data.manifest.vcg.primary.method}
              </button>
              {data.manifest.vcg.alternate && (
                <button className={s.vcgChoice === "alternate" ? "active" : ""} onClick={() => s.setVcgChoice("alternate")}>
                  {data.manifest.vcg.alternate.method}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Lead selector, grouped the way leads are taught: limb leads (frontal plane)
 * and chest leads (horizontal plane). A vertical channel rail on wide screens,
 * a horizontal strip on narrow ones - the CSS decides.
 */
export function LeadPicker() {
  const data = useStore((s) => s.data);
  const selectedLead = useStore((s) => s.selectedLead);
  const setSelectedLead = useStore((s) => s.setSelectedLead);
  if (!data) return null;

  const limb = data.leadNames.filter((l) => LIMB_LEADS.includes(l));
  const chest = data.leadNames.filter((l) => !LIMB_LEADS.includes(l));

  const group = (label: string, hint: string, leads: string[]) => (
    <div className="lead-group" role="group" aria-label={hint}>
      <span className="eyebrow" title={hint}>
        {label}
      </span>
      {leads.map((lead) => (
        <button
          key={lead}
          className={lead === selectedLead ? "active" : ""}
          onClick={() => setSelectedLead(lead)}
          aria-pressed={lead === selectedLead}
        >
          {lead}
        </button>
      ))}
    </div>
  );

  return (
    <nav className="lead-picker" aria-label="Lead">
      {group("Limb", "Limb leads - frontal plane", limb)}
      {group("Chest", "Chest leads - horizontal plane", chest)}
    </nav>
  );
}

/**
 * The instrument readout in the stage's corner: which lead you are looking
 * through, and the value its shadow has right now.
 */
export function StageReadout() {
  const data = useStore((s) => s.data);
  const lead = useStore((s) => s.selectedLead);
  const frame = useStore((s) => s.frame);
  const vcgChoice = useStore((s) => s.vcgChoice);
  if (!data) return null;

  const entry = data.manifest.leadVectors[lead];
  if (!entry) return null;
  const src = vcgChoice === "alternate" && data.vcgAlt ? data.vcgAlt : data.vcg;
  const i = Math.max(0, Math.min(data.n - 1, frame));
  const u = entry.unitVector;
  const p = src[i] * u[0] + src[data.n + i] * u[1] + src[2 * data.n + i] * u[2];

  return (
    <div className="stage-readout" aria-live="off">
      <div className="readout-lead">{lead}</div>
      <div className="readout-meta">
        <span className={`readout-value ${p >= 0 ? "pos" : "neg"}`}>
          {p >= 0 ? "+" : "−"}
          {Math.abs(p).toFixed(2)}
          <small> mV</small>
        </span>
      </div>
    </div>
  );
}

/**
 * Zoom, pan and gain for the traces, on the divider bar next to the size
 * controls. The wheel and drag on the canvas do the same things; these exist so
 * the capability is discoverable and so a lecturer can hit an exact window
 * without aiming a mouse wheel.
 */
export function TraceZoomControls() {
  const data = useStore((s) => s.data);
  const viewSpan = useStore((s) => s.viewSpan);
  const gain = useStore((s) => s.gain);
  const rowHeight = useStore((s) => s.rowHeight);
  const boxZoom = useStore((s) => s.boxZoom);
  const currentBeat = useStore((s) => s.currentBeat);
  const followPlayhead = useStore((s) => s.followPlayhead);
  const traceMode = useStore((s) => s.traceMode);
  const s = useStore();
  if (!data) return null;

  const span = viewSpan || data.n;
  const spanMs = (span / data.fs) * 1000;
  const zoomed = span < data.n;
  const mmPerMv = gain * 10;

  return (
    <div className="trace-zoom">
      <span className="axis-group" title="Time axis">
        <span className="label">Time</span>
        <button onClick={() => s.zoomBy(1 / 1.6)} title="Zoom out in time (wheel down)">
          &#8722;
        </button>
        <button onClick={() => s.zoomBy(1.6)} title="Zoom in on time (wheel up)">
          +
        </button>
        <span className="readout">
          {spanMs >= 1000
            ? `${(spanMs / 1000).toFixed(spanMs >= 3000 ? 1 : 2)} s`
            : `${Math.round(spanMs)} ms`}
        </span>
      </span>

      <span className="axis-group" title="Amplitude axis (shift+wheel)">
        <span className="label">Gain</span>
        <button onClick={() => s.zoomGainBy(1 / 1.5)} title="Smaller deflections (shift+wheel down)">
          &#8722;
        </button>
        <button onClick={() => s.zoomGainBy(1.5)} title="Bigger deflections (shift+wheel up)">
          +
        </button>
        <span className="readout">{mmPerMv < 10 ? mmPerMv.toFixed(1) : Math.round(mmPerMv)} mm/mV</span>
      </span>

      {traceMode !== "selected" && (
        <span className="axis-group" title="Row height (ctrl+wheel). The panel scrolls when rows no longer fit.">
          <span className="label">Rows</span>
          <button onClick={() => s.zoomRowsBy(1 / 1.3)} title="Shorter rows">
            &#8722;
          </button>
          <button onClick={() => s.zoomRowsBy(1.3)} title="Taller rows (the panel scrolls)">
            +
          </button>
          <span className="readout">{Math.round(rowHeight)} px</span>
        </span>
      )}

      <button
        className={boxZoom ? "active" : ""}
        onClick={() => s.setBoxZoom(!boxZoom)}
        title="Drag a rectangle to zoom to it (or hold alt and drag)"
      >
        Box
      </button>
      <button
        onClick={() => {
          s.zoomToBeat(currentBeat);
          s.setFollowPlayhead(true);
        }}
        title="Fit the current beat, centred on its QRS"
      >
        Beat
      </button>
      <button onClick={s.resetView} className={zoomed || gain !== 1 ? "" : "active"} title="Whole recording at 1x (double-click the traces)">
        Reset
      </button>
      {zoomed && (
        <label className="check" title="Scroll the window to keep the playhead visible">
          <input
            type="checkbox"
            checked={followPlayhead}
            onChange={(e) => s.setFollowPlayhead(e.target.checked)}
          />
          Follow
        </label>
      )}
    </div>
  );
}

/** Trace-panel size controls, shown on the divider itself. */
export function TraceModePicker() {
  const traceMode = useStore((s) => s.traceMode);
  const setTraceMode = useStore((s) => s.setTraceMode);
  return (
    <div className="trace-mode">
      <button
        className={traceMode === "all" ? "active" : ""}
        onClick={() => setTraceMode("all")}
        title="All 12 traces"
      >
        All
      </button>
      <button
        className={traceMode === "selected" ? "active" : ""}
        onClick={() => setTraceMode("selected")}
        title="Only the lead selected for the projection view"
      >
        One
      </button>
      <button
        className={traceMode === "hidden" ? "active" : ""}
        onClick={() => setTraceMode("hidden")}
        title="Hide the traces and give the whole window to the 3D view"
      >
        Hide
      </button>
    </div>
  );
}

/**
 * Drag handle between the 3D view and the traces. The 3D view takes whatever is
 * left, so dragging this down is how you make it bigger.
 */
export function Splitter() {
  const setTraceHeight = useStore((s) => s.setTraceHeight);
  const traceHeight = useStore((s) => s.traceHeight);
  const dragging = useRef<{ startY: number; startH: number } | null>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // The bar also carries the zoom and size buttons; pressing one of those
      // is a click, not the start of a resize drag.
      if ((e.target as HTMLElement).closest("button, input, label")) return;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      dragging.current = { startY: e.clientY, startH: traceHeight };
    },
    [traceHeight],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return;
      setTraceHeight(dragging.current.startH - (e.clientY - dragging.current.startY));
    },
    [setTraceHeight],
  );

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement;
    if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
    dragging.current = null;
  }, []);

  // Keep the panel inside the window when the window itself changes size.
  useEffect(() => {
    const onResize = () => setTraceHeight(useStore.getState().traceHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [setTraceHeight]);

  return (
    <div
      className="splitter"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      role="separator"
      aria-orientation="horizontal"
      title="Drag to resize the 3D view"
    >
      <span className="grip" />
      <TraceZoomControls />
      <TraceModePicker />
    </div>
  );
}
