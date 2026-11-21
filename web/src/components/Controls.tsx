import { useCallback, useEffect, useRef } from "react";
import { CAMERA_PRESETS } from "../lib/geometry";
import { useStore } from "../lib/store";

const SPEEDS = [0.05, 0.1, 0.25, 0.5, 1];

/**
 * Transport and options. Only the transport row is always visible - everything
 * else folds away, because every pixel this bar takes comes straight out of the
 * 3D view, which is the thing people are here to look at.
 */
export function Controls() {
  const s = useStore();
  const data = s.data;
  if (!data) return null;

  const beats = data.manifest.delineation.beats;
  const timeMs = (s.frame / data.fs) * 1000;

  return (
    <div className="controls">
      <div className="row primary-row">
        <button className="primary" onClick={s.togglePlay}>
          {s.playing ? "Pause" : "Play"}
        </button>
        <button onClick={() => s.gotoBeat(s.currentBeat - 1)} title="Previous beat">
          &#8592;
        </button>
        <button onClick={() => s.gotoBeat(s.currentBeat + 1)} title="Next beat">
          &#8594;
        </button>
        <button onClick={() => s.step(-Math.round(data.fs * 0.004))} title="Back 4 ms">
          &#8722;4 ms
        </button>
        <button onClick={() => s.step(Math.round(data.fs * 0.004))} title="Forward 4 ms">
          +4 ms
        </button>
        {SPEEDS.map((v) => (
          <button
            key={v}
            className={s.speed === v ? "active" : ""}
            onClick={() => s.setSpeed(v)}
            title={`Play at ${v}x real time`}
          >
            {v}&times;
          </button>
        ))}
        <label className="check">
          <input
            type="checkbox"
            checked={s.loopBeat}
            onChange={(e) => s.setLoopBeat(e.target.checked)}
          />
          loop beat
        </label>
        <input
          className="scrub"
          type="range"
          min={0}
          max={data.n - 1}
          value={s.frame}
          onChange={(e) => s.setFrame(Number(e.target.value))}
        />
        <span className="readout">
          {s.currentBeat + 1}/{beats.length} &middot; {timeMs.toFixed(0)} ms
        </span>
        <button
          className={s.controlsExpanded ? "active" : ""}
          onClick={() => s.setControlsExpanded(!s.controlsExpanded)}
          title="Camera, signal and VCG options"
        >
          {s.controlsExpanded ? "hide options" : "options"}
        </button>
      </div>

      {s.controlsExpanded && (
        <>
          <div className="row">
            <span className="label">view</span>
            {Object.entries(CAMERA_PRESETS).map(([key, p]) => (
              <button
                key={key}
                className={s.cameraPreset === key ? "active" : ""}
                onClick={() => s.setCameraPreset(key)}
                title={p.hint}
              >
                {p.label}
              </button>
            ))}
            <label className="check">
              <input
                type="checkbox"
                checked={s.showAllLeadAxes}
                onChange={(e) => s.setShowAllLeadAxes(e.target.checked)}
              />
              all 12 lead axes
            </label>
            <label className="check" title="Orientation, chamber, lead-polarity and live value labels">
              <input
                type="checkbox"
                checked={s.showLabels}
                onChange={(e) => s.setShowLabels(e.target.checked)}
              />
              labels
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={s.showConduction}
                onChange={(e) => s.setShowConduction(e.target.checked)}
              />
              conduction model (Tier 3)
            </label>
            <span className="label">trail</span>
            <input
              type="range"
              min={60}
              max={900}
              step={20}
              value={s.trailMs}
              onChange={(e) => s.setTrailMs(Number(e.target.value))}
            />
            <span className="readout">{s.trailMs} ms</span>
          </div>

          <div className="row">
            <span className="label">signal</span>
            <button className={!s.showRaw ? "active" : ""} onClick={() => s.setShowRaw(false)}>
              filtered
            </button>
            <button className={s.showRaw ? "active" : ""} onClick={() => s.setShowRaw(true)}>
              unfiltered
            </button>
            <span className="label">VCG</span>
            <button
              className={s.vcgChoice === "primary" ? "active" : ""}
              onClick={() => s.setVcgChoice("primary")}
            >
              {data.manifest.vcg.primary.method}
            </button>
            {data.manifest.vcg.alternate && (
              <button
                className={s.vcgChoice === "alternate" ? "active" : ""}
                onClick={() => s.setVcgChoice("alternate")}
              >
                {data.manifest.vcg.alternate.method}
              </button>
            )}
            <label
              className="check"
              title="Draw the dipole implied by the Tier-3 model instead of the measured one"
            >
              <input
                type="checkbox"
                checked={s.showModelDipole}
                onChange={(e) => s.setShowModelDipole(e.target.checked)}
              />
              modelled dipole (Tier 3)
            </label>
            <span className="hint">{data.manifest.signal.filter.description}</span>
          </div>
        </>
      )}
    </div>
  );
}

export function LeadPicker() {
  const data = useStore((s) => s.data);
  const selectedLead = useStore((s) => s.selectedLead);
  const setSelectedLead = useStore((s) => s.setSelectedLead);
  if (!data) return null;

  return (
    <div className="lead-picker">
      {data.leadNames.map((lead) => (
        <button
          key={lead}
          className={lead === selectedLead ? "active" : ""}
          onClick={() => setSelectedLead(lead)}
        >
          {lead}
        </button>
      ))}
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
        <span className="label">time</span>
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
        <span className="label">mV</span>
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
          <span className="label">rows</span>
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
        box
      </button>
      <button
        onClick={() => {
          s.zoomToBeat(currentBeat);
          s.setFollowPlayhead(true);
        }}
        title="Fit the current beat, centred on its QRS"
      >
        beat
      </button>
      <button onClick={s.resetView} className={zoomed || gain !== 1 ? "" : "active"} title="Whole recording at 1x (double-click the traces)">
        reset
      </button>
      {zoomed && (
        <label className="check" title="Scroll the window to keep the playhead visible">
          <input
            type="checkbox"
            checked={followPlayhead}
            onChange={(e) => s.setFollowPlayhead(e.target.checked)}
          />
          follow
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
        12 leads
      </button>
      <button
        className={traceMode === "selected" ? "active" : ""}
        onClick={() => setTraceMode("selected")}
        title="Only the lead selected for the projection view"
      >
        selected only
      </button>
      <button
        className={traceMode === "hidden" ? "active" : ""}
        onClick={() => setTraceMode("hidden")}
        title="Hide the traces and give the whole window to the 3D view"
      >
        hide
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
