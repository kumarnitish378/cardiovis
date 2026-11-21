"""Fiducial detection: QRS detection and P/QRS/T boundary delineation.

Two stages:

1. **QRS detection** - Pan & Tompkins (1985): bandpass 5-15 Hz, derivative,
   squaring, moving-window integration, dual adaptive thresholds with
   search-back and T-wave discrimination. Run on the root-mean-square across
   the 8 independent leads rather than on lead II alone, so a single detached
   electrode does not take detection down with it.

2. **Wave boundaries** - a multiscale first-derivative transform. Martinez et
   al. (2004) delineate with a quadratic-spline wavelet whose transform is a
   smoothed derivative of the signal; we use a Gaussian-derivative filter bank,
   which is the same idea with a symmetric (therefore exactly zero-phase)
   kernel: boundaries are found by thresholding the cross-lead RMS of the
   derivative envelope at the scale where each wave has its energy. This is
   *not* a literal reimplementation of the published filter bank - see
   METHODS.md for what that means for accuracy, and for the LUDB benchmark that
   is the acceptance gate before any public release.

Failure is explicit. Irregular rhythm, wide QRS, absent P waves, low template
consistency and pacing marks each raise a structured warning that travels into
frames.json, and the conduction model (Tier 3) refuses to claim applicability
when they fire.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy import ndimage, signal as sig

from .ecg_parser.base import INDEPENDENT_LEADS, WaveformBlock
from .leads import multi_lead_rms

SEVERITY_ORDER = {"info": 0, "warning": 1, "critical": 2}

#: Fraction of the peak QRS derivative envelope at which the QRS is declared to
#: have started or ended. This is a real trade-off and it moves measurements: on
#: the bundled sample, 0.08 gives a 98 ms QRS, 0.12 gives 94 ms, 0.16 gives
#: 88 ms and 0.25 gives 78 ms (the acquisition device reports 86 ms). A high
#: threshold truncates the low-amplitude onset of a wide, slurred QRS - exactly
#: the beats that matter most - so we sit deliberately on the generous side and
#: publish the number rather than tuning it until it matches one vendor.
QRS_BOUNDARY_FRACTION = 0.12


@dataclass
class Warning:
    code: str
    severity: str           # info | warning | critical
    message: str
    detail: dict = field(default_factory=dict)

    def to_json(self) -> dict:
        return {"code": self.code, "severity": self.severity,
                "message": self.message, "detail": self.detail}


@dataclass
class Beat:
    index: int
    r: int
    qrs_on: int | None = None
    qrs_off: int | None = None
    p_on: int | None = None
    p_peak: int | None = None
    p_off: int | None = None
    t_peak: int | None = None
    t_off: int | None = None
    rr_samples: float | None = None
    confidence: float = 0.0
    flags: list[str] = field(default_factory=list)

    def to_json(self, fs: float) -> dict:
        def ms(v):
            return None if v is None else round(v / fs * 1000.0, 2)

        return {
            "index": self.index,
            "rSample": int(self.r),
            "samples": {
                "pOn": self.p_on, "pPeak": self.p_peak, "pOff": self.p_off,
                "qrsOn": self.qrs_on, "qrsOff": self.qrs_off,
                "tPeak": self.t_peak, "tOff": self.t_off,
            },
            "ms": {
                "pOn": ms(self.p_on), "pPeak": ms(self.p_peak), "pOff": ms(self.p_off),
                "qrsOn": ms(self.qrs_on), "qrsOff": ms(self.qrs_off),
                "r": ms(self.r), "tPeak": ms(self.t_peak), "tOff": ms(self.t_off),
            },
            "rrMs": ms(self.rr_samples),
            "confidence": round(self.confidence, 3),
            "flags": self.flags,
        }


@dataclass
class Delineation:
    fs: float
    beats: list[Beat]
    warnings: list[Warning]
    summary: dict[str, float]
    detector: str = "pan-tompkins(multi-lead RMS) + multiscale derivative boundaries"

    @property
    def usable(self) -> bool:
        return not any(w.severity == "critical" for w in self.warnings) and len(self.beats) >= 1

    @property
    def model_applicable(self) -> bool:
        """Whether the Tier-3 conduction model may claim it is anchored to this
        recording. False for irregular rhythm, missing P waves, pacing."""
        blocking = {"IRREGULAR_RHYTHM", "NO_P_WAVES", "PACE_MARKS",
                    "PACING_SPIKES_DETECTED", "LOW_TEMPLATE_CONSISTENCY",
                    "TOO_FEW_BEATS", "NO_BEATS"}
        return self.usable and not any(w.code in blocking for w in self.warnings)

    def to_json(self) -> dict:
        return {
            "detector": self.detector,
            "sampleRateHz": self.fs,
            "beats": [b.to_json(self.fs) for b in self.beats],
            "summary": {k: (round(v, 2) if isinstance(v, float) else v)
                        for k, v in self.summary.items()},
            "warnings": [w.to_json() for w in self.warnings],
            "usable": self.usable,
            "modelApplicable": self.model_applicable,
        }


# --------------------------------------------------------------------------- #
# Pan-Tompkins
# --------------------------------------------------------------------------- #

def _pt_integration(x: np.ndarray, fs: float) -> np.ndarray:
    lo, hi = 5.0 / (fs / 2), min(15.0 / (fs / 2), 0.98)
    b, a = sig.butter(2, [lo, hi], btype="bandpass")
    bp = sig.filtfilt(b, a, x)
    deriv = np.convolve(bp, np.array([1, 2, 0, -2, -1]) * (fs / 8.0), mode="same")
    squared = deriv ** 2
    win = max(1, int(round(0.150 * fs)))
    return np.convolve(squared, np.ones(win) / win, mode="same")


def pan_tompkins(x: np.ndarray, fs: float) -> tuple[np.ndarray, np.ndarray]:
    """Return (qrs sample indices, integrated detection signal).

    Pan J, Tompkins WJ. A real-time QRS detection algorithm.
    IEEE Trans Biomed Eng. 1985;32(3):230-236.
    """
    mwi = _pt_integration(x, fs)
    refractory = int(round(0.200 * fs))
    peaks, _ = sig.find_peaks(mwi, distance=refractory)
    if len(peaks) == 0:
        return np.array([], dtype=int), mwi

    learn = mwi[: int(round(2.0 * fs))] if len(mwi) > 2 * fs else mwi
    spki = float(np.max(learn)) * 0.25 if learn.size else 0.0
    npki = float(np.mean(learn)) * 0.5 if learn.size else 0.0
    thr1 = npki + 0.25 * (spki - npki)
    thr2 = 0.5 * thr1

    qrs: list[int] = []
    rr_recent: list[float] = []
    last_peak_idx = -1

    def _slope(centre: int) -> float:
        lo = max(0, centre - int(0.05 * fs))
        hi = min(len(x), centre + int(0.05 * fs))
        seg = x[lo:hi]
        return float(np.max(np.abs(np.diff(seg)))) if len(seg) > 1 else 0.0

    for p in peaks:
        val = mwi[p]
        if val > thr1:
            if qrs and (p - qrs[-1]) < int(round(0.360 * fs)):
                # Could be a T wave: require comparable slope to the last QRS.
                if _slope(int(p)) < 0.5 * _slope(int(qrs[-1])):
                    npki = 0.125 * val + 0.875 * npki
                    thr1 = npki + 0.25 * (spki - npki)
                    thr2 = 0.5 * thr1
                    continue
            if qrs and (p - qrs[-1]) < refractory:
                continue
            if qrs:
                rr_recent.append(float(p - qrs[-1]))
                rr_recent = rr_recent[-8:]
            qrs.append(int(p))
            spki = 0.125 * val + 0.875 * spki
        else:
            npki = 0.125 * val + 0.875 * npki

        thr1 = npki + 0.25 * (spki - npki)
        thr2 = 0.5 * thr1

        # Search-back: a missed beat leaves a suspiciously long gap.
        if qrs and rr_recent:
            rr_mean = float(np.mean(rr_recent))
            gap_start, gap_end = qrs[-1], int(p)
            if gap_end - gap_start > 1.66 * rr_mean:
                window = mwi[gap_start + refractory: gap_end]
                if window.size:
                    rel = int(np.argmax(window))
                    cand = gap_start + refractory + rel
                    if mwi[cand] > thr2 and (cand - qrs[-1]) > refractory:
                        qrs.insert(len(qrs) - 1 if qrs[-1] > cand else len(qrs), cand)
                        qrs.sort()
        last_peak_idx = int(p)

    _ = last_peak_idx
    return np.array(sorted(set(qrs)), dtype=int), mwi


def _refine_r(rms: np.ndarray, candidates: np.ndarray, fs: float) -> np.ndarray:
    """Move each detection to the local RMS maximum - the integration window
    biases the detection a few tens of ms late."""
    half = int(round(0.075 * fs))
    out = []
    for c in candidates:
        lo, hi = max(0, c - half), min(len(rms), c + half + 1)
        if hi <= lo:
            continue
        out.append(lo + int(np.argmax(rms[lo:hi])))
    return np.array(sorted(set(out)), dtype=int)


# --------------------------------------------------------------------------- #
# Multiscale derivative transform
# --------------------------------------------------------------------------- #

def derivative_envelope(block: WaveformBlock, width_ms: float,
                        leads=tuple(INDEPENDENT_LEADS)) -> np.ndarray:
    """Cross-lead RMS of the first derivative of the signal smoothed at
    `width_ms`. Symmetric kernel, so zero phase: a boundary found here is at
    the sample where it happens, not a filter delay later."""
    fs = block.sample_rate_hz
    sigma = max(1.0, width_ms / 1000.0 * fs / 2.0)
    stack = []
    for lead in leads:
        x = block.signals.get(lead)
        if x is None:
            continue
        x = np.where(np.isfinite(x), x, 0.0)
        stack.append(ndimage.gaussian_filter1d(x, sigma=sigma, order=1, mode="nearest"))
    return np.sqrt(np.mean(np.vstack(stack) ** 2, axis=0))


def find_pacing_spikes(block: WaveformBlock, leads=tuple(INDEPENDENT_LEADS),
                       min_ratio: float = 5.0, min_step_mv: float = 0.30,
                       max_width_ms: float = 8.0) -> np.ndarray:
    """Sample indices of narrow, very fast transients - pacemaker spikes.

    Run this on the **unfiltered** signal. A 1-2 ms spike sits almost entirely
    above a 40 Hz low-pass corner, so after filtering it is indistinguishable
    from a steep QRS by amplitude - on the bundled synthetic paced case the
    largest raw step is 1.27 mV per sample against a 0.06 mV 99.5th percentile,
    and after filtering both collapse to about 0.09 mV.

    Left in place a spike dominates every derivative envelope and the QRS
    boundary search collapses onto it: on the paced case that produced a
    confident, completely wrong 4 ms QRS. Detecting it lets the delineator
    measure myocardium and lets the UI say "this rhythm is paced".
    """
    fs = block.sample_rate_hz
    width = max(1, int(round(max_width_ms / 1000.0 * fs)))
    hits = np.zeros(block.n_samples, dtype=bool)
    for lead in leads:
        x = block.signals.get(lead)
        if x is None or len(x) < 3:
            continue
        diff = np.diff(np.nan_to_num(x, nan=0.0))
        d = np.abs(diff)
        scale = float(np.percentile(d, 99.5)) + 1e-9
        threshold = max(min_step_mv, min_ratio * scale)
        for c in np.where(d > threshold)[0]:
            lo, hi = max(0, c - width), min(len(diff), c + width + 1)
            # A spike goes up and comes straight back down: the excursion must
            # reverse inside a few milliseconds, which a QRS upstroke does not.
            seg = diff[lo:hi]
            if seg.size and seg.max() > 0 and seg.min() < 0:
                hits[lo:hi + 1] = True
    return np.where(hits)[0]


def blank_spikes(block: WaveformBlock, spikes: np.ndarray, pad_ms: float = 6.0
                 ) -> WaveformBlock:
    """Linearly interpolate across detected spikes so measurement can proceed.

    The original signal is untouched: the UI still draws the spikes, because a
    student needs to see them. This copy exists only so the delineator measures
    myocardium instead of electronics.
    """
    if spikes.size == 0:
        return block
    fs = block.sample_rate_hz
    pad = max(1, int(round(pad_ms / 1000.0 * fs)))
    mask = np.zeros(block.n_samples, dtype=bool)
    for s in spikes:
        mask[max(0, s - pad):min(block.n_samples, s + pad + 1)] = True
    idx = np.arange(block.n_samples)
    out = {}
    for lead, x in block.signals.items():
        y = np.array(x, dtype=float, copy=True)
        good = ~mask & np.isfinite(y)
        if good.sum() > 2:
            y[mask] = np.interp(idx[mask], idx[good], y[good])
        out[lead] = y
    return WaveformBlock(kind=block.kind + "-despiked", sample_rate_hz=fs,
                         signals=out, n_samples=block.n_samples,
                         scale_uv_per_lsb=block.scale_uv_per_lsb,
                         device_filters=block.device_filters)


def segment_envelope(block: WaveformBlock, lo: int, hi: int, width_ms: float,
                     leads=tuple(INDEPENDENT_LEADS)) -> np.ndarray:
    """`derivative_envelope` computed over [lo, hi) in isolation.

    This matters for P and T waves. Smoothed at 32-64 ms, the QRS upstroke still
    has derivative energy 40-60 ms outside its own boundaries, and a P-wave
    search that can see it will always lock onto that skirt instead of the P
    wave. Filtering the slice alone, with edge extension, makes the leak
    impossible rather than merely unlikely.
    """
    fs = block.sample_rate_hz
    sigma = max(1.0, width_ms / 1000.0 * fs / 2.0)
    stack = []
    for lead in leads:
        x = block.signals.get(lead)
        if x is None:
            continue
        seg = np.where(np.isfinite(x[lo:hi]), x[lo:hi], 0.0)
        if seg.size == 0:
            continue
        stack.append(ndimage.gaussian_filter1d(seg, sigma=sigma, order=1, mode="nearest"))
    if not stack:
        return np.zeros(max(0, hi - lo))
    return np.sqrt(np.mean(np.vstack(stack) ** 2, axis=0))


def _wave_from_envelope(seg: np.ndarray, fs: float, skip: int = 0,
                        max_width_ms: float = 200.0, pair_ratio: float = 0.2,
                        on_ratio: float = 0.25, off_ratio: float = 0.25):
    """Locate one wave (P or T) inside a derivative-envelope segment.

    A monophasic wave produces a *pair* of derivative maxima - the upslope and
    the downslope - with a minimum between them at the apex. Taking the single
    largest envelope maximum as the wave peak (a tempting shortcut) puts the
    peak on a flank and shortens every interval measured from it. So: find the
    dominant maximum, find its partner on whichever side has one, put the apex
    at the minimum between them, and measure the boundaries outward from the
    outer maxima. This is the modulus-maximum-pair rule from wavelet
    delineation (Martinez et al. 2004), applied to a Gaussian-derivative scale.

    Returns (onset, apex, offset, strength) as indices into `seg`, or None.
    """
    if seg.size < 5:
        return None
    body = seg[skip:]
    if body.size < 3:
        return None
    i1 = skip + int(np.argmax(body))
    v1 = float(seg[i1])
    if v1 <= 0:
        return None

    span = max(3, int(round(max_width_ms / 1000.0 * fs)))
    peaks, _ = sig.find_peaks(seg)
    partner = None
    for side in (-1, +1):
        cands = [p for p in peaks
                 if (p < i1 if side < 0 else p > i1)
                 and abs(p - i1) <= span
                 and seg[p] >= pair_ratio * v1]
        if cands:
            best = max(cands, key=lambda p: seg[p])
            if partner is None or seg[best] > seg[partner]:
                partner = best
    if partner is None:
        # Monophasic-looking (one slope only, e.g. a wave truncated by the
        # window): fall back to the single maximum, apex at the maximum itself.
        return i1, i1, i1, v1

    a, b = (partner, i1) if partner < i1 else (i1, partner)
    apex = a + int(np.argmin(seg[a:b + 1]))
    onset = _walk_out(seg, a, 0, on_ratio * float(seg[a]), -1)
    offset = _walk_out(seg, b, len(seg) - 1, off_ratio * float(seg[b]), +1)
    return onset, apex, offset, v1


def _walk_out(env: np.ndarray, start: int, limit: int, threshold: float,
              direction: int) -> int:
    """From `start`, walk in `direction` until the envelope stays below
    `threshold`, stopping at `limit`."""
    i = start
    below = 0
    need = 2
    while (direction > 0 and i < limit) or (direction < 0 and i > limit):
        if env[i] < threshold:
            below += 1
            if below >= need:
                return i
        else:
            below = 0
        i += direction
    return limit


# --------------------------------------------------------------------------- #
# Full delineation
# --------------------------------------------------------------------------- #

def delineate(block: WaveformBlock, *, device_pace_samples: list[int] | None = None,
              flat_leads: list[str] | None = None,
              recomputed_leads: list[str] | None = None,
              spike_samples: np.ndarray | None = None) -> Delineation:
    """Delineate a filtered rhythm block.

    `spike_samples` comes from `find_pacing_spikes` run on the *unfiltered*
    signal (see that function for why it cannot be found here).
    """
    fs = block.sample_rate_hz
    n = block.n_samples
    warnings: list[Warning] = []

    spikes = (np.asarray(spike_samples, dtype=int) if spike_samples is not None
              else np.array([], dtype=int))
    if spikes.size:
        block = blank_spikes(block, spikes)

    rms = multi_lead_rms(block)
    env_qrs = derivative_envelope(block, 16.0)    # fast: QRS boundaries
    env_p = derivative_envelope(block, 32.0)      # P wave (~80-110 ms wide)
    env_wave = derivative_envelope(block, 64.0)   # T wave (slowest)

    raw_r, _ = pan_tompkins(rms, fs)
    r_peaks = _refine_r(rms, raw_r, fs)

    if n / fs < 5.0:
        warnings.append(Warning("SHORT_RECORDING", "warning",
                                "Recording is %.1f s. Interval statistics from so few "
                                "beats are unstable." % (n / fs)))
    if len(r_peaks) == 0:
        warnings.append(Warning("NO_BEATS", "critical",
                                "No QRS complexes detected. Nothing downstream can be "
                                "anchored to this recording."))
        return Delineation(fs, [], warnings, {})
    if len(r_peaks) < 3:
        warnings.append(Warning("TOO_FEW_BEATS", "warning",
                                "Only %d beat(s) detected." % len(r_peaks)))

    rr = np.diff(r_peaks).astype(float)
    beats: list[Beat] = []
    for i, r in enumerate(r_peaks):
        b = Beat(index=i, r=int(r))
        b.rr_samples = float(rr[i - 1]) if i > 0 else (float(rr[0]) if len(rr) else None)
        beats.append(b)

    median_rr = float(np.median(rr)) if len(rr) else float(0.8 * fs)

    for i, b in enumerate(beats):
        r = b.r
        rr_b = b.rr_samples or median_rr

        # ---- QRS boundaries (16 ms scale) --------------------------------- #
        w = int(round(0.100 * fs))
        lo, hi = max(0, r - w), min(n, r + w)
        peak_env = float(np.max(env_qrs[lo:hi])) if hi > lo else 0.0
        # The QRS peak measured in the *wave* scale too: thresholds must never
        # be compared across scales, since the derivative amplitude falls with
        # the smoothing width.
        peak_env_wave = float(np.max(env_wave[lo:hi])) if hi > lo else 0.0
        thr = QRS_BOUNDARY_FRACTION * peak_env
        left_limit = max(0, r - int(round(0.160 * fs)))
        right_limit = min(n - 1, r + int(round(0.220 * fs)))
        b.qrs_on = _walk_out(env_qrs, r, left_limit, thr, -1)
        b.qrs_off = _walk_out(env_qrs, r, right_limit, thr, +1)

        # ---- P wave (32 ms scale, window before QRS onset) ---------------- #
        p_hi = b.qrs_on
        p_lo = max(0, int(b.qrs_on - min(0.50 * rr_b, 0.40 * fs)))
        if i > 0:
            p_lo = max(p_lo, beats[i - 1].t_off or p_lo)
        peak_env_p = float(np.max(env_p[lo:hi])) if hi > lo else 0.0
        if p_hi - p_lo > int(0.06 * fs):
            seg = segment_envelope(block, p_lo, p_hi, 32.0)
            found = _wave_from_envelope(seg, fs, max_width_ms=140.0,
                                        on_ratio=0.35, off_ratio=0.35)
            # Noise floor from a low percentile, not the median: much of the
            # envelope is QRS and T energy, so the median is not a floor.
            noise = float(np.percentile(env_p, 25)) + 1e-9
            if found and found[3] > max(3.0 * noise, 0.02 * peak_env_p) and found[2] > found[0]:
                on, apex, off, _ = found
                b.p_on, b.p_peak, b.p_off = int(p_lo + on), int(p_lo + apex), int(p_lo + off)
            else:
                b.flags.append("no_p_wave")
        else:
            b.flags.append("no_p_window")

        # ---- T wave (64 ms scale, window after QRS offset) ---------------- #
        t_lo = min(n - 1, b.qrs_off)
        t_hi = min(n - 1, int(b.qrs_off + 0.65 * rr_b))
        if i + 1 < len(beats):
            t_hi = min(t_hi, beats[i + 1].r - int(round(0.120 * fs)))
        if t_hi - t_lo > int(0.08 * fs):
            seg = segment_envelope(block, t_lo, t_hi, 64.0)
            # Skip the first 50 ms: the ST segment carries the tail of the QRS.
            skip = min(int(round(0.050 * fs)), max(0, len(seg) - 3))
            found = _wave_from_envelope(seg, fs, skip=skip, max_width_ms=320.0,
                                        off_ratio=0.22)
            if found and found[2] > found[1]:
                _, apex, off, _ = found
                b.t_peak, b.t_off = int(t_lo + apex), int(t_lo + off)
            else:
                b.flags.append("no_t_wave")
        else:
            b.flags.append("no_t_window")

    # ---- template consistency -> per-beat confidence ---------------------- #
    pre, post = int(0.10 * fs), int(0.15 * fs)
    segs, keep = [], []
    for b in beats:
        lo, hi = b.r - pre, b.r + post
        if lo >= 0 and hi < n:
            segs.append(rms[lo:hi])
            keep.append(b)
    if segs:
        template = np.median(np.vstack(segs), axis=0)
        t_centred = template - template.mean()
        denom = np.linalg.norm(t_centred) + 1e-12
        for b, s in zip(keep, segs):
            s_c = s - s.mean()
            b.confidence = float(np.dot(s_c, t_centred) / (np.linalg.norm(s_c) * denom + 1e-12))
    confidences = [b.confidence for b in beats if b.confidence]
    median_conf = float(np.median(confidences)) if confidences else 0.0

    # ---- summary ---------------------------------------------------------- #
    def _median_ms(pairs):
        vals = [(b - a) / fs * 1000.0 for a, b in pairs if a is not None and b is not None]
        return float(np.median(vals)) if vals else None

    summary: dict[str, float] = {}
    summary["rrMs"] = float(np.median(rr) / fs * 1000.0) if len(rr) else None
    summary["heartRateBpm"] = (60000.0 / summary["rrMs"]) if summary["rrMs"] else None
    summary["prMs"] = _median_ms([(b.p_on, b.qrs_on) for b in beats])
    summary["pDurationMs"] = _median_ms([(b.p_on, b.p_off) for b in beats])
    summary["qrsMs"] = _median_ms([(b.qrs_on, b.qrs_off) for b in beats])
    summary["qtMs"] = _median_ms([(b.qrs_on, b.t_off) for b in beats])
    summary["beatCount"] = len(beats)
    summary["medianTemplateCorrelation"] = median_conf
    if len(rr) >= 2:
        summary["rrCoefficientOfVariation"] = float(np.std(rr) / (np.mean(rr) + 1e-9))
        summary["rmssdMs"] = float(np.sqrt(np.mean(np.diff(rr) ** 2)) / fs * 1000.0)
    else:
        summary["rrCoefficientOfVariation"] = None
        summary["rmssdMs"] = None

    # ---- explicit failure modes ------------------------------------------- #
    # ---- is this a cardiac signal at all? --------------------------------- #
    # Pan-Tompkins adaptive thresholds will happily latch onto pure noise: on a
    # recording containing nothing but 4 uV of noise, this detector "found" 30
    # beats with a 380 ms QRS. Two sanity checks separate that cleanly from real
    # recordings, with a wide margin on the bundled cases:
    #   R-peak amplitude over the baseline median: 8-18 for real ECG, ~1.6 for noise
    #   QRS duration as a fraction of RR:          0.11-0.24 for real ECG, >1 for noise
    peak_rms = float(np.median(rms[[b.r for b in beats]])) if beats else 0.0
    snr = peak_rms / (float(np.median(rms)) + 1e-12)
    summary["detectionSnr"] = snr
    if snr < 3.0:
        warnings.append(Warning(
            "NO_CARDIAC_SIGNAL", "critical",
            "Detected complexes are only %.1fx the baseline level. This does not look "
            "like a cardiac signal; the detections are almost certainly noise." % snr,
            {"detectionSnr": snr}))

    if summary.get("qrsMs") and summary.get("rrMs"):
        fraction = summary["qrsMs"] / summary["rrMs"]
        summary["qrsRrFraction"] = fraction
        if fraction > 0.6:
            warnings.append(Warning(
                "IMPLAUSIBLE_QRS_FRACTION", "critical",
                "Measured QRS (%.0f ms) occupies %.0f%% of the beat interval "
                "(%.0f ms), which is not physiologically possible. Detection has "
                "failed on this recording." % (summary["qrsMs"], fraction * 100,
                                               summary["rrMs"]),
                {"qrsRrFraction": fraction}))

    cv = summary.get("rrCoefficientOfVariation")
    if cv is not None and cv > 0.15:
        warnings.append(Warning(
            "IRREGULAR_RHYTHM", "warning",
            "Beat-to-beat interval varies by %.0f%%. The conduction animation "
            "assumes a repeating activation sequence and is not a valid model of "
            "an irregular rhythm." % (cv * 100), {"rrCoefficientOfVariation": cv}))

    qrs_ms = summary.get("qrsMs")
    if qrs_ms and qrs_ms > 120:
        warnings.append(Warning(
            "WIDE_QRS", "info",
            "QRS duration %.0f ms (>120 ms). Ventricular activation is not "
            "proceeding through the normal His-Purkinje sequence; the conduction "
            "model stretches but its region ordering is still the textbook one."
            % qrs_ms, {"qrsMs": qrs_ms}))

    # Only count beats where a P wave could have been found: the first beat of
    # a strip often starts mid-cycle and has no searchable window.
    p_candidates = [b for b in beats if "no_p_window" not in b.flags]
    no_p = sum(1 for b in p_candidates if b.p_on is None)
    if p_candidates and no_p / len(p_candidates) > 0.5:
        warnings.append(Warning(
            "NO_P_WAVES", "warning",
            "No P wave found in %d of %d searchable beats. Atrial activation "
            "cannot be timed from this recording." % (no_p, len(p_candidates))))

    if median_conf and median_conf < 0.80:
        warnings.append(Warning(
            "LOW_TEMPLATE_CONSISTENCY", "warning",
            "Beats differ from each other (median template correlation %.2f). "
            "Detection may be unreliable, or beats may be ectopic." % median_conf,
            {"medianTemplateCorrelation": median_conf}))

    if spikes.size:
        # Cluster adjacent samples so the count is spikes, not samples.
        n_spikes = int(1 + np.sum(np.diff(spikes) > int(0.02 * fs))) if spikes.size else 0
        warnings.append(Warning(
            "PACING_SPIKES_DETECTED", "warning",
            "%d narrow high-slope transient(s) consistent with pacemaker spikes were "
            "found and excluded from measurement. If this is a paced rhythm, the "
            "conduction model does not describe it at all: activation starts at the "
            "lead tip and spreads through muscle, not through the His-Purkinje system."
            % n_spikes, {"count": n_spikes}))

    if device_pace_samples:
        warnings.append(Warning(
            "PACE_MARKS", "warning",
            "%d pacemaker-spike marks are present in the source file. If this is a "
            "paced rhythm the conduction model does not apply; if they are artefact, "
            "signal quality is poor." % len(device_pace_samples),
            {"count": len(device_pace_samples)}))

    for lead in (flat_leads or []):
        warnings.append(Warning("FLAT_LEAD", "critical",
                                "Lead %s is flat - likely a disconnected electrode. "
                                "Any vector derived from it is meaningless." % lead,
                                {"lead": lead}))
    if recomputed_leads:
        warnings.append(Warning(
            "LEADS_RECOMPUTED", "info",
            "Stored lead(s) %s disagreed with Einthoven/Goldberger and were "
            "recomputed from I and II." % ", ".join(recomputed_leads),
            {"leads": recomputed_leads}))

    return Delineation(fs, beats, warnings, summary)
