"""Vectorcardiography: 12-lead ECG -> the equivalent heart dipole d(t).

This is the Tier-2 core of CardioVis. Everything here is patient-specific and
defensible: 8 independent leads in, 3 numbers per instant out, by a published
linear transform. Nothing here claims to know *where* in the myocardium the
current is flowing - see LIMITATIONS.md.

Coordinate frame (Frank convention, shared with leads.py):
    +x subject left, +y subject foot (inferior), +z subject back (posterior)

Transform coefficients are quoted from the primary literature, not invented.
They are verified in tests/test_transforms.py, which checks that the inverse
Dower matrix really is the pseudo-inverse of the published forward Dower
matrix - silently wrong coefficients produce a beautiful, confidently incorrect
loop, and nothing downstream would notice.

References
----------
Dower GE, Machado HB, Osborne JA. On deriving the electrocardiogram from
    vectorcardiographic leads. Clin Cardiol. 1980;3(2):87-95.  (forward matrix)
Edenbrandt L, Pahlm O. Vectorcardiogram synthesized from a 12-lead ECG:
    superiority of the inverse Dower matrix. J Electrocardiol. 1988;21(4):361-367.
Kors JA, van Herpen G, Sittig AC, van Bemmel JH. Reconstruction of the
    Frank vectorcardiogram from standard electrocardiographic leads:
    diagnostic comparison of different methods. Eur Heart J. 1990;11(12):1083-1092.
Coefficient tables cross-checked against: Review of Processing Pathological
    Vectorcardiographic Records for the Detection of Heart Disease.
    Front Physiol. 2022;13:856590 (Tables 2 and 4).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .ecg_parser.base import WaveformBlock
from .leads import lead_matrix

#: Column order of every transform matrix below.
TRANSFORM_LEADS = ["I", "II", "V1", "V2", "V3", "V4", "V5", "V6"]

#: Dower 1980, forward: Frank (X, Y, Z) -> 8 leads. Rows in TRANSFORM_LEADS order.
FORWARD_DOWER = np.array([
    [0.632, -0.235, 0.059],    # I
    [0.235, 1.066, -0.132],    # II
    [-0.515, 0.157, -0.917],   # V1
    [0.044, 0.164, -1.387],    # V2
    [0.882, 0.098, -1.277],    # V3
    [1.213, 0.127, -0.601],    # V4
    [1.125, 0.127, -0.086],    # V5
    [0.831, 0.076, 0.230],     # V6
])

#: Edenbrandt & Pahlm 1988, the inverse Dower matrix: 8 leads -> (X, Y, Z).
INVERSE_DOWER = np.array([
    [0.156, -0.010, -0.172, -0.074, 0.122, 0.231, 0.239, 0.194],   # X
    [-0.227, 0.887, 0.057, -0.019, -0.106, -0.022, 0.041, 0.048],  # Y
    [0.022, 0.102, -0.229, -0.310, -0.246, -0.063, 0.055, 0.108],  # Z
])

#: Kors et al. 1990, regression transform: 8 leads -> (X, Y, Z).
KORS = np.array([
    [0.38, -0.07, -0.13, 0.05, -0.01, 0.14, 0.06, 0.54],    # X
    [-0.07, 0.93, 0.06, -0.02, -0.05, 0.06, -0.17, 0.13],   # Y
    [0.11, -0.23, -0.43, -0.06, -0.14, -0.20, -0.11, 0.31],  # Z
])

CITATIONS = {
    "kors": "Kors JA et al., Eur Heart J 1990;11(12):1083-1092 (regression transform)",
    "inverse_dower": ("Edenbrandt L, Pahlm O, J Electrocardiol 1988;21(4):361-367 "
                      "(inverse Dower matrix)"),
    "naive_pinv": ("Least-squares inverse of textbook lead vectors (Einthoven hexaxial "
                   "+ classical precordial angles). Teaching baseline only - see "
                   "METHODS.md for why it is inferior."),
}

METHOD_NOTES = {
    "kors": "Regression-derived on real Frank recordings; usually closest to a true Frank VCG.",
    "inverse_dower": "Pseudo-inverse of the Dower forward matrix; the classical synthesis.",
    "naive_pinv": ("Assumes idealised, patient-independent lead directions and an infinite "
                   "homogeneous torso. Included so the error it makes is visible."),
}


def naive_pinv_matrix() -> np.ndarray:
    """(3, 8) least-squares inverse of the textbook lead-vector matrix.

        d(t) = pinv(L) @ V(t)

    This is the naive answer to the inverse problem: assume every lead vector is
    the idealised direction drawn in the textbook figures and solve in the least
    squares sense. It ignores the torso entirely - the real precordial lead
    vectors depend on heart position, body shape and lung volume - so the loop it
    produces is systematically wrong in the horizontal plane. It is shipped so a
    student can see that, not because it should be used.
    """
    return np.linalg.pinv(lead_matrix(TRANSFORM_LEADS))


def transform_matrix(method: str) -> np.ndarray:
    m = method.lower()
    if m == "kors":
        return KORS
    if m in {"inverse_dower", "dower", "idt"}:
        return INVERSE_DOWER
    if m in {"naive_pinv", "naive", "pinv"}:
        return naive_pinv_matrix()
    raise ValueError("Unknown VCG method %r (kors | inverse_dower | naive_pinv)" % method)


@dataclass
class Vcg:
    """The reconstructed dipole trajectory d(t). Tier 2."""

    xyz: np.ndarray            # (3, n) in mV
    sample_rate_hz: float
    method: str
    citation: str

    @property
    def n_samples(self) -> int:
        return self.xyz.shape[1]

    def magnitude(self) -> np.ndarray:
        return np.linalg.norm(self.xyz, axis=0)

    def slice(self, lo: int, hi: int) -> np.ndarray:
        return self.xyz[:, max(0, lo):max(0, hi)]

    def project(self, lead_vector: np.ndarray) -> np.ndarray:
        """Scalar projection of d(t) on a lead vector - i.e. the lead signal
        that this dipole would produce. The killer feature (spec 3) is this one
        line, drawn."""
        u = np.asarray(lead_vector, dtype=float)
        return u @ self.xyz

    def to_json_meta(self) -> dict:
        return {"method": self.method, "citation": self.citation,
                "units": "mV", "frame": "x=left, y=inferior, z=posterior"}


def synthesize(block: WaveformBlock, method: str = "kors") -> Vcg:
    """Reconstruct d(t) from a (filtered) 12-lead block."""
    missing = [l for l in TRANSFORM_LEADS if l not in block.signals]
    if missing:
        raise ValueError("Cannot synthesise VCG, missing leads: %s" % ", ".join(missing))
    V = np.vstack([np.nan_to_num(block.signals[l], nan=0.0) for l in TRANSFORM_LEADS])
    M = transform_matrix(method)
    return Vcg(xyz=M @ V, sample_rate_hz=block.sample_rate_hz,
               method=method, citation=CITATIONS.get(method.lower(), ""))


def compare_methods(block: WaveformBlock, a: str = "kors",
                    b: str = "inverse_dower") -> dict:
    """How much does the choice of transform change the answer?

    Shown in the UI: two defensible published methods disagreeing by a visible
    amount is itself information about how much precision the Tier-2 layer has.
    """
    va, vb = synthesize(block, a), synthesize(block, b)
    out: dict[str, float] = {}
    for i, axis in enumerate("xyz"):
        x, y = va.xyz[i], vb.xyz[i]
        if np.std(x) < 1e-12 or np.std(y) < 1e-12:
            out["r_" + axis] = float("nan")
        else:
            out["r_" + axis] = float(np.corrcoef(x, y)[0, 1])
    diff = np.linalg.norm(va.xyz - vb.xyz, axis=0)
    mag = np.linalg.norm(va.xyz, axis=0)
    out["meanAbsDiffMv"] = float(np.mean(diff))
    out["maxAbsDiffMv"] = float(np.max(diff))
    out["relativeRms"] = float(np.sqrt(np.mean(diff ** 2)) /
                               (np.sqrt(np.mean(mag ** 2)) + 1e-12))
    out["methodA"], out["methodB"] = a, b
    return out
