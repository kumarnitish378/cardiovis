import { create } from "zustand";
import { clock } from "./clock";
import { loadCase, loadIndex } from "./loader";
import type { CaseData, CaseIndexEntry } from "../types";

export type VcgChoice = "primary" | "alternate";

/** How much of the window the 12-lead panel is allowed to take. */
export type TraceMode = "all" | "selected" | "hidden";

const TRACE_HEIGHT_KEY = "cardiovis.traceHeight";
const TRACE_MODE_KEY = "cardiovis.traceMode";
const ROW_HEIGHT_KEY = "cardiovis.rowHeight";

interface State {
  cases: CaseIndexEntry[];
  caseId: string | null;
  data: CaseData | null;
  loading: boolean;
  error: string | null;

  /** Playback, in samples. The whole app is driven off this one index. */
  frame: number;
  playing: boolean;
  speed: number;
  loopBeat: boolean;
  currentBeat: number;

  selectedLead: string;
  showRaw: boolean;
  vcgChoice: VcgChoice;
  showModelDipole: boolean;
  showConduction: boolean;
  showAllLeadAxes: boolean;
  showLabels: boolean;
  /** Orientation and chamber names in 3D. Off by default: the lesson is the vector. */
  showAnatomy: boolean;
  trailMs: number;
  cameraPreset: string;
  electrodeOffsets: Record<string, number>;

  /** Trace-panel view window, in samples, and the vertical scaling. */
  viewStart: number;
  viewSpan: number;
  /** Amplitude zoom: multiplier on the shared mV scale. */
  gain: number;
  /** Row zoom: pixels of canvas per lead. The panel scrolls when the rows no
   *  longer fit, rather than squashing twelve leads into whatever is left. */
  rowHeight: number;
  followPlayhead: boolean;
  /** Drag draws a zoom rectangle instead of panning. */
  boxZoom: boolean;

  /** Layout. The 3D view takes whatever these leave it. */
  traceMode: TraceMode;
  traceHeight: number;
  /** Height to restore when switching back from the single-lead view. */
  tracesFullHeight: number | null;
  sidebarOpen: boolean;
  controlsExpanded: boolean;

  init: () => Promise<void>;
  selectCase: (path: string) => Promise<void>;
  setFrame: (f: number) => void;
  step: (deltaSamples: number) => void;
  togglePlay: () => void;
  setSpeed: (s: number) => void;
  setLoopBeat: (v: boolean) => void;
  setSelectedLead: (lead: string) => void;
  setShowRaw: (v: boolean) => void;
  setVcgChoice: (v: VcgChoice) => void;
  setShowModelDipole: (v: boolean) => void;
  setShowConduction: (v: boolean) => void;
  setShowAllLeadAxes: (v: boolean) => void;
  setShowLabels: (v: boolean) => void;
  setShowAnatomy: (v: boolean) => void;
  setTrailMs: (v: number) => void;
  setCameraPreset: (v: string) => void;
  gotoBeat: (index: number) => void;
  setElectrodeOffset: (lead: string, deg: number) => void;
  resetElectrodes: () => void;
  setView: (start: number, span: number) => void;
  zoomBy: (factor: number, anchorFraction?: number) => void;
  panBy: (samples: number) => void;
  zoomToBeat: (index: number) => void;
  resetView: () => void;
  setGain: (g: number) => void;
  zoomGainBy: (factor: number) => void;
  setRowHeight: (px: number) => void;
  zoomRowsBy: (factor: number) => void;
  setBoxZoom: (v: boolean) => void;
  zoomToRegion: (startSample: number, endSample: number, gainFactor?: number) => void;
  setFollowPlayhead: (v: boolean) => void;
  setTraceMode: (v: TraceMode) => void;
  setTraceHeight: (px: number) => void;
  toggleSidebar: () => void;
  setControlsExpanded: (v: boolean) => void;
}

function restore(key: string, fallback: number): number {
  const raw = typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function beatIndexForFrame(data: CaseData | null, frame: number): number {
  if (!data) return 0;
  const beats = data.manifest.delineation.beats;
  let idx = 0;
  for (let i = 0; i < beats.length; i++) {
    const start = beats[i].samples.pOn ?? beats[i].samples.qrsOn ?? beats[i].rSample;
    if (frame >= start) idx = i;
  }
  return idx;
}

export const useStore = create<State>((set, get) => ({
  cases: [],
  caseId: null,
  data: null,
  loading: false,
  error: null,

  frame: 0,
  playing: false,
  speed: 0.25,
  loopBeat: true,
  currentBeat: 0,

  selectedLead: "aVR",
  showRaw: false,
  vcgChoice: "primary",
  showModelDipole: false,
  showConduction: true,
  showAllLeadAxes: false,
  showLabels: true,
  showAnatomy: false,
  trailMs: 400,
  cameraPreset: "oblique",
  electrodeOffsets: {},

  viewStart: 0,
  viewSpan: 0,          // 0 means "the whole recording"; resolved once data loads
  gain: 1,
  rowHeight: restore(ROW_HEIGHT_KEY, 28),
  followPlayhead: true,
  boxZoom: false,

  traceMode: (typeof localStorage !== "undefined"
    ? ((localStorage.getItem(TRACE_MODE_KEY) as TraceMode | null) ?? "all")
    : "all"),
  // Default leaves the 3D stage the larger share on short (projector) screens.
  traceHeight: restore(TRACE_HEIGHT_KEY, typeof window !== "undefined" ? Math.round(Math.min(400, window.innerHeight * 0.36)) : 230),
  tracesFullHeight: null,
  sidebarOpen: true,
  controlsExpanded: false,

  async init() {
    set({ loading: true, error: null });
    try {
      const cases = await loadIndex();
      set({ cases });
      if (cases.length) await get().selectCase(cases[0].path);
    } catch (e) {
      set({ error: (e as Error).message });
    } finally {
      set({ loading: false });
    }
  },

  async selectCase(path: string) {
    set({ loading: true, error: null, playing: false });
    try {
      const data = await loadCase(path);
      const firstBeat = data.manifest.delineation.beats[0];
      const start = firstBeat?.samples.pOn ?? firstBeat?.samples.qrsOn ?? 0;
      clock.frame = start ?? 0;
      set({ data, caseId: path, frame: start ?? 0, currentBeat: 0,
            viewStart: 0, viewSpan: data.n });
    } catch (e) {
      set({ error: (e as Error).message, data: null });
    } finally {
      set({ loading: false });
    }
  },

  setFrame(f) {
    const { data } = get();
    if (!data) return;
    const frame = Math.max(0, Math.min(data.n - 1, Math.round(f)));
    clock.frame = frame;            // the scene reads the clock, not the store
    set({ frame, currentBeat: beatIndexForFrame(data, frame) });
  },

  step(deltaSamples) {
    get().setFrame(get().frame + deltaSamples);
  },

  togglePlay: () => set((s) => ({ playing: !s.playing })),
  setSpeed: (speed) => set({ speed }),
  setLoopBeat: (loopBeat) => set({ loopBeat }),
  setSelectedLead: (selectedLead) => set({ selectedLead }),
  setShowRaw: (showRaw) => set({ showRaw }),
  setVcgChoice: (vcgChoice) => set({ vcgChoice }),
  setShowModelDipole: (showModelDipole) => set({ showModelDipole }),
  setShowConduction: (showConduction) => set({ showConduction }),
  setShowAllLeadAxes: (showAllLeadAxes) => set({ showAllLeadAxes }),
  setShowLabels: (showLabels) => set({ showLabels }),
  setShowAnatomy: (showAnatomy) => set({ showAnatomy }),
  setTrailMs: (trailMs) => set({ trailMs }),
  setCameraPreset: (cameraPreset) => set({ cameraPreset }),

  gotoBeat(index) {
    const { data } = get();
    if (!data) return;
    const beats = data.manifest.delineation.beats;
    if (!beats.length) return;
    const i = Math.max(0, Math.min(beats.length - 1, index));
    const b = beats[i];
    const start = b.samples.pOn ?? b.samples.qrsOn ?? b.rSample;
    clock.frame = start;
    set({ frame: start, currentBeat: i });
  },

  setView(start, span) {
    const { data } = get();
    if (!data) return;
    // A window narrower than ~20 ms is not a view of anything, and one wider
    // than the recording is just the recording.
    const minSpan = Math.max(8, Math.round(0.02 * data.fs));
    const clampedSpan = Math.max(minSpan, Math.min(data.n, Math.round(span)));
    const clampedStart = Math.max(0, Math.min(data.n - clampedSpan, Math.round(start)));
    set({ viewStart: clampedStart, viewSpan: clampedSpan });
  },

  zoomBy(factor, anchorFraction = 0.5) {
    const { data, viewStart, viewSpan } = get();
    if (!data) return;
    const span = viewSpan || data.n;
    const anchorSample = viewStart + anchorFraction * span;
    const nextSpan = span / factor;
    // Keep whatever is under the pointer under the pointer.
    get().setView(anchorSample - anchorFraction * nextSpan, nextSpan);
  },

  panBy(samples) {
    const { viewStart, viewSpan, data } = get();
    if (!data) return;
    get().setView(viewStart + samples, viewSpan || data.n);
    set({ followPlayhead: false });
  },

  zoomToBeat(index) {
    const { data } = get();
    if (!data) return;
    const beat = data.manifest.delineation.beats[index];
    const [lo, hi] = beatSpan(data, index);
    const span = hi - lo;
    if (!beat) {
      get().setView(lo, span);
      return;
    }
    // Centre on the QRS, not on the beat-span midpoint. The first beat of a
    // strip often starts mid-cycle, and centring on its span put the QRS just
    // off the left edge - a "fit beat" that did not show the beat.
    const centre = beat.samples.qrsOn ?? beat.rSample;
    get().setView(centre - span * 0.35, span);
  },

  resetView() {
    const { data } = get();
    if (!data) return;
    set({ viewStart: 0, viewSpan: data.n, gain: 1, followPlayhead: true });
  },

  setGain: (gain) => set({ gain: Math.max(0.2, Math.min(16, gain)) }),
  zoomGainBy: (factor) => get().setGain(get().gain * factor),

  setRowHeight(px) {
    const clamped = Math.max(16, Math.min(320, Math.round(px)));
    try {
      localStorage.setItem(ROW_HEIGHT_KEY, String(clamped));
    } catch {
      /* preference just will not stick */
    }
    set({ rowHeight: clamped });
  },
  zoomRowsBy: (factor) => get().setRowHeight(get().rowHeight * factor),
  setBoxZoom: (boxZoom) => set({ boxZoom }),

  /** Area zoom: a time window, and optionally an amplitude factor from the
   *  height of the dragged rectangle. */
  zoomToRegion(startSample, endSample, gainFactor) {
    const lo = Math.min(startSample, endSample);
    const hi = Math.max(startSample, endSample);
    get().setView(lo, hi - lo);
    set({ followPlayhead: false });
    if (gainFactor && isFinite(gainFactor)) get().setGain(get().gain * gainFactor);
  },
  setFollowPlayhead: (followPlayhead) => set({ followPlayhead }),

  setElectrodeOffset(lead, deg) {
    set((s) => ({ electrodeOffsets: { ...s.electrodeOffsets, [lead]: deg } }));
  },
  resetElectrodes: () => set({ electrodeOffsets: {} }),

  setTraceMode(v) {
    try {
      localStorage.setItem(TRACE_MODE_KEY, v);
    } catch {
      /* private mode, or storage disabled - the preference just will not stick */
    }
    // One lead does not need the height twelve did, so hand the difference to
    // the 3D view - and give it back when all twelve come back.
    const { traceMode, traceHeight } = get();
    if (v === "selected" && traceMode === "all") {
      set({ traceMode: v, tracesFullHeight: traceHeight, traceHeight: Math.min(traceHeight, 120) });
      return;
    }
    if (v === "all" && traceMode === "selected") {
      set({ traceMode: v, traceHeight: get().tracesFullHeight ?? traceHeight });
      return;
    }
    set({ traceMode: v });
  },

  setTraceHeight(px) {
    const clamped = Math.max(90, Math.min(window.innerHeight * 0.6, px));
    try {
      localStorage.setItem(TRACE_HEIGHT_KEY, String(Math.round(clamped)));
    } catch {
      /* as above */
    }
    set({ traceHeight: clamped });
  },

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setControlsExpanded: (controlsExpanded) => set({ controlsExpanded }),
}));

/** Sample range of a beat, used by single-beat looping and the trace panel. */
export function beatSpan(data: CaseData, index: number): [number, number] {
  const beats = data.manifest.delineation.beats;
  const b = beats[index];
  if (!b) return [0, data.n - 1];
  const start = b.samples.pOn ?? b.samples.qrsOn ?? b.rSample;
  const next = beats[index + 1];
  const end = next
    ? (next.samples.pOn ?? next.samples.qrsOn ?? next.rSample)
    : Math.min(data.n - 1, (b.samples.tOff ?? b.rSample) + Math.round(0.15 * data.fs));
  return [Math.max(0, start), Math.min(data.n - 1, end)];
}
