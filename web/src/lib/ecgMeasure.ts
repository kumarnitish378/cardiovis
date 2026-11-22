import type { CaseData } from "../types";

/**
 * Per-lead clinical measurements computed in the browser from the displayed
 * signal (filtered or unfiltered, whichever the user is viewing), over every
 * delineated beat, reported as the median across beats.
 *
 *   baseline  median of the PR segment, 40 -> 10 ms before QRS onset
 *   J point   QRS offset
 *   ST60      mean over J+55..J+65 ms, minus baseline
 *   R / S     max / min over the QRS window, minus baseline
 *
 * Thresholds are the commonly cited adult reference values (AHA/ACCF/HRS
 * recommendations for interval reference ranges; Fourth Universal Definition
 * of MI for J-point deviation). They mark a measurement as outside a range -
 * they are not an interpretation. Every number here is automated and should
 * be checked against the tracing.
 */

export interface LeadMeasure {
  lead: string;
  stJ: number; // mV at the J point
  st60: number; // mV at J+60 ms
  r: number; // mV
  s: number; // mV (negative)
  /** J-point deviation beyond the lead's threshold: +1 elevation, -1 depression, 0 none */
  stFlag: -1 | 0 | 1;
  stThreshold: number; // mV, elevation threshold used for this lead
}

export const TERRITORIES: Array<{ name: string; leads: string[] }> = [
  { name: "Inferior", leads: ["II", "III", "aVF"] },
  { name: "Lateral", leads: ["I", "aVL", "V5", "V6"] },
  { name: "Septal", leads: ["V1", "V2"] },
  { name: "Anterior", leads: ["V3", "V4"] },
  { name: "Right", leads: ["aVR"] },
];

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const a = [...xs].sort((p, q) => p - q);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function sexOf(data: CaseData): "M" | "F" | null {
  const s = String(data.manifest.subject.sex ?? "").toUpperCase();
  return s.startsWith("M") ? "M" : s.startsWith("F") ? "F" : null;
}

function ageAtLeast40(data: CaseData): boolean | null {
  const band = String(data.manifest.subject.ageBand ?? "");
  const lo = parseInt(band, 10);
  return Number.isFinite(lo) ? lo >= 40 : null;
}

/** J-point elevation threshold in mV (Fourth UDMI). */
function stThreshold(lead: string, data: CaseData): number {
  if (lead === "V2" || lead === "V3") {
    const sex = sexOf(data);
    if (sex === "F") return 0.15;
    if (sex === "M") return ageAtLeast40(data) === false ? 0.25 : 0.2;
    return 0.2;
  }
  return 0.1;
}
const ST_DEPRESSION = -0.05;

export function measureLeads(data: CaseData, raw: boolean): LeadMeasure[] {
  const src = raw ? data.leadsRaw : data.leads;
  const fs = data.fs;
  const beats = data.manifest.delineation.beats.filter(
    (b) => b.samples?.qrsOn != null && b.samples?.qrsOff != null,
  );
  const ms = (x: number) => Math.round((x / 1000) * fs);

  return data.leadNames.map((lead, li) => {
    const off = li * data.n;
    const at = (i: number) => src[off + Math.max(0, Math.min(data.n - 1, i))];
    const stJ: number[] = [];
    const st60: number[] = [];
    const r: number[] = [];
    const s: number[] = [];
    for (const b of beats) {
      const on = b.samples.qrsOn as number;
      const jp = b.samples.qrsOff as number;
      if (on - ms(40) < 0 || jp + ms(70) >= data.n) continue;
      const base: number[] = [];
      for (let i = on - ms(40); i <= on - ms(10); i++) base.push(at(i));
      const b0 = median(base);
      stJ.push(at(jp) - b0);
      let acc = 0;
      let cnt = 0;
      for (let i = jp + ms(55); i <= jp + ms(65); i++) {
        acc += at(i);
        cnt++;
      }
      st60.push(acc / cnt - b0);
      let hi = -Infinity;
      let lo = Infinity;
      for (let i = on; i <= jp; i++) {
        const v = at(i);
        if (v > hi) hi = v;
        if (v < lo) lo = v;
      }
      r.push(Math.max(0, hi - b0));
      s.push(Math.min(0, lo - b0));
    }
    const j = median(stJ);
    const thr = stThreshold(lead, data);
    // aVR elevation is reported but not flagged against the generic threshold.
    const flag: -1 | 0 | 1 = !Number.isFinite(j) ? 0 : j >= thr && lead !== "aVR" ? 1 : j <= ST_DEPRESSION ? -1 : 0;
    return { lead, stJ: j, st60: median(st60), r: median(r), s: median(s), stFlag: flag, stThreshold: thr };
  });
}

export type RangeFlag = "low" | "high" | "ok" | "na";

export interface IntervalRow {
  key: string;
  label: string;
  value: number | null;
  unit: string;
  range: string;
  flag: RangeFlag;
  device?: number | null;
}

function flagOf(v: number | null | undefined, lo: number | null, hi: number | null): RangeFlag {
  if (v == null || !Number.isFinite(v)) return "na";
  if (lo != null && v < lo) return "low";
  if (hi != null && v > hi) return "high";
  return "ok";
}

export function intervalRows(data: CaseData): IntervalRow[] {
  const i = data.manifest.metrics.intervals;
  const a = data.manifest.metrics.axes;
  const dev = i.deviceReported ?? {};
  const sex = sexOf(data);
  const qtcHi = sex === "M" ? 450 : 460;
  return [
    { key: "hr", label: "Heart rate", value: i.heartRateBpm, unit: "bpm", range: "60–100", flag: flagOf(i.heartRateBpm, 60, 100), device: dev.rrMs ? 60000 / dev.rrMs : null },
    { key: "pr", label: "PR", value: i.prMs, unit: "ms", range: "120–200", flag: flagOf(i.prMs, 120, 200), device: dev.prMs },
    { key: "qrs", label: "QRS", value: i.qrsMs, unit: "ms", range: "< 120", flag: flagOf(i.qrsMs, null, 119.9), device: dev.qrsMs },
    { key: "qt", label: "QT", value: i.qtMs, unit: "ms", range: "", flag: "na", device: dev.qtMs },
    { key: "qtcb", label: "QTc Bazett", value: i.qtcBazettMs, unit: "ms", range: `≤ ${qtcHi}`, flag: flagOf(i.qtcBazettMs, null, qtcHi), device: dev.qtcMs },
    { key: "qtcf", label: "QTc Fridericia", value: i.qtcFridericiaMs, unit: "ms", range: `≤ ${qtcHi}`, flag: flagOf(i.qtcFridericiaMs, null, qtcHi) },
    { key: "axis", label: "QRS axis", value: a.frontalQrsAxisDeg, unit: "°", range: "−30 to +90", flag: flagOf(a.frontalQrsAxisDeg, -30, 90), device: a.deviceReported?.qrsAxisDeg },
  ];
}
