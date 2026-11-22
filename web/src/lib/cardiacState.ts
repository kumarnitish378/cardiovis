import type { CaseData } from "../types";

/**
 * Mechanical state of the heart at a sample - TIER 3, illustrative, but timed
 * entirely by this recording's own beat fiducials (Tier 2 delineation):
 *
 *   ventricles  contraction begins ~50 ms after QRS onset (electromechanical
 *               delay), shortening continues through ejection to a maximum at
 *               the end of the T wave, then relaxes quickly (rapid filling).
 *   atria       contract after the P wave: rise from P peak to QRS onset,
 *               relax over the next ~100 ms. A beat with no P wave (atrial
 *               fibrillation) gets no organised atrial contraction - which is
 *               the physiology, not a gap in the model.
 *
 * The time derivatives are returned too: blood moves when volume changes, so
 * ejection follows +d(ventricles)/dt and filling follows -d(ventricles)/dt.
 */

export interface CardiacState {
  /** 0 relaxed -> 1 fully contracted */
  atria: number;
  ventricles: number;
  /** per second of signal time */
  dAtria: number;
  dVentricles: number;
  available: boolean;
}

const EMD_S = 0.05; // electromechanical delay
const VENT_RELAX_S = 0.16;
const ATRIAL_RELAX_S = 0.1;

const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/** 0 before `a`, rising to 1 at `b`, falling back to 0 by `c`. */
function envelope(t: number, a: number, b: number, c: number): number {
  if (t <= a || t >= c) return 0;
  if (t < b) return smooth((t - a) / (b - a));
  return 1 - smooth((t - b) / (c - b));
}

function levels(data: CaseData, frame: number): { atria: number; ventricles: number } | null {
  const beats = data.manifest.delineation?.beats;
  if (!beats || beats.length === 0) return null;
  const fs = data.fs;
  let atria = 0;
  let ventricles = 0;
  let any = false;
  for (const beat of beats) {
    const s = beat.samples ?? {};
    const qrsOn = s.qrsOn ?? (beat.rSample != null ? beat.rSample - 0.04 * fs : null);
    const tOff = s.tOff ?? (qrsOn != null ? qrsOn + 0.38 * fs : null);
    if (qrsOn == null || tOff == null) continue;
    any = true;
    const vStart = qrsOn + EMD_S * fs;
    if (frame > vStart - fs && frame < tOff + fs) {
      ventricles = Math.max(ventricles, envelope(frame, vStart, Math.max(vStart + 0.12 * fs, tOff), tOff + VENT_RELAX_S * fs));
    }
    const pPeak = s.pPeak ?? s.pOn;
    if (pPeak != null) {
      const aStart = pPeak;
      const aPeak = Math.max(aStart + 0.04 * fs, qrsOn);
      atria = Math.max(atria, envelope(frame, aStart, aPeak, aPeak + ATRIAL_RELAX_S * fs));
    }
  }
  return any ? { atria, ventricles } : null;
}

export function cardiacState(data: CaseData | null, frame: number): CardiacState {
  if (!data) return { atria: 0, ventricles: 0, dAtria: 0, dVentricles: 0, available: false };
  const now = levels(data, frame);
  if (!now) return { atria: 0, ventricles: 0, dAtria: 0, dVentricles: 0, available: false };
  const h = Math.max(1, Math.round(0.01 * data.fs)); // 10 ms finite difference
  const prev = levels(data, frame - h) ?? now;
  const dt = h / data.fs;
  return {
    atria: now.atria,
    ventricles: now.ventricles,
    dAtria: (now.atria - prev.atria) / dt,
    dVentricles: (now.ventricles - prev.ventricles) / dt,
    available: true,
  };
}
