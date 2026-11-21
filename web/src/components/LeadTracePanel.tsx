import { useEffect, useMemo, useRef, useState } from "react";
import { clock } from "../lib/clock";
import { useStore } from "../lib/store";
import type { CaseData } from "../types";

/**
 * The 12-lead panel.
 *
 * Three things here are deliberate:
 *
 * 1. **Rows have a real height and the panel scrolls.** Squeezing twelve leads
 *    into whatever vertical space was left made every trace about 18 px tall,
 *    at which point zooming in time changes nothing you can see. Rows are sized
 *    in pixels per lead and the panel scrolls when they no longer fit.
 * 2. **Time and amplitude zoom independently.** Time changes the window that
 *    gets rasterised (so zooming adds detail rather than magnifying pixels);
 *    amplitude is a separate gain on the shared mV scale; row height is a third,
 *    separate control. A dragged rectangle sets time and amplitude at once.
 * 3. **The canvas is a static picture.** It is redrawn only when the view, the
 *    gain, the row height or the size changes. The playhead is a DOM element
 *    moved by a transform each frame, so a tall scrolled canvas is never
 *    re-blitted sixty times a second.
 *
 * Interaction:
 *   wheel            zoom time about the pointer
 *   shift + wheel    zoom amplitude
 *   drag             pan
 *   alt + drag       zoom to the dragged rectangle (also the `box` button)
 *   click            select that lead and seek to that instant
 *   double-click     back to the whole recording at 1x
 */

const PADDING_LEFT = 48;
const PADDING_RIGHT = 10;
const RULER_H = 20;

interface ViewWindow {
  start: number;
  span: number;
}

/** Amplitude scale shared by every lead, in px per mV, before gain. */
function baseScale(src: Float32Array, rowHeight: number): number {
  // A high percentile rather than the maximum: a single tall R wave in V3 would
  // otherwise flatten all six limb leads into straight lines. Anything above it
  // clips, which is visible and honest, rather than silently rescaling one lead
  // against another.
  const sampled: number[] = [];
  for (let k = 0; k < src.length; k += 7) {
    const v = Math.abs(src[k]);
    if (isFinite(v) && v < 12) sampled.push(v);
  }
  sampled.sort((a, b) => a - b);
  const peak = Math.max(0.35, sampled[Math.floor(sampled.length * 0.995)] ?? 1);
  return (rowHeight * 0.44) / peak;
}

function drawRuler(
  canvas: HTMLCanvasElement,
  data: CaseData,
  view: ViewWindow,
  dpr: number,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "var-surface";
  ctx.fillStyle = getComputedStyle(canvas).getPropertyValue("--ruler-bg") || "#1d1b20";
  ctx.fillRect(0, 0, w, h);

  const plotW = w - (PADDING_LEFT + PADDING_RIGHT) * dpr;
  const x0 = PADDING_LEFT * dpr;
  const spanS = view.span / data.fs;
  const step = [0.01, 0.02, 0.04, 0.1, 0.2, 0.5, 1, 2, 5].find((c) => spanS / c <= 12) ?? 10;

  ctx.font = `${Math.round(10 * dpr)}px Roboto, ui-monospace, monospace`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  const label = getComputedStyle(canvas).getPropertyValue("--ruler-fg") || "#cac4d0";

  for (
    let t = Math.ceil(view.start / data.fs / step) * step;
    t <= (view.start + view.span) / data.fs + 1e-9;
    t += step
  ) {
    const x = x0 + ((t * data.fs - view.start) / view.span) * plotW;
    ctx.strokeStyle = "rgba(147,143,153,0.5)";
    ctx.lineWidth = dpr;
    ctx.beginPath();
    ctx.moveTo(x, h * 0.55);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.fillStyle = label.trim() || "#cac4d0";
    ctx.fillText(
      step < 1 ? `${Math.round(t * 1000)} ms` : `${t.toFixed(0)} s`,
      x + 3 * dpr,
      h * 0.32,
    );
  }
}

function drawTraces(
  canvas: HTMLCanvasElement,
  data: CaseData,
  showRaw: boolean,
  selectedLead: string,
  dpr: number,
  leads: string[],
  view: ViewWindow,
  gain: number,
  rowHeight: number,
  colours: { grid: string; trace: string; selected: string; label: string; labelOn: string; beat: string; surface: string },
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  ctx.clearRect(0, 0, w, canvas.height);
  ctx.fillStyle = colours.surface;
  ctx.fillRect(0, 0, w, canvas.height);

  const rowPx = rowHeight * dpr;
  const plotW = w - (PADDING_LEFT + PADDING_RIGHT) * dpr;
  const src = showRaw ? data.leadsRaw : data.leads;
  const x0 = PADDING_LEFT * dpr;
  const xOf = (sample: number) => x0 + ((sample - view.start) / view.span) * plotW;
  const scale = baseScale(src, rowPx) * gain;

  // Time gridlines, matching the ruler above.
  const spanS = view.span / data.fs;
  const step = [0.01, 0.02, 0.04, 0.1, 0.2, 0.5, 1, 2, 5].find((c) => spanS / c <= 12) ?? 10;
  for (
    let t = Math.ceil(view.start / data.fs / step) * step;
    t <= (view.start + view.span) / data.fs + 1e-9;
    t += step
  ) {
    const x = xOf(t * data.fs);
    ctx.strokeStyle = colours.grid;
    ctx.lineWidth = dpr;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  }

  for (const b of data.manifest.delineation.beats) {
    if (b.rSample < view.start || b.rSample > view.start + view.span) continue;
    const x = xOf(b.rSample);
    ctx.strokeStyle = colours.beat;
    ctx.lineWidth = dpr;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  }

  for (let r = 0; r < leads.length; r++) {
    const lead = leads[r];
    const mid = rowPx * (r + 0.5);
    const selected = lead === selectedLead;

    if (selected) {
      ctx.fillStyle = "rgba(208,188,255,0.07)";
      ctx.fillRect(0, rowPx * r, w, rowPx);
    }

    ctx.strokeStyle = colours.grid;
    ctx.lineWidth = dpr;
    ctx.beginPath();
    ctx.moveTo(x0, mid);
    ctx.lineTo(w - PADDING_RIGHT * dpr, mid);
    ctx.stroke();

    ctx.fillStyle = selected ? colours.labelOn : colours.label;
    ctx.font = `${Math.round(selected ? 12 : 11) * dpr}px Roboto, ui-monospace, monospace`;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(lead, (PADDING_LEFT - 10) * dpr, mid);

    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, rowPx * r, plotW, rowPx);
    ctx.clip();                     // amplitude clipping stays inside its row

    ctx.strokeStyle = selected ? colours.selected : colours.trace;
    ctx.lineWidth = (selected ? 1.7 : 1.2) * dpr;
    ctx.beginPath();

    const base = data.leadNames.indexOf(lead) * data.n;
    const columns = Math.max(1, Math.floor(plotW));
    const perColumn = view.span / columns;

    if (perColumn <= 1) {
      // Zoomed past one sample per pixel: draw the samples themselves, so the
      // trace is the signal rather than a staircase of decimated extremes.
      const from = Math.max(0, Math.floor(view.start) - 1);
      const to = Math.min(data.n - 1, Math.ceil(view.start + view.span) + 1);
      for (let i = from; i <= to; i++) {
        const y = mid - src[base + i] * scale;
        if (i === from) ctx.moveTo(xOf(i), y);
        else ctx.lineTo(xOf(i), y);
      }
    } else {
      for (let c = 0; c < columns; c++) {
        const i0 = Math.floor(view.start + c * perColumn);
        const i1 = Math.min(data.n, Math.max(i0 + 1, Math.floor(view.start + (c + 1) * perColumn)));
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = Math.max(0, i0); i < i1; i++) {
          const v = src[base + i];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        if (!isFinite(lo)) continue;
        const x = x0 + c;
        const yLo = mid - lo * scale;
        const yHi = mid - hi * scale;
        if (c === 0) ctx.moveTo(x, yHi);
        else ctx.lineTo(x, yHi);
        if (yLo !== yHi) ctx.lineTo(x, yLo);
      }
    }
    ctx.stroke();
    ctx.restore();

    // Calibration bar, once per row: how tall 0.5 mV currently is.
    const barMv = 0.5;
    const barH = barMv * scale;
    if (barH > 8 * dpr && barH < rowPx * 0.9) {
      const bx = x0 + 6 * dpr;
      const by = mid + barH / 2;
      ctx.strokeStyle = colours.label;
      ctx.lineWidth = dpr;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(bx, by - barH);
      ctx.moveTo(bx - 3 * dpr, by);
      ctx.lineTo(bx + 3 * dpr, by);
      ctx.moveTo(bx - 3 * dpr, by - barH);
      ctx.lineTo(bx + 3 * dpr, by - barH);
      ctx.stroke();
    }
  }
}

function cssVar(el: HTMLElement, name: string, fallback: string): string {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

export function LeadTracePanel() {
  const data = useStore((s) => s.data);
  const showRaw = useStore((s) => s.showRaw);
  const selectedLead = useStore((s) => s.selectedLead);
  const setSelectedLead = useStore((s) => s.setSelectedLead);
  const setFrame = useStore((s) => s.setFrame);
  const traceMode = useStore((s) => s.traceMode);
  const viewStart = useStore((s) => s.viewStart);
  const viewSpan = useStore((s) => s.viewSpan);
  const gain = useStore((s) => s.gain);
  const rowHeight = useStore((s) => s.rowHeight);
  const boxZoom = useStore((s) => s.boxZoom);

  const scroller = useRef<HTMLDivElement>(null);
  const rulerCanvas = useRef<HTMLCanvasElement>(null);
  const traceCanvas = useRef<HTMLCanvasElement>(null);
  const playhead = useRef<HTMLDivElement>(null);
  const timeChip = useRef<HTMLDivElement>(null);
  const band = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [panelHeight, setPanelHeight] = useState(0);

  const gesture = useRef<
    | { kind: "pan"; x: number; startView: number; moved: boolean; y: number }
    | { kind: "box"; x0: number; y0: number; x1: number; y1: number }
    | null
  >(null);

  const leads = useMemo(
    () => (traceMode === "selected" ? [selectedLead] : (data?.leadNames ?? [])),
    [traceMode, selectedLead, data],
  );

  const view: ViewWindow = useMemo(
    () => ({ start: viewStart, span: viewSpan || (data?.n ?? 1) }),
    [viewStart, viewSpan, data],
  );
  const viewRef = useRef(view);
  viewRef.current = view;

  // One lead gets the whole panel; twelve get `rowHeight` each and the panel
  // scrolls. Squashing twelve into the available height was what made zooming
  // pointless - at 18 px a row there is nothing to zoom into.
  const contentHeight =
    traceMode === "selected"
      ? Math.max(rowHeight, panelHeight)
      : leads.length * rowHeight;

  // ---- rasterise ---------------------------------------------------------- #
  useEffect(() => {
    const scroll = scroller.current;
    const canvas = traceCanvas.current;
    const ruler = rulerCanvas.current;
    if (!scroll || !canvas || !ruler || !data) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(320, scroll.clientWidth);
    setWidth(w);

    canvas.width = w * dpr;
    canvas.height = Math.max(40, contentHeight) * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${Math.max(40, contentHeight)}px`;

    ruler.width = w * dpr;
    ruler.height = RULER_H * dpr;
    ruler.style.width = `${w}px`;
    ruler.style.height = `${RULER_H}px`;

    const colours = {
      grid: cssVar(canvas, "--trace-grid", "rgba(147,143,153,0.22)"),
      trace: cssVar(canvas, "--trace-line", "#9ccfca"),
      selected: cssVar(canvas, "--trace-line-selected", "#d0bcff"),
      label: cssVar(canvas, "--trace-label", "#938f99"),
      labelOn: cssVar(canvas, "--trace-label-selected", "#d0bcff"),
      beat: cssVar(canvas, "--trace-beat", "rgba(202,196,208,0.28)"),
      surface: cssVar(canvas, "--trace-surface", "#141218"),
    };

      drawTraces(canvas, data, showRaw, selectedLead, dpr, leads, view, gain,
               contentHeight / leads.length, colours);
    drawRuler(ruler, data, view, dpr);
  }, [data, showRaw, selectedLead, leads, view, gain, rowHeight, contentHeight, width, panelHeight]);

  // Re-rasterise on container resize. `data` is in the deps on purpose: on the
  // first mount there is no case yet, the component renders a placeholder, the
  // scroll node does not exist, and an effect with [] deps would bail out and
  // never run again - leaving the observer unattached and panelHeight stuck at
  // zero, which collapsed the single-lead view to one 52 px row.
  useEffect(() => {
    const scroll = scroller.current;
    if (!scroll) return;
    const measure = () => {
      setWidth(scroll.clientWidth);
      setPanelHeight(scroll.clientHeight);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroll);
    return () => observer.disconnect();
  }, [data]);

  // ---- playhead, as DOM ---------------------------------------------------- #
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const el = playhead.current;
      const chip = timeChip.current;
      const scroll = scroller.current;
      if (!el || !scroll || !data) return;
      const v = viewRef.current;
      const i = Math.max(0, Math.min(data.n - 1, clock.frame));

      const store = useStore.getState();
      if (store.followPlayhead && store.playing && v.span < data.n) {
        if (i < v.start || i > v.start + v.span * 0.92) {
          store.setView(i - v.span * 0.15, v.span);
        }
      }

      const plotW = scroll.clientWidth - PADDING_LEFT - PADDING_RIGHT;
      const inView = i >= v.start && i <= v.start + v.span;
      el.style.opacity = inView ? "1" : "0.25";
      const clamped = Math.max(v.start, Math.min(v.start + v.span, i));
      const x = PADDING_LEFT + ((clamped - v.start) / v.span) * plotW;
      el.style.transform = `translateX(${x}px)`;
      if (chip) {
        chip.style.transform = `translateX(${x}px)`;
        chip.textContent = `${((i / data.fs) * 1000).toFixed(0)} ms`;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [data]);

  // ---- wheel: time zoom, or amplitude zoom with shift --------------------- #
  useEffect(() => {
    const scroll = scroller.current;
    if (!scroll || !data) return;
    // Native listener, not onWheel: React registers wheel as passive, so
    // preventDefault would be ignored and the panel would scroll instead.
    const onWheel = (e: WheelEvent) => {
      const store = useStore.getState();
      if (e.shiftKey) {
        e.preventDefault();
        store.zoomGainBy(e.deltaY < 0 ? 1.2 : 1 / 1.2);
        return;
      }
      if (e.ctrlKey) {
        e.preventDefault();
        store.zoomRowsBy(e.deltaY < 0 ? 1.15 : 1 / 1.15);
        return;
      }
      e.preventDefault();
      const rect = scroll.getBoundingClientRect();
      const plotW = rect.width - PADDING_LEFT - PADDING_RIGHT;
      const anchor = Math.max(0, Math.min(1, (e.clientX - rect.left - PADDING_LEFT) / plotW));
      // Scale the step by the event magnitude so a trackpad flick and a mouse
      // notch feel the same rather than one of them jumping four octaves.
      const step = Math.min(2, 1 + Math.abs(e.deltaY) / 400);
      store.zoomBy(e.deltaY < 0 ? step : 1 / step, anchor);
    };
    scroll.addEventListener("wheel", onWheel, { passive: false });
    return () => scroll.removeEventListener("wheel", onWheel);
  }, [data]);

  // ---- drag: pan, or rubber-band zoom ------------------------------------- #
  const localPoint = (e: React.PointerEvent) => {
    const rect = scroller.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top + scroller.current!.scrollTop };
  };

  const sampleAtX = (x: number): number => {
    const plotW = scroller.current!.clientWidth - PADDING_LEFT - PADDING_RIGHT;
    const v = viewRef.current;
    return v.start + ((x - PADDING_LEFT) / plotW) * v.span;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!data) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const p = localPoint(e);
    if (boxZoom || e.altKey) {
      gesture.current = { kind: "box", x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      if (band.current) band.current.hidden = false;
    } else {
      gesture.current = { kind: "pan", x: e.clientX, y: e.clientY, startView: view.start, moved: false };
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || !data) return;
    if (g.kind === "box") {
      const p = localPoint(e);
      g.x1 = p.x;
      g.y1 = p.y;
      const el = band.current;
      if (el) {
        const left = Math.min(g.x0, g.x1);
        const top = Math.min(g.y0, g.y1);
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
        el.style.width = `${Math.abs(g.x1 - g.x0)}px`;
        el.style.height = `${Math.abs(g.y1 - g.y0)}px`;
      }
      return;
    }
    const plotW = scroller.current!.clientWidth - PADDING_LEFT - PADDING_RIGHT;
    const dx = e.clientX - g.x;
    if (Math.abs(dx) > 3) g.moved = true;
    if (!g.moved) return;
    const store = useStore.getState();
    store.setView(g.startView - (dx / plotW) * view.span, view.span);
    store.setFollowPlayhead(false);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    gesture.current = null;
    const target = e.currentTarget as HTMLElement;
    if (target.hasPointerCapture?.(e.pointerId)) target.releasePointerCapture(e.pointerId);
    if (band.current) band.current.hidden = true;
    if (!g || !data) return;

    if (g.kind === "box") {
      const dx = Math.abs(g.x1 - g.x0);
      const dy = Math.abs(g.y1 - g.y0);
      if (dx < 6) return;                       // a stray click, not a selection
      const a = sampleAtX(Math.min(g.x0, g.x1));
      const b = sampleAtX(Math.max(g.x0, g.x1));
      // Vertical extent of the box, as a fraction of one row, becomes the
      // amplitude factor: select a short band and it fills the row.
      const drawnRowHeight = contentHeight / leads.length;
      const gainFactor = dy > 8 ? Math.max(1, Math.min(6, (drawnRowHeight * 0.85) / dy)) : undefined;
      useStore.getState().zoomToRegion(a, b, gainFactor);
      return;
    }

    if (g.moved) return;                        // a drag was a pan, not a click
    const rect = scroller.current!.getBoundingClientRect();
    const y = e.clientY - rect.top + scroller.current!.scrollTop;
    const drawnRowHeight = contentHeight / leads.length;
    const row = Math.max(0, Math.min(leads.length - 1, Math.floor(y / drawnRowHeight)));
    setSelectedLead(leads[row]);
    if (e.clientX - rect.left > PADDING_LEFT) setFrame(sampleAtX(e.clientX - rect.left));
  };

  if (!data) return <div className="trace-panel empty" />;

  return (
    <div className="trace-panel">
      <canvas ref={rulerCanvas} className="trace-ruler" />
      <div className="trace-time-chip" ref={timeChip} />
      <div
        className={`trace-scroll ${boxZoom ? "box-mode" : ""}`}
        ref={scroller}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={() => useStore.getState().resetView()}
        title="Click: select lead + seek · wheel: zoom time · shift+wheel: amplitude · ctrl+wheel: row height · drag: pan · alt+drag: zoom to area · double-click: reset"
      >
        <div className="trace-content" style={{ height: Math.max(40, contentHeight) }}>
          <canvas ref={traceCanvas} />
          <div className="trace-playhead" ref={playhead} />
          <div className="trace-band" ref={band} hidden />
        </div>
      </div>
    </div>
  );
}
