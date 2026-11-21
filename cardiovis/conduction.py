"""Tier 3 - the conduction model.

READ THIS BEFORE CHANGING ANYTHING HERE.

Nothing in this module is a reconstruction of the patient's activation
sequence. It cannot be: a 12-lead ECG carries 8 independent signals, a single
equivalent dipole is 3 numbers per instant, and a spatial activation wavefront
over a myocardial mesh has thousands of degrees of freedom. What this module
does is take the *textbook* activation sequence - the one in every physiology
course - and time it against the fiducial points measured in this specific
recording, so the animation runs at the patient's heart rate, with the
patient's PR interval, stretched by the patient's QRS width.

Timing is patient-specific. Anatomy and ordering are not. Every frame this
module emits is tagged Tier 3 and carries a badge that cannot be dismissed.

The honesty check (spec 7): we integrate the modelled regional activation into
a synthetic dipole and correlate it with the *measured* Tier-2 d(t). When the
model disagrees with the patient's real vector loop, the UI says so. A low
correlation is not a bug to be tuned away - it is the model telling the student
where textbook physiology stops describing this patient.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .delineate import Delineation
from .vcg import Vcg

#: Reference QRS width the textbook table below is written for. A measured QRS
#: of 170 ms stretches every ventricular event by 170/85 = 2x, so a bundle
#: branch block visibly widens and desynchronises the sweep instead of replaying
#: a canned normal animation.
REFERENCE_QRS_MS = 85.0
REFERENCE_P_MS = 100.0


@dataclass(frozen=True)
class Region:
    """One named anatomical region of the heart mesh.

    `direction` is the textbook direction of the depolarisation wavefront for
    that region, in the anatomical frame (+x left, +y inferior, +z posterior).
    `weight` is its relative contribution to the dipole - roughly, how much
    myocardium it is. Both are illustrative constants, not fitted to anything.
    """

    key: str
    label: str
    chamber: str                 # atria | ventricles | conduction
    anchor: str                  # pOn | pOff | qrsOn | qrsOff
    onset_ms: float              # relative to the anchor
    duration_ms: float
    direction: tuple[float, float, float]
    weight: float
    scales_with: str = "qrs"     # qrs | p | none
    silent: bool = False         # electrically silent at body-surface scale
    repolarises: bool = False
    note: str = ""


#: The sequence. Onsets and durations follow the teaching table in the spec.
REGIONS: list[Region] = [
    Region("ra", "Right atrium (SA node spread)", "atria", "pOn", 0.0, 30.0,
           (0.30, 0.85, -0.30), 0.10, scales_with="p",
           note="Impulse leaves the SA node and sweeps down and left across the RA."),
    Region("la", "Left atrium", "atria", "pOn", 30.0, 50.0,
           (0.60, 0.40, 0.60), 0.10, scales_with="p",
           note="LA activates later and more posteriorly - the second half of the P wave."),
    Region("av", "AV node (conduction delay)", "conduction", "pOff", 0.0, 0.0,
           (0.0, 0.0, 0.0), 0.0, scales_with="none", silent=True,
           note="Electrically silent at the body surface. Its delay IS the PR segment; "
                "duration is filled in per beat from the measured PR interval."),
    Region("his", "His bundle and bundle branches", "conduction", "qrsOn", -10.0, 15.0,
           (0.0, 0.50, -0.20), 0.02,
           note="Too little tissue to register on the surface ECG."),
    Region("septum", "Interventricular septum (left to right)", "ventricles", "qrsOn", 0.0, 15.0,
           (-0.70, -0.20, -0.65), 0.15,
           note="The septum depolarises left-to-right first: the septal q in I and V6, "
                "the small r in V1."),
    Region("rv", "Right ventricular free wall", "ventricles", "qrsOn", 15.0, 25.0,
           (-0.40, 0.30, -0.85), 0.20,
           note="Thin wall, small vector, largely cancelled by the much larger LV."),
    Region("lv", "Left ventricular free wall (endo to epi, apex to base)",
           "ventricles", "qrsOn", 20.0, 45.0,
           (0.75, 0.45, 0.45), 1.00,
           note="The dominant vector of the whole QRS - left, inferior and posterior."),
    Region("lv_basal", "Basal / posterior LV (last to depolarise)", "ventricles",
           "qrsOn", 55.0, 25.0, (0.40, -0.50, 0.75), 0.25,
           note="The last myocardium to activate; the terminal QRS forces."),
]

#: Repolarisation runs epicardium -> endocardium, i.e. in reverse order of
#: activation. Because the repolarising wavefront also has reversed polarity,
#: its dipole points the *same* way as depolarisation did - which is why the
#: normal T wave is concordant with the QRS.
REPOLARISING_REGIONS = ["lv_basal", "lv", "rv", "septum"]


@dataclass
class ConductionFrames:
    """Per-sample activation state for every region, over the whole strip."""

    region_keys: list[str]
    depolarised: np.ndarray       # (n_regions, n_samples) 0..1
    repolarised: np.ndarray       # (n_regions, n_samples) 0..1
    model_dipole: np.ndarray      # (3, n_samples) mV, synthetic
    sample_rate_hz: float
    schedule: list[dict] = field(default_factory=list)   # per-beat, per-region, ms
    agreement: dict = field(default_factory=dict)
    applicable: bool = True
    caveats: list[str] = field(default_factory=list)

    @property
    def excitation(self) -> np.ndarray:
        """Depolarised-and-not-yet-repolarised: what the mesh colours by."""
        return np.clip(self.depolarised - self.repolarised, 0.0, 1.0)

    def to_json_meta(self) -> dict:
        return {
            "tier": 3,
            "regions": [
                {"key": r.key, "label": r.label, "chamber": r.chamber,
                 "direction": list(r.direction), "weight": r.weight,
                 "silent": r.silent, "note": r.note}
                for r in REGIONS if r.key in self.region_keys
            ],
            "referenceQrsMs": REFERENCE_QRS_MS,
            "agreement": self.agreement,
            "applicable": self.applicable,
            "caveats": self.caveats,
            "badge": ("Conduction model - illustrative, not patient-specific "
                      "reconstruction"),
        }


def _ramp(n_samples: int, onset: int, duration: int, total: int) -> np.ndarray:
    """A 0->1 ramp starting at `onset`, `duration` long, held at 1 afterwards."""
    out = np.zeros(total, dtype=np.float32)
    if duration <= 0:
        out[max(0, onset):] = 1.0
        return out
    lo = max(0, onset)
    hi = min(total, onset + duration)
    if hi > lo:
        # Smoothstep rather than linear: a wavefront does not start and stop
        # instantaneously, and the derivative of a linear ramp is a rectangle,
        # which makes the synthetic dipole look like a box car.
        t = (np.arange(lo, hi) - onset) / float(duration)
        out[lo:hi] = (t * t * (3 - 2 * t)).astype(np.float32)
    if hi < total:
        out[hi:] = 1.0
    return out


def build(delin: Delineation, n_samples: int, measured_vcg: Vcg | None = None
          ) -> ConductionFrames:
    """Build the Tier-3 activation timeline for a whole rhythm strip."""
    fs = delin.fs
    keys = [r.key for r in REGIONS]
    depol = np.zeros((len(REGIONS), n_samples), dtype=np.float32)
    repol = np.zeros((len(REGIONS), n_samples), dtype=np.float32)
    model = np.zeros((3, n_samples), dtype=np.float64)
    schedule: list[dict] = []

    qrs_ms = delin.summary.get("qrsMs") or REFERENCE_QRS_MS
    p_ms = delin.summary.get("pDurationMs") or REFERENCE_P_MS
    qrs_scale = float(np.clip(qrs_ms / REFERENCE_QRS_MS, 0.5, 4.0))
    p_scale = float(np.clip(p_ms / REFERENCE_P_MS, 0.5, 3.0))

    def ms2s(ms: float) -> int:
        return int(round(ms / 1000.0 * fs))

    for b in delin.beats:
        if b.qrs_on is None or b.qrs_off is None:
            continue
        anchors = {
            "pOn": b.p_on if b.p_on is not None else b.qrs_on - ms2s(160 * 1.0),
            "pOff": b.p_off if b.p_off is not None else b.qrs_on - ms2s(60),
            "qrsOn": b.qrs_on,
            "qrsOff": b.qrs_off,
        }
        beat_end = b.t_off if b.t_off is not None else min(n_samples - 1,
                                                           b.qrs_off + ms2s(300))
        beat_entry = {"beatIndex": b.index, "regions": {}}

        for ri, region in enumerate(REGIONS):
            scale = (qrs_scale if region.scales_with == "qrs"
                     else p_scale if region.scales_with == "p" else 1.0)
            onset = anchors[region.anchor] + ms2s(region.onset_ms * scale)
            if region.key == "av":
                # The AV delay is not a textbook constant: it is whatever is
                # left of this beat's measured PR interval.
                duration = max(0, anchors["qrsOn"] - anchors["pOff"])
            else:
                duration = ms2s(region.duration_ms * scale)

            depol[ri] = np.maximum(depol[ri], _ramp(n_samples, onset, duration, n_samples)
                                   * _beat_window(n_samples, onset, beat_end + ms2s(50)))
            beat_entry["regions"][region.key] = {
                "onsetMs": round((onset - b.qrs_on) / fs * 1000.0, 1),
                "durationMs": round(duration / fs * 1000.0, 1),
                "anchoredTo": region.anchor,
            }

            if not region.silent and region.weight > 0 and duration > 0:
                ramp = _ramp(n_samples, onset, duration, n_samples)
                rate = np.gradient(ramp) * fs
                d = np.array(region.direction, dtype=float)
                model += np.outer(d * region.weight, rate)

        # ---- atrial recovery -------------------------------------------- #
        # Atrial repolarisation (the Ta wave) begins shortly after the P wave and
        # is buried inside the QRS on the surface ECG, so it contributes nothing
        # to the modelled dipole. It still has to be drawn, or the atria stay lit
        # for the whole beat and the animation implies they are still depolarised
        # while the ventricles contract.
        p_off = anchors["pOff"]
        for key in ("ra", "la"):
            ri = keys.index(key)
            onset = p_off + ms2s(60 * p_scale)
            duration = ms2s(150 * p_scale)
            repol[ri] = np.maximum(
                repol[ri],
                _ramp(n_samples, onset, duration, n_samples)
                * _beat_window(n_samples, onset, beat_end + ms2s(50)))

        # ---- repolarisation: reverse order, spread across the ST-T window ---
        st_on = b.qrs_off
        t_end = beat_end
        window = max(1, t_end - st_on)
        for order, key in enumerate(REPOLARISING_REGIONS):
            ri = keys.index(key)
            region = REGIONS[ri]
            frac = order / max(1, len(REPOLARISING_REGIONS))
            onset = st_on + int(frac * window * 0.55)
            duration = max(1, int(window * 0.55))
            repol[ri] = np.maximum(repol[ri], _ramp(n_samples, onset, duration, n_samples)
                                   * _beat_window(n_samples, onset, t_end + ms2s(80)))
            if region.weight > 0:
                ramp = _ramp(n_samples, onset, duration, n_samples)
                rate = np.gradient(ramp) * fs
                d = np.array(region.direction, dtype=float)
                # Same-direction dipole, scaled down: repolarisation is slower
                # and more diffuse than depolarisation, so the T wave is lower
                # and broader than the QRS.
                model += np.outer(d * region.weight * 0.30, rate)

        schedule.append(beat_entry)

        # Regions reset before the next beat so the animation can loop.
        nxt = _next_beat_start(delin, b.index, n_samples)
        if nxt is not None:
            depol[:, nxt:] = 0.0
            repol[:, nxt:] = 0.0

    frames = ConductionFrames(region_keys=keys, depolarised=depol, repolarised=repol,
                              model_dipole=model, sample_rate_hz=fs, schedule=schedule)
    frames.applicable = delin.model_applicable
    frames.caveats = _caveats(delin, qrs_scale)
    if measured_vcg is not None:
        frames.agreement = agreement(frames, measured_vcg, delin)
    return frames


def _beat_window(n: int, start: int, end: int) -> np.ndarray:
    """Mask that keeps a beat's activation inside its own beat."""
    m = np.zeros(n, dtype=np.float32)
    m[max(0, start):max(0, min(n, end))] = 1.0
    return m


def _next_beat_start(delin: Delineation, index: int, n: int) -> int | None:
    for b in delin.beats:
        if b.index == index + 1:
            return b.p_on if b.p_on is not None else b.qrs_on
    return None


def _caveats(delin: Delineation, qrs_scale: float) -> list[str]:
    out = [
        "Region shapes, ordering and directions are textbook physiology, identical "
        "for every patient. Only the timing comes from this recording.",
    ]
    if qrs_scale > 1.3:
        out.append(
            "QRS is %.0f%% of the reference width, so ventricular events are stretched "
            "by that factor. A wide QRS means activation did NOT follow the normal "
            "His-Purkinje route - the model stretches the normal sequence rather than "
            "rerouting it, and the sweep you see is therefore wrong in its path as well "
            "as slow." % (qrs_scale * 100))
    for w in delin.warnings:
        if w.code in {"IRREGULAR_RHYTHM", "NO_P_WAVES", "PACE_MARKS",
                      "LOW_TEMPLATE_CONSISTENCY"}:
            out.append(w.message)
    return out


def agreement(frames: ConductionFrames, measured: Vcg, delin: Delineation) -> dict:
    """Correlate the modelled dipole against the measured Tier-2 d(t).

    This is the number that keeps the animation honest, so it is computed on the
    QRS windows (where the model makes its strongest claim) and over whole beats,
    and it is displayed whether it is flattering or not.
    """
    model = frames.model_dipole
    meas = measured.xyz
    n = min(model.shape[1], meas.shape[1])
    model, meas = model[:, :n], meas[:, :n]

    qrs_mask = np.zeros(n, dtype=bool)
    beat_mask = np.zeros(n, dtype=bool)
    for b in delin.beats:
        if b.qrs_on is None or b.qrs_off is None:
            continue
        qrs_mask[max(0, b.qrs_on):min(n, b.qrs_off)] = True
        end = b.t_off if b.t_off is not None else b.qrs_off
        start = b.p_on if b.p_on is not None else b.qrs_on
        beat_mask[max(0, start):min(n, end)] = True

    def _corr(mask) -> dict:
        out = {}
        if mask.sum() < 8:
            return {"r_x": None, "r_y": None, "r_z": None, "r_overall": None}
        for i, axis in enumerate("xyz"):
            a, b_ = model[i, mask], meas[i, mask]
            if np.std(a) < 1e-12 or np.std(b_) < 1e-12:
                out["r_" + axis] = None
            else:
                out["r_" + axis] = float(np.corrcoef(a, b_)[0, 1])
        a, b_ = model[:, mask].ravel(), meas[:, mask].ravel()
        out["r_overall"] = (float(np.corrcoef(a, b_)[0, 1])
                            if np.std(a) > 1e-12 and np.std(b_) > 1e-12 else None)
        return out

    qrs = _corr(qrs_mask)
    whole = _corr(beat_mask)
    r = qrs.get("r_overall")
    if r is None:
        verdict = "Not computable for this recording."
    elif r > 0.8:
        verdict = ("Over the QRS, the textbook sequence reproduces this patient's measured "
                   "vector closely, so the ventricular part of the animation is a "
                   "reasonable illustration of this beat. A good QRS match says nothing "
                   "about the rhythm or the atrial part of the model - check the caveats "
                   "for those separately.")
    elif r > 0.5:
        verdict = ("The textbook sequence only partly reproduces this patient's measured "
                   "vector. Treat the spatial sweep as a teaching cartoon here.")
    else:
        verdict = ("The textbook sequence does NOT reproduce this patient's measured "
                   "vector. Whatever this heart is doing, it is not the normal "
                   "activation sequence - trust the Tier-2 loop, not the animation.")
    return {"qrs": qrs, "wholeBeat": whole, "verdict": verdict,
            "note": ("Correlation between the dipole implied by the Tier-3 model and the "
                     "Tier-2 dipole measured from this recording.")}
