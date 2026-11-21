"""Lead algebra identities on synthetic input.

These relationships are definitional, so any failure here means the data model
is wrong, not that the patient is unusual.
"""

import numpy as np
import pytest

from cardiovis.ecg_parser.base import WaveformBlock
from cardiovis.leads import (
    FRONTAL_LEAD_ANGLES_DEG,
    derive_from_i_ii,
    enforce_lead_consistency,
    lead_unit_vector,
)


def _block(signals, fs=500.0):
    n = len(next(iter(signals.values())))
    return WaveformBlock(kind="rhythm", sample_rate_hz=fs, signals=signals, n_samples=n)


@pytest.fixture
def synthetic():
    rng = np.random.default_rng(7)
    n = 1000
    I = rng.normal(size=n).cumsum() / 50
    II = rng.normal(size=n).cumsum() / 50
    return I, II


def test_einthoven_and_goldberger(synthetic):
    I, II = synthetic
    d = derive_from_i_ii(I, II)
    assert np.allclose(II, I + d["III"])                       # II = I + III
    assert np.allclose(d["aVR"], -(I + II) / 2)
    assert np.allclose(d["aVL"], (I - d["III"]) / 2)
    assert np.allclose(d["aVF"], (II + d["III"]) / 2)
    # The three augmented leads sum to zero - a consequence of the definitions.
    assert np.allclose(d["aVR"] + d["aVL"] + d["aVF"], 0.0, atol=1e-12)


def test_consistent_leads_are_left_alone(synthetic):
    I, II = synthetic
    sig = {"I": I, "II": II, **derive_from_i_ii(I, II)}
    sig.update({f"V{i}": np.zeros_like(I) for i in range(1, 7)})
    fixed, report = enforce_lead_consistency(_block(sig))
    assert report.recomputed == []
    assert report.ok
    assert np.allclose(fixed.signals["III"], sig["III"])


def test_corrupt_lead_is_recomputed(synthetic):
    I, II = synthetic
    sig = {"I": I, "II": II, **derive_from_i_ii(I, II)}
    sig.update({f"V{i}": np.zeros_like(I) for i in range(1, 7)})
    sig["aVR"] = sig["aVR"] + 0.5                      # a wrong stored lead
    fixed, report = enforce_lead_consistency(_block(sig))
    assert "aVR" in report.recomputed
    assert np.allclose(fixed.signals["aVR"], -(I + II) / 2)
    assert not report.ok


def test_flat_lead_is_reported(synthetic):
    I, II = synthetic
    sig = {"I": I, "II": II, **derive_from_i_ii(I, II)}
    sig.update({f"V{i}": np.zeros_like(I) for i in range(1, 7)})
    _, report = enforce_lead_consistency(_block(sig))
    assert set(report.flat_leads) >= {"V1", "V6"}


def test_lead_unit_vectors_are_unit_and_oriented():
    for lead, angle in FRONTAL_LEAD_ANGLES_DEG.items():
        v = lead_unit_vector(lead)
        assert np.isclose(np.linalg.norm(v), 1.0)
        assert np.isclose(v[2], 0.0)                   # frontal leads have no z
    assert lead_unit_vector("I")[0] > 0.99             # I points subject-left
    assert lead_unit_vector("aVF")[1] > 0.99           # aVF points inferior
    assert lead_unit_vector("V6")[0] > 0.99            # V6 points left
    assert lead_unit_vector("V1")[2] < -0.8            # V1 points anterior (-z)
    assert lead_unit_vector("V1")[0] < 0               # ...and to the right


def test_projection_of_a_dipole_reproduces_einthoven():
    """A dipole projected on the lead axes must satisfy II = I + III."""
    d = np.array([0.7, 0.5, -0.2])
    vI = lead_unit_vector("I") @ d
    vII = lead_unit_vector("II") @ d
    vIII = lead_unit_vector("III") @ d
    assert np.isclose(vII, vI + vIII, atol=1e-12)
