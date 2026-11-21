"""VCG transform coefficients.

The point of this file: silently wrong coefficients produce a beautiful,
confidently incorrect loop that nothing downstream can detect. So the published
inverse Dower matrix is checked against an independent published quantity - the
forward Dower matrix it is the pseudo-inverse of - rather than against itself.
"""

import numpy as np
import pytest

from cardiovis.ecg_parser.base import WaveformBlock
from cardiovis.vcg import (
    FORWARD_DOWER,
    INVERSE_DOWER,
    KORS,
    TRANSFORM_LEADS,
    compare_methods,
    naive_pinv_matrix,
    synthesize,
    transform_matrix,
)


def test_inverse_dower_is_the_pseudoinverse_of_forward_dower():
    """Edenbrandt & Pahlm (1988) derived the inverse Dower matrix as the
    pseudo-inverse of Dower's (1980) forward matrix. Two independently published
    tables; if our transcription of either is wrong, they will not agree."""
    computed = np.linalg.pinv(FORWARD_DOWER)          # (3, 8)
    assert computed.shape == INVERSE_DOWER.shape
    assert np.max(np.abs(computed - INVERSE_DOWER)) < 1e-3


def test_forward_then_inverse_dower_is_near_identity():
    """XYZ -> 12 lead -> XYZ must return what it started with."""
    rng = np.random.default_rng(3)
    xyz = rng.normal(size=(3, 500))
    leads = FORWARD_DOWER @ xyz
    back = INVERSE_DOWER @ leads
    assert np.max(np.abs(back - xyz)) < 5e-3


def test_matrix_shapes_and_lead_order():
    assert INVERSE_DOWER.shape == (3, 8)
    assert KORS.shape == (3, 8)
    assert TRANSFORM_LEADS == ["I", "II", "V1", "V2", "V3", "V4", "V5", "V6"]


def test_kors_coefficients_are_the_published_ones():
    """Kors et al. 1990, Table of regression coefficients. Spot-checked against
    the review table in Front Physiol 2022;13:856590."""
    x_row = dict(zip(TRANSFORM_LEADS, KORS[0]))
    y_row = dict(zip(TRANSFORM_LEADS, KORS[1]))
    z_row = dict(zip(TRANSFORM_LEADS, KORS[2]))
    assert x_row["I"] == 0.38 and x_row["V6"] == 0.54
    assert y_row["II"] == 0.93 and y_row["V5"] == -0.17
    assert z_row["V1"] == -0.43 and z_row["V6"] == 0.31


def test_transform_axes_point_the_right_way():
    """A lead pattern dominated by II must produce a downward (inferior) Y, and
    a dominant V1 must produce an anterior (negative Z) component."""
    for name in ("kors", "inverse_dower"):
        M = transform_matrix(name)
        v = np.zeros(8)
        v[TRANSFORM_LEADS.index("II")] = 1.0
        assert (M @ v)[1] > 0.5                      # positive II -> inferior
        v = np.zeros(8)
        v[TRANSFORM_LEADS.index("V1")] = 1.0
        assert (M @ v)[2] < 0                        # positive V1 -> anterior


def test_naive_pinv_is_a_left_inverse_of_the_textbook_lead_matrix():
    from cardiovis.leads import lead_matrix
    P = naive_pinv_matrix()
    L = lead_matrix(TRANSFORM_LEADS)
    assert np.allclose(P @ L, np.eye(3), atol=1e-10)


def test_naive_transform_disagrees_with_kors_as_documented():
    """The naive transform is shipped so students can see it is worse. If it
    ever stops disagreeing, something has been silently changed."""
    rng = np.random.default_rng(11)
    xyz = rng.normal(size=(3, 400))
    leads = FORWARD_DOWER @ xyz
    signals = {l: leads[i] for i, l in enumerate(TRANSFORM_LEADS)}
    signals["III"] = signals["II"] - signals["I"]
    block = WaveformBlock("rhythm", 500.0, signals, leads.shape[1])
    naive = synthesize(block, "naive_pinv").xyz
    kors = synthesize(block, "kors").xyz
    err_naive = np.linalg.norm(naive - xyz)
    err_kors = np.linalg.norm(kors - xyz)
    assert err_naive > err_kors


def test_synthesize_requires_all_independent_leads():
    signals = {l: np.zeros(10) for l in TRANSFORM_LEADS[:-1]}
    block = WaveformBlock("rhythm", 500.0, signals, 10)
    with pytest.raises(ValueError, match="missing leads"):
        synthesize(block, "kors")


def test_compare_methods_reports_a_relative_difference():
    rng = np.random.default_rng(5)
    xyz = rng.normal(size=(3, 300))
    leads = FORWARD_DOWER @ xyz
    signals = {l: leads[i] for i, l in enumerate(TRANSFORM_LEADS)}
    block = WaveformBlock("rhythm", 500.0, signals, leads.shape[1])
    out = compare_methods(block)
    assert set(out) >= {"r_x", "r_y", "r_z", "relativeRms", "methodA", "methodB"}
    assert 0.0 <= out["relativeRms"] < 2.0
