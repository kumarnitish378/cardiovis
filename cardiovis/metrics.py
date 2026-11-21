"""Derived metrics (all Tier 2) - quantities recoverable from 8 independent
leads by defensible arithmetic.

Everything here states its own definition. Where more than one convention is in
clinical use (QTc above all), both are computed and the formula is carried in
the output: a QTc with the correction hidden is not a measurement.

Angles use the anatomical frame from leads.py:
    +x subject left, +y subject foot (inferior), +z subject back (posterior)

    frontal axis   = atan2(y, x)              0 deg = lead I, +90 deg = aVF
    azimuth        = atan2(z, x)              0 deg = left, +90 deg = posterior
    elevation      = atan2(y, hypot(x, z))    +90 deg = straight inferior
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

from .delineate import Beat, Delineation
from .ecg_parser.base import WaveformBlock
from .vcg import Vcg


def frontal_angle_deg(v: np.ndarray) -> float:
    return float(np.degrees(np.arctan2(v[1], v[0])))


def azimuth_deg(v: np.ndarray) -> float:
    return float(np.degrees(np.arctan2(v[2], v[0])))


def elevation_deg(v: np.ndarray) -> float:
    return float(np.degrees(np.arctan2(v[1], math.hypot(v[0], v[2]))))


def angle_between_deg(a: np.ndarray, b: np.ndarray) -> float:
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    if na < 1e-12 or nb < 1e-12:
        return float("nan")
    c = float(np.clip(np.dot(a, b) / (na * nb), -1.0, 1.0))
    return float(np.degrees(np.arccos(c)))


def qtc_bazett(qt_ms: float, rr_ms: float) -> float:
    return qt_ms / math.sqrt(rr_ms / 1000.0)


def qtc_fridericia(qt_ms: float, rr_ms: float) -> float:
    return qt_ms / (rr_ms / 1000.0) ** (1.0 / 3.0)


def _loop_planarity(points: np.ndarray) -> dict:
    """SVD of the loop. A perfectly planar loop has a zero third singular value.

    `planarityRatio` is s3/(s1+s2+s3): 0 = flat, larger = more three-dimensional.
    `normal` is the unit normal of the best-fit plane (the loop plane).
    """
    if points.shape[1] < 3:
        return {"planarityRatio": None, "normal": None, "singularValues": None}
    centred = points - points.mean(axis=1, keepdims=True)
    u, s, _ = np.linalg.svd(centred, full_matrices=False)
    total = float(s.sum()) or 1e-12
    return {
        "planarityRatio": float(s[2] / total),
        "normal": [float(x) for x in u[:, 2]],
        "singularValues": [float(x) for x in s],
    }


def _polygon_area(x: np.ndarray, y: np.ndarray) -> float:
    """Shoelace area of the closed projection - the loop's 'roundness' in that
    plane. Units mV^2."""
    if len(x) < 3:
        return 0.0
    return float(0.5 * abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))))


@dataclass
class Metrics:
    intervals: dict = field(default_factory=dict)
    axes: dict = field(default_factory=dict)
    loops: dict = field(default_factory=dict)
    vectors: dict = field(default_factory=dict)
    provenance: dict = field(default_factory=dict)

    def to_json(self) -> dict:
        def clean(o):
            if isinstance(o, dict):
                return {k: clean(v) for k, v in o.items()}
            if isinstance(o, (list, tuple)):
                return [clean(v) for v in o]
            if isinstance(o, (np.floating, float)):
                f = float(o)
                return None if not math.isfinite(f) else round(f, 4)
            if isinstance(o, (np.integer, int)):
                return int(o)
            return o

        return clean({
            "intervals": self.intervals,
            "axes": self.axes,
            "loops": self.loops,
            "vectors": self.vectors,
            "provenance": self.provenance,
        })


def _net_area(x: np.ndarray, lo: int, hi: int, fs: float) -> float:
    """Net (signed) area under a lead between two samples, in mV.ms."""
    if hi <= lo:
        return 0.0
    seg = np.nan_to_num(x[lo:hi], nan=0.0)
    return float(np.trapezoid(seg, dx=1000.0 / fs))


def representative_beat(delin: Delineation) -> Beat | None:
    """The beat whose intervals sit closest to the medians - used for the single
    numbers the UI shows, so they come from one real beat rather than from a
    blend of several."""
    beats = [b for b in delin.beats
             if b.qrs_on is not None and b.qrs_off is not None and b.t_off is not None]
    if not beats:
        return delin.beats[0] if delin.beats else None
    qrs = np.array([b.qrs_off - b.qrs_on for b in beats], dtype=float)
    med = np.median(qrs)
    conf = np.array([b.confidence for b in beats])
    score = np.abs(qrs - med) / (med + 1e-9) - conf
    return beats[int(np.argmin(score))]


def compute(vcg: Vcg, delin: Delineation, block: WaveformBlock,
            device_measurements: dict | None = None) -> Metrics:
    """All Tier-2 metrics for one recording."""
    fs = vcg.sample_rate_hz
    m = Metrics()
    device_measurements = device_measurements or {}

    # ------------------------------------------------------------ intervals
    s = delin.summary
    qt, rr = s.get("qtMs"), s.get("rrMs")
    m.intervals = {
        "rrMs": s.get("rrMs"),
        "heartRateBpm": s.get("heartRateBpm"),
        "prMs": s.get("prMs"),
        "pDurationMs": s.get("pDurationMs"),
        "qrsMs": s.get("qrsMs"),
        "qtMs": qt,
        "qtcBazettMs": qtc_bazett(qt, rr) if qt and rr else None,
        "qtcFridericiaMs": qtc_fridericia(qt, rr) if qt and rr else None,
        "qtcNote": ("Bazett over-corrects at high heart rates and under-corrects at low "
                    "ones; Fridericia is shown alongside it. Neither is 'the' QTc."),
        "beatCount": s.get("beatCount"),
        "rrCoefficientOfVariation": s.get("rrCoefficientOfVariation"),
        "rmssdMs": s.get("rmssdMs"),
    }
    if device_measurements:
        m.intervals["deviceReported"] = {
            "prMs": device_measurements.get("PR_Interval"),
            "qrsMs": device_measurements.get("QRS_Duration"),
            "qtMs": device_measurements.get("QT_Interval"),
            "qtcMs": device_measurements.get("QT_Corrected"),
            "qtcCorrection": device_measurements.get("QTc_correction"),
            "pDurationMs": device_measurements.get("P_Dur"),
            "rrMs": device_measurements.get("RR_Interval"),
            "note": ("Reported by the acquisition device algorithm, shown for "
                     "comparison with our own delineation. Neither is ground truth."),
        }

    # -------------------------------------------- per-beat vectors and loops
    beats = [b for b in delin.beats if b.qrs_on is not None and b.qrs_off is not None]
    mean_qrs_vectors, mean_t_vectors, peak_qrs_vectors, peak_t_vectors = [], [], [], []
    qrs_axes_leadbased = []

    aVF = block.signals.get("aVF")
    I = block.signals.get("I")

    for b in beats:
        qrs = vcg.slice(b.qrs_on, b.qrs_off)
        if qrs.shape[1] >= 2:
            mean_qrs_vectors.append(qrs.mean(axis=1))
            peak_qrs_vectors.append(qrs[:, int(np.argmax(np.linalg.norm(qrs, axis=0)))])
        if b.t_off is not None and b.qrs_off is not None:
            t_start = b.qrs_off + int(0.04 * fs)
            t = vcg.slice(t_start, b.t_off)
            if t.shape[1] >= 2:
                mean_t_vectors.append(t.mean(axis=1))
                peak_t_vectors.append(t[:, int(np.argmax(np.linalg.norm(t, axis=0)))])
        if I is not None and aVF is not None:
            # The classical bedside construction: net QRS area in two limb leads.
            ai = _net_area(I, b.qrs_on, b.qrs_off, fs)
            af = _net_area(aVF, b.qrs_on, b.qrs_off, fs)
            if abs(ai) + abs(af) > 1e-9:
                qrs_axes_leadbased.append(math.degrees(math.atan2(af, ai)))

    def _median_vec(vs):
        return np.median(np.vstack(vs), axis=0) if vs else None

    mqrs = _median_vec(mean_qrs_vectors)
    mt = _median_vec(mean_t_vectors)
    pqrs = _median_vec(peak_qrs_vectors)
    pt = _median_vec(peak_t_vectors)

    def _circ_median(angles_deg):
        if not angles_deg:
            return None
        a = np.deg2rad(angles_deg)
        return float(np.degrees(np.arctan2(np.median(np.sin(a)), np.median(np.cos(a)))))

    m.axes = {
        "frontalQrsAxisDeg": _circ_median(qrs_axes_leadbased),
        "frontalQrsAxisMethod": "atan2(net QRS area in aVF, net QRS area in I)",
        "frontalQrsAxisFromVcgDeg": frontal_angle_deg(mqrs) if mqrs is not None else None,
        "frontalTAxisFromVcgDeg": frontal_angle_deg(mt) if mt is not None else None,
        "qrsAzimuthDeg": azimuth_deg(mqrs) if mqrs is not None else None,
        "qrsElevationDeg": elevation_deg(mqrs) if mqrs is not None else None,
        "tAzimuthDeg": azimuth_deg(mt) if mt is not None else None,
        "tElevationDeg": elevation_deg(mt) if mt is not None else None,
        "spatialQrsTAngleDeg": (angle_between_deg(mqrs, mt)
                                if mqrs is not None and mt is not None else None),
        "peakQrsTAngleDeg": (angle_between_deg(pqrs, pt)
                             if pqrs is not None and pt is not None else None),
        "deviceReported": {
            "pAxisDeg": device_measurements.get("P_Axis"),
            "qrsAxisDeg": device_measurements.get("R_Axis"),
            "tAxisDeg": device_measurements.get("T_Axis"),
        } if device_measurements else None,
    }

    m.vectors = {
        "meanQrsMv": [float(x) for x in mqrs] if mqrs is not None else None,
        "meanTMv": [float(x) for x in mt] if mt is not None else None,
        "peakQrsMv": [float(x) for x in pqrs] if pqrs is not None else None,
        "peakQrsMagnitudeMv": float(np.linalg.norm(pqrs)) if pqrs is not None else None,
        "peakTMv": [float(x) for x in pt] if pt is not None else None,
        "peakTMagnitudeMv": float(np.linalg.norm(pt)) if pt is not None else None,
    }

    # --------------------------------------------------- loop shape metrics
    rep = representative_beat(delin)
    loops: dict = {}
    if rep is not None and rep.qrs_on is not None and rep.qrs_off is not None:
        qrs_pts = vcg.slice(rep.qrs_on, rep.qrs_off)
        loops["qrs"] = _loop_planarity(qrs_pts)
        loops["qrs"]["areaFrontalMvSq"] = _polygon_area(qrs_pts[0], qrs_pts[1])
        loops["qrs"]["areaHorizontalMvSq"] = _polygon_area(qrs_pts[0], qrs_pts[2])
        loops["qrs"]["areaSagittalMvSq"] = _polygon_area(qrs_pts[2], qrs_pts[1])
        mags = np.linalg.norm(qrs_pts, axis=0)
        loops["qrs"]["maxMagnitudeMv"] = float(mags.max()) if mags.size else None
        loops["qrs"]["timeToMaxMs"] = (float(np.argmax(mags) / fs * 1000.0)
                                       if mags.size else None)
        if rep.t_off is not None:
            t_pts = vcg.slice(rep.qrs_off + int(0.04 * fs), rep.t_off)
            if t_pts.shape[1] >= 3:
                loops["t"] = _loop_planarity(t_pts)
                loops["t"]["areaFrontalMvSq"] = _polygon_area(t_pts[0], t_pts[1])
                tm = np.linalg.norm(t_pts, axis=0)
                loops["t"]["maxMagnitudeMv"] = float(tm.max()) if tm.size else None
        loops["representativeBeatIndex"] = rep.index
    m.loops = loops

    m.provenance = {
        "tier": 2,
        "vcgMethod": vcg.method,
        "vcgCitation": vcg.citation,
        "beatsUsed": len(beats),
        "note": ("Derived from this recording by linear transform of the 8 independent "
                 "leads. Patient-specific, but a single equivalent dipole - not a map "
                 "of where in the myocardium current is flowing."),
    }
    return m
