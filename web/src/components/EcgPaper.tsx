import { useEffect, useMemo, useRef, useState } from "react";
import { clock } from "../lib/clock";
import { useStore } from "../lib/store";
import type { CaseData } from "../types";

/**
 * The 12-lead the way it is read clinically.
 *
 *  - "12-lead": standard 3 x 4 layout (I aVR V1 V4 / II aVL V2 V5 / III aVF
 *    V3 V6), 2.5 s per column, plus a 10 s rhythm strip, on calibrated ECG
 *    paper (1 mm / 5 mm grid, 25 or 50 mm/s, 5/10/20 mm/mV, 1 mV calibration
 *    pulse on every row).
 *  - "Heatmap": every lead as a row coloured by voltage (red positive, blue
 *    negative), over the whole recording or over the median beat - which
 *    makes territory patterns (e.g. ST shifts confined to contiguous leads)
 *    visible at a glance.
 *
 * Calipers: drag anywhere to measure time (ms, and rate when it spans an RR
 * interval) and voltage. A click without dragging selects that lead and moves
 * the playhead there.
 */

const GRID_LAYOUT = [
  ["I", "aVR", "V1", "V4"],
  ["II", "aVL", "V2", "V5"],
  ["III", "aVF", "V3", "V6"],
];
const COL_S = 2.5;
const MARGIN_MM = 10; // room for the calibration pulse

type Mode = "grid" | "heatmap";
type Theme = "paper" | "dark";
type HeatRange = "rhythm" | "median";

const THEMES = {
  paper: {
    bg: "#fffdfb",
    minor: "rgba(232, 120, 120, 0.22)",
    major: "rgba(214, 72, 72, 0.5)",
    trace: "#141414",
    label: "#3a3a3a",
    labelOn: "#c2410c",
    playhead: "rgba(220, 38, 38, 0.85)",
    caliper: "#1d4ed8",
    caliperText: "#ffffff",
  },
  dark: {
    bg: "#0b0c0e",
    minor: "rgba(255, 255, 255, 0.045)",
    major: "rgba(255, 107, 87, 0.22)",
    trace: "#e6e6e6",
    label: "#8a8f96",
    labelOn: "#f0b03f",
    playhead: "rgba(255, 107, 87, 0.9)",
    caliper: "#7ea9ff",
    caliperText: "#0b0c0e",
  },
};

interface Geometry {
  pxPerMm: number;
  rowMm: number;
  widthMm: number;
  heightMm: number;
}

interface Caliper {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function medianBeat(data: CaseData, raw: boolean): { values: Float32Array; len: number; rIndex: number } | null {
  const beats = data.manifest.delineation.beats.filter((b) => Number.isFinite(b.rSample));
  if (beats.length < 1) return null;
  const pre = Math.round(0.3 * data.fs);
  const post = Math.round(0.5 * data.fs);
  const len = pre + post;
  const src = raw ? data.leadsRaw : data.leads;
  const values = new Float32Array(data.leadNames.length * len);
  const tmp: number[] = [];
  for (let l = 0; l < data.leadNames.length; l++) {
    for (let t = 0; t < len; t++) {
      tmp.length = 0;
      for (const b of beats) {
        const i = b.rSample - pre + t;
        if (i >= 0 && i < data.n) tmp.push(src[l * data.n + i]);
      }
      tmp.sort((a, c) => a - c);
      values[l * len + t] = tmp.length ? tmp[tmp.length >> 1] : 0;
    }
  }
  return { values, len, rIndex: pre };
}

/** Diverging map: blue (neg) -> background-ish neutral -> red (pos). */
function diverging(v: number, theme: Theme): [number, number, number] {
  const x = Math.max(-1, Math.min(1, v));
  const mid = theme === "paper" ? [252, 250, 248] : [18, 20, 24];
  const pos = theme === "paper" ? [200, 30, 30] : [255, 96, 80];
  const neg = theme === "paper" ? [30, 80, 200] : [90, 140, 255];
  const t = Math.pow(Math.abs(x), 0.8);
  const end = x >= 0 ? pos : neg;
  return [mid[0] + (end[0] - mid[0]) * t, mid[1] + (end[1] - mid[1]) * t, mid[2] + (end[2] - mid[2]) * t];
}

export function EcgPaper() {
  const data = useStore((s) => s.data);
  const showRaw = useStore((s) => s.showRaw);
  const selectedLead = useStore((s) => s.selectedLead);
  const setSelectedLead = useStore((s) => s.setSelectedLead);
  const setFrame = useStore((s) => s.setFrame);

  const [mode, setMode] = useState<Mode>("grid");
  const [speed, setSpeed] = useState(25);
  const [gain, setGain] = useState(10);
  const [theme, setTheme] = useState<Theme>("paper");
  const [rhythmLead, setRhythmLead] = useState("II");
  const [heatRange, setHeatRange] = useState<HeatRange>("median");
  const [heatScale, setHeatScale] = useState(1); // mV at full colour
  const [width, setWidth] = useState(800);
  const [boxHeight, setBoxHeight] = useState(500);
  const [caliper, setCaliper] = useState<Caliper | null>(null);

  const wrap = useRef<HTMLDivElement>(null);
  const base = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  const colours = THEMES[theme];
  const durationS = data ? data.n / data.fs : 10;

  // --- size ---------------------------------------------------------------
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setWidth(el.clientWidth);
      setBoxHeight(el.clientHeight);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const geo: Geometry = useMemo(() => {
    const colsS = Math.min(durationS, COL_S * 4);
    const widthMm = MARGIN_MM + colsS * speed + 4;
    // Fit the page to the view: width first (on narrow screens keep it
    // legible and scroll sideways), then give the rows whatever height is left
    // so tall complexes do not run into the next row.
    const minK = width < 700 ? 2.8 : 1.2;
    const baseRow = Math.max(22, gain * 3);
    let k = Math.max(minK, Math.min(width / widthMm, (boxHeight - 8) / (baseRow * 4 + 4)));
    const rowMm = Math.min(gain * 5, Math.max(baseRow, ((boxHeight - 8) / k - 4) / 4));
    const heightMm = rowMm * 4 + 4;
    k = Math.max(minK, Math.min(k, (boxHeight - 8) / heightMm));
    return { pxPerMm: k, rowMm, widthMm, heightMm };
  }, [width, boxHeight, speed, gain, durationS]);

  const canvasH = mode === "grid" ? Math.round(geo.heightMm * geo.pxPerMm) : Math.max(260, boxHeight - 4);
  const canvasW = mode === "grid" ? Math.round(geo.widthMm * geo.pxPerMm) : width;

  const median = useMemo(() => (data ? medianBeat(data, showRaw) : null), [data, showRaw]);

  // --- base layer: grid + traces / heatmap --------------------------------
  useEffect(() => {
    const cv = base.current;
    if (!cv || !data) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(canvasW * dpr);
    cv.height = Math.round(canvasH * dpr);
    cv.style.width = `${canvasW}px`;
    cv.style.height = `${canvasH}px`;
    const ctx = cv.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = colours.bg;
    ctx.fillRect(0, 0, canvasW, canvasH);
    const src = showRaw ? data.leadsRaw : data.leads;
    const fs = data.fs;

    if (mode === "heatmap") {
      drawHeatmap(ctx, data, src, canvasW, canvasH, theme, heatRange, median, heatScale, selectedLead, colours);
      return;
    }

    const k = geo.pxPerMm;
    // grid
    const W = canvasW;
    const H = canvasH;
    if (k >= 2.2) {
      ctx.strokeStyle = colours.minor;
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      for (let x = 0; x <= W; x += k) {
        ctx.moveTo(Math.round(x) + 0.5, 0);
        ctx.lineTo(Math.round(x) + 0.5, H);
      }
      for (let y = 0; y <= H; y += k) {
        ctx.moveTo(0, Math.round(y) + 0.5);
        ctx.lineTo(W, Math.round(y) + 0.5);
      }
      ctx.stroke();
    }
    ctx.strokeStyle = colours.major;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= W; x += 5 * k) {
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, H);
    }
    for (let y = 0; y <= H; y += 5 * k) {
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(W, Math.round(y) + 0.5);
    }
    ctx.stroke();

    const rowTop = (r: number) => (2 + r * geo.rowMm) * k;
    const baseline = (r: number) => rowTop(r) + geo.rowMm * 0.62 * k;
    const x0 = MARGIN_MM * k;

    const drawSegment = (lead: string, r: number, t0: number, t1: number, xStart: number) => {
      const li = data.leadNames.indexOf(lead);
      if (li < 0) return;
      const i0 = Math.max(0, Math.floor(t0 * fs));
      const i1 = Math.min(data.n - 1, Math.ceil(t1 * fs));
      const y0 = baseline(r);
      ctx.beginPath();
      for (let i = i0; i <= i1; i++) {
        const x = xStart + ((i / fs - t0) * speed) * k;
        const y = y0 - src[li * data.n + i] * gain * k;
        if (i === i0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.fillStyle = lead === selectedLead ? colours.labelOn : colours.label;
      ctx.font = `${lead === selectedLead ? 700 : 600} ${Math.max(10, k * 3.2)}px "IBM Plex Sans", system-ui, sans-serif`;
      ctx.fillText(lead, xStart + 1.2 * k, rowTop(r) + 4.2 * k);
    };

    const calPulse = (r: number) => {
      const y0 = baseline(r);
      const h = gain * k; // 1 mV
      const x = 2 * k;
      ctx.beginPath();
      ctx.moveTo(x, y0);
      ctx.lineTo(x + 1.5 * k, y0);
      ctx.lineTo(x + 1.5 * k, y0 - h);
      ctx.lineTo(x + 6.5 * k, y0 - h);
      ctx.lineTo(x + 6.5 * k, y0);
      ctx.lineTo(x + 8 * k, y0);
      ctx.stroke();
    };

    ctx.strokeStyle = colours.trace;
    ctx.lineWidth = Math.max(1, k * 0.32);
    ctx.lineJoin = "round";
    for (let r = 0; r < 3; r++) {
      calPulse(r);
      for (let c = 0; c < 4; c++) {
        const t0 = c * COL_S;
        if (t0 >= durationS) continue;
        drawSegment(GRID_LAYOUT[r][c], r, t0, Math.min(durationS, t0 + COL_S), x0 + c * COL_S * speed * k);
        if (c > 0) {
          // lead-change tick
          ctx.save();
          ctx.lineWidth = Math.max(1, k * 0.3);
          ctx.beginPath();
          const xt = x0 + c * COL_S * speed * k;
          ctx.moveTo(xt, baseline(r) - 2.5 * k);
          ctx.lineTo(xt, baseline(r) + 2.5 * k);
          ctx.stroke();
          ctx.restore();
        }
      }
    }
    calPulse(3);
    drawSegment(rhythmLead, 3, 0, Math.min(durationS, COL_S * 4), x0);

    // footer: calibration
    ctx.fillStyle = colours.label;
    ctx.font = `500 ${Math.max(10, k * 2.6)}px "IBM Plex Mono", ui-monospace, monospace`;
    ctx.fillText(
      `${speed} mm/s   ${gain} mm/mV   ${showRaw ? "unfiltered" : "0.5–40 Hz"}`,
      x0,
      H - 1.2 * k,
    );
  }, [data, showRaw, mode, canvasW, canvasH, geo, speed, gain, theme, rhythmLead, selectedLead, colours, durationS, heatRange, median, heatScale]);

  // --- overlay: playhead + caliper ----------------------------------------
  useEffect(() => {
    const cv = overlay.current;
    if (!cv || !data) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(canvasW * dpr);
    cv.height = Math.round(canvasH * dpr);
    cv.style.width = `${canvasW}px`;
    cv.style.height = `${canvasH}px`;
    const ctx = cv.getContext("2d")!;
    let raf = 0;
    let lastFrame = -1;
    let lastCal = "";

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const f = Math.round(clock.frame);
      const calKey = caliper ? `${caliper.x0},${caliper.y0},${caliper.x1},${caliper.y1}` : "";
      if (f === lastFrame && calKey === lastCal) return;
      lastFrame = f;
      lastCal = calKey;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, canvasW, canvasH);
      const t = f / data.fs;

      ctx.strokeStyle = colours.playhead;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (mode === "grid") {
        const k = geo.pxPerMm;
        const x0 = MARGIN_MM * k;
        const c = Math.floor(t / COL_S);
        if (c >= 0 && c < 4) {
          const x = x0 + t * speed * k;
          ctx.moveTo(x, 2 * k);
          ctx.lineTo(x, (2 + 3 * geo.rowMm) * k);
        }
        const xr = x0 + t * speed * k;
        ctx.moveTo(xr, (2 + 3 * geo.rowMm) * k);
        ctx.lineTo(xr, (2 + 4 * geo.rowMm) * k);
      } else if (heatRange === "rhythm") {
        const x = HEAT_LABEL_W + (t / durationS) * (canvasW - HEAT_LABEL_W);
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvasH);
      }
      ctx.stroke();

      if (caliper) drawCaliper(ctx, caliper);
    };

    const drawCaliper = (c2: CanvasRenderingContext2D, c: Caliper) => {
      const col = colours.caliper;
      c2.strokeStyle = col;
      c2.fillStyle = col;
      c2.lineWidth = 1.5;
      c2.setLineDash([]);
      c2.beginPath();
      c2.moveTo(c.x0, c.y0 - 40);
      c2.lineTo(c.x0, c.y0 + 40);
      c2.moveTo(c.x1, c.y1 - 40);
      c2.lineTo(c.x1, c.y1 + 40);
      c2.stroke();
      c2.setLineDash([4, 3]);
      c2.beginPath();
      c2.moveTo(c.x0, c.y0);
      c2.lineTo(c.x1, c.y0);
      c2.lineTo(c.x1, c.y1);
      c2.stroke();
      c2.setLineDash([]);
      const label = caliperLabel(c);
      if (!label) return;
      c2.font = `500 12px "IBM Plex Mono", ui-monospace, monospace`;
      const w = c2.measureText(label).width + 14;
      const lx = Math.min(canvasW - w - 4, Math.max(4, (c.x0 + c.x1) / 2 - w / 2));
      const ly = Math.max(4, Math.min(c.y0, c.y1) - 30);
      c2.fillStyle = col;
      c2.beginPath();
      c2.roundRect(lx, ly, w, 20, 5);
      c2.fill();
      c2.fillStyle = colours.caliperText;
      c2.fillText(label, lx + 7, ly + 14);
    };

    draw();
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, canvasW, canvasH, geo, speed, gain, mode, caliper, colours, heatRange, durationS]);

  // --- calipers + click-to-select ------------------------------------------
  const caliperLabel = (c: Caliper): string => {
    if (!data) return "";
    const dx = Math.abs(c.x1 - c.x0);
    const dy = c.y0 - c.y1;
    let dtMs: number;
    let dv: number | null = null;
    if (mode === "grid") {
      dtMs = (dx / geo.pxPerMm / speed) * 1000;
      dv = dy / geo.pxPerMm / gain;
    } else if (heatRange === "rhythm") {
      dtMs = (dx / (width - HEAT_LABEL_W)) * durationS * 1000;
    } else {
      dtMs = median ? (dx / (width - HEAT_LABEL_W)) * (median.len / data.fs) * 1000 : 0;
    }
    const parts = [`Δt ${dtMs.toFixed(0)} ms`];
    if (dtMs >= 250 && dtMs <= 2500) parts.push(`${(60000 / dtMs).toFixed(0)} bpm`);
    if (dv != null) parts.push(`ΔV ${dv >= 0 ? "+" : ""}${dv.toFixed(2)} mV`);
    return parts.join("  ·  ");
  };

  const hit = (x: number, y: number): { lead: string; t: number } | null => {
    if (!data) return null;
    if (mode === "grid") {
      const k = geo.pxPerMm;
      const t = (x - MARGIN_MM * k) / k / speed;
      if (t < 0 || t > durationS) return null;
      const r = Math.floor((y / k - 2) / geo.rowMm);
      if (r < 0 || r > 3) return null;
      const lead = r === 3 ? rhythmLead : GRID_LAYOUT[r][Math.min(3, Math.floor(t / COL_S))];
      return { lead, t };
    }
    const rowH = canvasH / data.leadNames.length;
    const lead = data.leadNames[Math.min(data.leadNames.length - 1, Math.max(0, Math.floor(y / rowH)))];
    if (heatRange === "rhythm") {
      const t = ((x - HEAT_LABEL_W) / (width - HEAT_LABEL_W)) * durationS;
      return t < 0 ? { lead, t: NaN } : { lead, t };
    }
    return { lead, t: NaN };
  };

  const pos = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = pos(e);
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: p.x, y: p.y, moved: false };
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drag.current) return;
    const p = pos(e);
    if (!drag.current.moved && Math.hypot(p.x - drag.current.x, p.y - drag.current.y) < 4) return;
    drag.current.moved = true;
    setCaliper({ x0: drag.current.x, y0: drag.current.y, x1: p.x, y1: p.y });
  };
  const onUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved) return;
    setCaliper(null);
    const h = hit(d.x, d.y);
    if (!h || !data) return;
    setSelectedLead(h.lead);
    if (Number.isFinite(h.t)) setFrame(Math.round(h.t * data.fs));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setCaliper(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!data) return <div className="ecg-paper empty" />;

  return (
    <div className={`ecg-paper theme-${theme}`}>
      <div className="ecg-toolbar">
        <div className="segmented" role="radiogroup" aria-label="View">
          <button className={mode === "grid" ? "active" : ""} onClick={() => setMode("grid")}>
            12-lead
          </button>
          <button className={mode === "heatmap" ? "active" : ""} onClick={() => setMode("heatmap")}>
            Heatmap
          </button>
        </div>

        {mode === "grid" ? (
          <>
            <label className="field">
              <span>Speed</span>
              <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
                <option value={25}>25 mm/s</option>
                <option value={50}>50 mm/s</option>
              </select>
            </label>
            <label className="field">
              <span>Gain</span>
              <select value={gain} onChange={(e) => setGain(Number(e.target.value))}>
                <option value={5}>5 mm/mV</option>
                <option value={10}>10 mm/mV</option>
                <option value={20}>20 mm/mV</option>
              </select>
            </label>
            <label className="field">
              <span>Rhythm</span>
              <select value={rhythmLead} onChange={(e) => setRhythmLead(e.target.value)}>
                {data.leadNames.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : (
          <>
            <div className="segmented" role="radiogroup" aria-label="Heatmap range">
              <button className={heatRange === "median" ? "active" : ""} onClick={() => setHeatRange("median")}>
                Median beat
              </button>
              <button className={heatRange === "rhythm" ? "active" : ""} onClick={() => setHeatRange("rhythm")}>
                10 s
              </button>
            </div>
            <label className="field">
              <span>Scale</span>
              <select value={heatScale} onChange={(e) => setHeatScale(Number(e.target.value))}>
                <option value={0.25}>±0.25 mV</option>
                <option value={0.5}>±0.5 mV</option>
                <option value={1}>±1 mV</option>
                <option value={2}>±2 mV</option>
              </select>
            </label>
            <span className="heat-legend" aria-hidden>
              <i className="neg" /> − <i className="mid" /> + <i className="pos" />
            </span>
          </>
        )}

        <div className="ecg-toolbar-end">
          {caliper ? (
            <button className="text-btn" onClick={() => setCaliper(null)}>
              Clear caliper
            </button>
          ) : (
            <span className="hint">Drag to measure</span>
          )}
          <div className="segmented" role="radiogroup" aria-label="Paper colour">
            <button className={theme === "paper" ? "active" : ""} onClick={() => setTheme("paper")}>
              Paper
            </button>
            <button className={theme === "dark" ? "active" : ""} onClick={() => setTheme("dark")}>
              Dark
            </button>
          </div>
        </div>
      </div>

      <div className="ecg-canvas-wrap" ref={wrap}>
        <div className="ecg-canvas-stack" style={{ height: canvasH, width: canvasW }}>
          <canvas ref={base} />
          <canvas
            ref={overlay}
            className="ecg-overlay"
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={() => (drag.current = null)}
          />
        </div>
      </div>
    </div>
  );
}

const HEAT_LABEL_W = 44;

function drawHeatmap(
  ctx: CanvasRenderingContext2D,
  data: CaseData,
  src: Float32Array,
  W: number,
  H: number,
  theme: Theme,
  range: HeatRange,
  median: { values: Float32Array; len: number; rIndex: number } | null,
  scale: number,
  selectedLead: string,
  colours: (typeof THEMES)["paper"],
) {
  const L = data.leadNames.length;
  const rowH = H / L;
  const plotW = Math.max(10, W - HEAT_LABEL_W);
  const dpr = window.devicePixelRatio || 1;
  const pw = Math.round(plotW * dpr);
  const ph = Math.round(H * dpr);
  const img = ctx.createImageData(pw, ph);

  const useMedian = range === "median" && median;
  const len = useMedian ? median!.len : data.n;
  const sample = (l: number, x: number) => {
    const i = Math.min(len - 1, Math.floor((x / pw) * len));
    return useMedian ? median!.values[l * len + i] : src[l * data.n + i];
  };

  // Colour each (lead, column) once, then fill that lead's rows.
  const sep = theme === "paper" ? 235 : 8;
  for (let l = 0; l < L; l++) {
    const yA = Math.round((l / L) * ph);
    const yB = Math.round(((l + 1) / L) * ph);
    const yGap = yB - Math.max(1, Math.round((yB - yA) * 0.06));
    const row = new Uint8ClampedArray(pw * 4);
    for (let x = 0; x < pw; x++) {
      const [r, g, b] = diverging(sample(l, x) / scale, theme);
      row[x * 4] = r;
      row[x * 4 + 1] = g;
      row[x * 4 + 2] = b;
      row[x * 4 + 3] = 255;
    }
    for (let y = yA; y < yB; y++) {
      if (y >= yGap) {
        for (let x = 0; x < pw; x++) {
          const o = (y * pw + x) * 4;
          img.data[o] = img.data[o + 1] = img.data[o + 2] = sep;
          img.data[o + 3] = 255;
        }
      } else {
        img.data.set(row, y * pw * 4);
      }
    }
  }
  ctx.putImageData(img, Math.round(HEAT_LABEL_W * dpr), 0);

  ctx.font = `600 11px "IBM Plex Sans", system-ui, sans-serif`;
  ctx.textBaseline = "middle";
  data.leadNames.forEach((lead, l) => {
    ctx.fillStyle = lead === selectedLead ? colours.labelOn : colours.label;
    ctx.fillText(lead, 8, (l + 0.47) * rowH);
  });
  ctx.textBaseline = "alphabetic";

  // markers
  ctx.strokeStyle = theme === "paper" ? "rgba(0,0,0,0.55)" : "rgba(255,255,255,0.6)";
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  if (useMedian) {
    // R peak and the median J point (R + typical QRS half-width from delineation)
    const fs = data.fs;
    const beats = data.manifest.delineation.beats.filter((b) => b.samples?.qrsOff != null);
    const jOff = beats.length
      ? beats.map((b) => (b.samples.qrsOff as number) - b.rSample).sort((a, c) => a - c)[beats.length >> 1]
      : Math.round(0.05 * fs);
    for (const [idx, name] of [
      [median!.rIndex, "R"],
      [median!.rIndex + jOff, "J"],
      [median!.rIndex + jOff + Math.round(0.06 * fs), "J+60"],
    ] as const) {
      const x = HEAT_LABEL_W + (idx / median!.len) * plotW;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.save();
      ctx.setLineDash([]);
      ctx.fillStyle = colours.label;
      ctx.font = `500 10px "IBM Plex Mono", ui-monospace, monospace`;
      ctx.fillText(name, x + 3, 11);
      ctx.restore();
    }
  } else {
    for (const b of data.manifest.delineation.beats) {
      const x = HEAT_LABEL_W + (b.rSample / data.n) * plotW;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, 6);
    }
  }
  ctx.stroke();
  ctx.setLineDash([]);
}
