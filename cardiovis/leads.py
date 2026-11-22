"""Lead algebra and geometry.

Definitional relationships (safe to hardcode - they are how the leads are
defined, not an empirical model):

    Einthoven   I = V_L - V_R      II = V_F - V_R      III = V_F - V_L
                => II = I + III
    Goldberger  aVR = -(I + II)/2   aVL = (I - III)/2   aVF = (II + III)/2

Only 8 of the 12 leads are independent: I, II, V1..V6. Everything else is a
linear combination. That fact is the whole reason for the tier model.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .ecg_parser.base import INDEPENDENT_LEADS, LEAD_ORDER, WaveformBlock

#: Frontal-plane lead axis angles, degrees, clockwise-positive from the +x axis
#: pointing to the subject left (the standard hexaxial reference system).
FRONTAL_LEAD_ANGLES_DEG = {
    "I": 0.0, "II": 60.0, "III": 120.0,
    "aVR": -150.0, "aVL": -30.0, "aVF": 90.0,
}

#: Transverse (horizontal) plane angles for the precordial leads, degrees from
#: the +x axis (subject left) rotating toward the *front* of the chest, which is
#: where the electrodes are: V6 lies at 0 (straight left), V1 at ~115 (right and
#: well anterior). Sanity check against the forward Dower matrix, which is
#: empirical rather than assumed: its V1 row is (-0.515, 0.157, -0.917), i.e.
#: rightward and anterior, at 119.6 degrees by this convention. These are the classical
#: teaching approximations used in the hexaxial/precordial reference figures;
#: real precordial lead vectors are patient-specific and not measurable from the
#: ECG alone. Used only for the naive least-squares VCG demonstration and for
#: drawing lead axes in the 3D view.
PRECORDIAL_LEAD_ANGLES_DEG = {
    "V1": 115.0, "V2": 94.0, "V3": 64.0, "V4": 49.0, "V5": 24.0, "V6": 0.0,
}


def lead_unit_vector(lead: str) -> np.ndarray:
    """Unit lead vector in the anatomical frame used throughout CardioVis:

        +x = subject left, +y = subject foot (inferior), +z = subject back

    This matches the Frank XYZ convention used by the Dower/Kors transforms
    (X left, Y inferior, Z posterior), so VCG components and lead vectors live
    in the same space and a projection is a plain dot product.
    """
    if lead in FRONTAL_LEAD_ANGLES_DEG:
        a = np.deg2rad(FRONTAL_LEAD_ANGLES_DEG[lead])
        return np.array([np.cos(a), np.sin(a), 0.0])
    if lead in PRECORDIAL_LEAD_ANGLES_DEG:
        a = np.deg2rad(PRECORDIAL_LEAD_ANGLES_DEG[lead])
        # Negative z: the precordial angles run toward the anterior chest, and
        # +z points posteriorly.
        return np.array([np.cos(a), 0.0, -np.sin(a)])
    raise KeyError("Unknown lead %r" % lead)


def lead_matrix(leads=tuple(INDEPENDENT_LEADS)) -> np.ndarray:
    """(n_leads, 3) matrix of textbook unit lead vectors."""
    return np.vstack([lead_unit_vector(l) for l in leads])


def derive_from_i_ii(I: np.ndarray, II: np.ndarray) -> dict[str, np.ndarray]:
    """The four dependent limb leads, from the two independent ones."""
    III = II - I
    return {
        "III": III,
        "aVR": -(I + II) / 2.0,
        "aVL": (I - III) / 2.0,
        "aVF": (II + III) / 2.0,
    }


@dataclass
class LeadConsistency:
    max_abs_error_mv: dict[str, float]
    recomputed: list[str]
    flat_leads: list[str]
    tolerance_mv: float

    @property
    def ok(self) -> bool:
        return not self.recomputed

    def to_json(self) -> dict:
        return {
            "maxAbsErrorMv": {k: round(v, 6) for k, v in self.max_abs_error_mv.items()},
            "recomputed": self.recomputed,
            "flatLeads": self.flat_leads,
            "toleranceMv": self.tolerance_mv,
        }


def enforce_lead_consistency(block: WaveformBlock, tolerance_mv: float = 0.05
                             ) -> tuple[WaveformBlock, LeadConsistency]:
    """Recompute the dependent leads from I and II when the stored ones disagree.

    Files claim to contain all 12 leads. Do not trust that: a mislabelled or
    re-derived lead in the source silently corrupts every downstream vector.
    Small disagreements (a couple of LSB from quantisation) are expected and
    left alone; larger ones are replaced and reported.
    """
    if "I" not in block.signals or "II" not in block.signals:
        raise ValueError("Cannot validate leads without I and II")

    I = block.signals["I"]
    II = block.signals["II"]
    expected = derive_from_i_ii(I, II)

    errors: dict[str, float] = {}
    recomputed: list[str] = []
    signals = dict(block.signals)

    for lead, want in expected.items():
        have = block.signals.get(lead)
        if have is None or len(have) != len(want):
            signals[lead] = want
            recomputed.append(lead)
            errors[lead] = float("nan")
            continue
        err = float(np.nanmax(np.abs(have - want))) if len(have) else 0.0
        errors[lead] = err
        if not np.isfinite(err) or err > tolerance_mv:
            signals[lead] = want
            recomputed.append(lead)

    flat = [l for l, x in signals.items()
            if len(x) and float(np.nanmax(x) - np.nanmin(x)) < 0.02]

    fixed = WaveformBlock(
        kind=block.kind,
        sample_rate_hz=block.sample_rate_hz,
        signals={l: signals[l] for l in LEAD_ORDER if l in signals},
        n_samples=block.n_samples,
        scale_uv_per_lsb=block.scale_uv_per_lsb,
        device_filters=block.device_filters,
    )
    return fixed, LeadConsistency(errors, recomputed, flat, tolerance_mv)


def multi_lead_rms(block: WaveformBlock, leads=tuple(INDEPENDENT_LEADS)) -> np.ndarray:
    """Root-mean-square across leads.

    Detection runs on this rather than on lead II alone so that one detached
    electrode does not take the whole delineation down with it.
    """
    mat = np.vstack([block.signals[l] for l in leads if l in block.signals])
    mat = np.where(np.isfinite(mat), mat, 0.0)
    return np.sqrt(np.mean(mat ** 2, axis=0))
