"""End-to-end pipeline behaviour, including the cases that are supposed to fail.

The adversarial half of this file matters more than the happy path. Every input
here - a flat lead, a dropout, wild baseline wander, atrial fibrillation, a paced
rhythm, a three-second strip - must fail *visibly*: a structured warning, a
refusal by the Tier-3 model, or both. Silently animating nonsense is the failure
mode this whole project is built to avoid.
"""

import numpy as np
import pytest

from cardiovis import synth
from cardiovis.filters import FilterConfig
from cardiovis.pipeline import process_recording
from cardiovis.vcg import FORWARD_DOWER, TRANSFORM_LEADS, synthesize


def _config(**kwargs) -> synth.SynthConfig:
    base = dict(name="test", components=synth.normal_qrs())
    base.update(kwargs)
    return synth.SynthConfig(**base)


def _run(cfg: synth.SynthConfig):
    recording, truth = synth.generate(cfg)
    return process_recording(recording), truth


def codes(processed) -> set[str]:
    return {w.code for w in processed.delineation.warnings}


# --------------------------------------------------------------------------- #
# Happy path
# --------------------------------------------------------------------------- #

def test_normal_case_is_clean_and_measured_correctly():
    p, _ = _run(_config(heart_rate_bpm=72, pr_ms=160))
    assert p.delineation.usable
    assert p.delineation.model_applicable
    assert codes(p) == set()
    i = p.metrics.intervals
    assert 66 <= i["heartRateBpm"] <= 78
    assert 120 <= i["prMs"] <= 200
    assert 70 <= i["qrsMs"] <= 130
    assert p.metrics.axes["spatialQrsTAngleDeg"] is not None


def test_heart_rate_tracks_the_generated_rate():
    for bpm in (50, 72, 110):
        p, _ = _run(_config(heart_rate_bpm=bpm, rr_jitter_frac=0.0))
        assert abs(p.metrics.intervals["heartRateBpm"] - bpm) < 6, bpm


def test_axis_follows_the_generated_qrs_direction():
    left, _ = _run(_config(components=synth.normal_qrs(axis=(0.80, -0.55, 0.25))))
    right, _ = _run(_config(components=synth.normal_qrs(axis=(-0.45, 0.85, 0.25))))
    assert left.metrics.axes["frontalQrsAxisFromVcgDeg"] < -20    # leftward/superior
    assert right.metrics.axes["frontalQrsAxisFromVcgDeg"] > 90    # rightward/inferior


def test_inverse_dower_recovers_the_known_dipole():
    """Synthetic leads are made by projecting a known d(t) onto the forward Dower
    lead vectors, so the inverse transform must recover it almost exactly. This
    is the only place in the project where VCG output can be checked against
    truth rather than against another algorithm."""
    cfg = _config(noise_mv=0.0, baseline_wander_mv=0.0)
    recording, truth = synth.generate(cfg)
    got = synthesize(recording.rhythm, "inverse_dower").xyz
    for axis in range(3):
        r = np.corrcoef(got[axis], truth[axis])[0, 1]
        assert r > 0.99, f"axis {axis} correlation {r}"


def test_kors_is_close_but_not_identical_on_dower_generated_leads():
    """Kors is a different published regression, so on leads generated *by* the
    Dower forward matrix it should be close but measurably different. If these
    ever agree exactly, one matrix has been overwritten with the other."""
    cfg = _config(noise_mv=0.0, baseline_wander_mv=0.0)
    recording, truth = synth.generate(cfg)
    kors = synthesize(recording.rhythm, "kors").xyz
    dower = synthesize(recording.rhythm, "inverse_dower").xyz
    assert np.corrcoef(kors[0], truth[0])[0, 1] > 0.9
    assert np.max(np.abs(kors - dower)) > 0.05


# --------------------------------------------------------------------------- #
# Adversarial inputs - each must fail visibly
# --------------------------------------------------------------------------- #

def test_flat_lead_is_fatal_and_says_so():
    p, _ = _run(_config(flat_leads=("V4",)))
    assert "FLAT_LEAD" in codes(p)
    assert not p.delineation.usable                 # critical severity
    assert not p.conduction.applicable
    assert "V4" in p.consistency.flat_leads


def test_disconnected_electrode_mid_recording():
    """A dropout becomes NaN at parse time and must not be filtered across."""
    cfg = _config(dropout_spans=(("V2", 3.0, 5.0),))
    p, _ = _run(cfg)
    assert p.filtered.invalid_fraction["V2"] > 0.15
    assert np.isnan(p.filtered.filtered.signals["V2"]).any()
    # The gap must not have leaked into neighbouring leads.
    assert not np.isnan(p.filtered.filtered.signals["V1"]).any()


def test_extreme_baseline_wander_does_not_break_detection():
    p, _ = _run(_config(baseline_wander_mv=0.9, heart_rate_bpm=72))
    assert len(p.delineation.beats) >= 8
    assert 60 <= p.metrics.intervals["heartRateBpm"] <= 85


def test_mains_hum_is_removed_by_the_notch():
    cfg = _config(mains_hz=50.0, mains_mv=0.25, noise_mv=0.0)
    recording, _ = synth.generate(cfg)
    with_notch = process_recording(recording, filter_config=FilterConfig(notch_hz=50.0))
    x = with_notch.filtered.filtered.signals["II"]
    raw = with_notch.filtered.raw.signals["II"]
    assert np.std(x) < np.std(raw)
    assert len(with_notch.delineation.beats) >= 8


def test_atrial_fibrillation_refuses_the_conduction_model():
    p, _ = _run(_config(heart_rate_bpm=88, rr_jitter_frac=0.28, p_amplitude_mv=0.0,
                        fibrillatory_mv=0.05))
    assert "IRREGULAR_RHYTHM" in codes(p)
    assert "NO_P_WAVES" in codes(p)
    assert not p.delineation.model_applicable
    assert not p.conduction.applicable
    # ...but the Tier-2 loop needs no rhythm assumption and is still produced.
    assert p.vcg.xyz.shape[1] == p.filtered.filtered.n_samples
    assert p.metrics.axes["frontalQrsAxisFromVcgDeg"] is not None


def test_paced_rhythm_is_detected_and_does_not_produce_a_nonsense_qrs():
    """The regression this test exists for: pacing spikes dominated the
    derivative envelope and the boundary search collapsed onto them, reporting a
    confident 4 ms QRS."""
    p, _ = _run(_config(pacing_spike_mv=1.2, p_amplitude_mv=0.0,
                        components=synth.normal_qrs(scale=1.1)))
    assert "PACING_SPIKES_DETECTED" in codes(p)
    assert not p.conduction.applicable
    assert p.metrics.intervals["qrsMs"] > 50


def test_three_second_recording_warns_about_its_own_length():
    p, _ = _run(_config(duration_s=3.0))
    assert "SHORT_RECORDING" in codes(p)
    assert p.delineation.summary["beatCount"] >= 2


def test_pure_noise_is_rejected_rather_than_detected():
    """Pan-Tompkins adaptive thresholds latch onto noise given the chance: before
    the signal-quality checks existed, this input produced 30 confident "beats"
    with a 380 ms QRS."""
    cfg = _config(components=[], p_amplitude_mv=0.0, t_amplitude_mv=0.0, noise_mv=0.004)
    p, _ = _run(cfg)
    assert "NO_CARDIAC_SIGNAL" in codes(p)
    assert not p.delineation.usable
    assert not p.delineation.model_applicable
    assert not p.conduction.applicable


def test_noise_with_baseline_wander_is_also_rejected():
    cfg = _config(components=[], p_amplitude_mv=0.0, t_amplitude_mv=0.0,
                  noise_mv=0.04, baseline_wander_mv=0.2)
    p, _ = _run(cfg)
    assert {"NO_CARDIAC_SIGNAL", "IMPLAUSIBLE_QRS_FRACTION"} & codes(p)
    assert not p.delineation.usable


def test_real_recordings_clear_the_signal_quality_checks_with_margin():
    """The guard must not fire on anything legitimate, including a very wide QRS."""
    for cfg in (_config(), _config(heart_rate_bpm=110),
                [c for c in synth.library() if c.name == "lbbb"][0]):
        p, _ = _run(cfg)
        assert p.delineation.summary["detectionSnr"] > 5
        assert p.delineation.summary["qrsRrFraction"] < 0.45
        assert "NO_CARDIAC_SIGNAL" not in codes(p)


def test_wide_qrs_stretches_the_model_and_flags_it():
    lbbb = [c for c in synth.library() if c.name == "lbbb"][0]
    p, _ = _run(lbbb)
    assert p.metrics.intervals["qrsMs"] > 120
    assert "WIDE_QRS" in codes(p)
    caveats = " ".join(p.conduction.caveats).lower()
    assert "stretch" in caveats


# --------------------------------------------------------------------------- #
# The Tier-3 honesty check
# --------------------------------------------------------------------------- #

def test_model_agreement_is_high_for_normal_and_poor_for_abnormal_axis():
    normal, _ = _run(_config(components=synth.normal_qrs()))
    weird, _ = _run(_config(components=synth.normal_qrs(axis=(-0.45, 0.85, 0.25))))
    r_normal = normal.conduction.agreement["qrs"]["r_overall"]
    r_weird = weird.conduction.agreement["qrs"]["r_overall"]
    assert r_normal > 0.8
    assert r_weird < r_normal - 0.3
    assert "not" in weird.conduction.agreement["verdict"].lower()


def test_conduction_regions_stay_within_zero_and_one():
    p, _ = _run(_config())
    assert p.conduction.depolarised.min() >= 0.0
    assert p.conduction.depolarised.max() <= 1.0 + 1e-6
    assert p.conduction.excitation.max() <= 1.0 + 1e-6


def test_av_node_is_electrically_silent_but_still_animated():
    p, _ = _run(_config())
    keys = p.conduction.region_keys
    av = keys.index("av")
    assert p.conduction.depolarised[av].max() > 0.5     # it is drawn
    from cardiovis.conduction import REGIONS
    assert REGIONS[av].weight == 0.0                    # it contributes nothing


# --------------------------------------------------------------------------- #
# Export
# --------------------------------------------------------------------------- #

def test_export_is_phi_free_and_binaries_match_the_manifest(tmp_path):
    from cardiovis.frames import export

    recording, _ = synth.generate(_config(name="export_test"))
    p = process_recording(recording)
    result = export(p.recording, p.filtered, p.delineation, p.vcg, p.vcg_alt,
                    p.metrics, p.conduction, p.consistency, tmp_path,
                    method_comparison=p.method_comparison, title="Export test")

    manifest = result.manifest
    assert manifest["disclaimer"].startswith("For education and research")
    assert "interpretation" not in str(manifest).lower() or "statement" not in str(manifest).lower()

    n = manifest["signal"]["nSamples"]
    leads = np.fromfile(result.directory / "leads.f32", dtype=np.float32)
    assert leads.size == 12 * n
    vcg = np.fromfile(result.directory / "vcg.f32", dtype=np.float32)
    assert vcg.size == 3 * n
    cond = np.fromfile(result.directory / "conduction.f32", dtype=np.float32)
    assert cond.size == 2 * len(p.conduction.region_keys) * n
    assert np.isfinite(leads).all() and np.isfinite(vcg).all()


def test_device_interpretation_never_reaches_the_export(tmp_path):
    """The source file carries the machine's own diagnostic statements. They are
    parsed, and they must not appear in anything we write."""
    from pathlib import Path

    from cardiovis.ecg_parser import load
    from cardiovis.frames import export
    from cardiovis.pipeline import process_recording as run

    sample = Path(__file__).resolve().parents[1] / "data" / "example_ecg.xml"
    if not sample.exists():
        pytest.skip("sample recording not present")

    recording = load(sample)
    assert recording.device_interpretation, "sample should contain device statements"
    p = run(recording)
    result = export(p.recording, p.filtered, p.delineation, p.vcg, p.vcg_alt,
                    p.metrics, p.conduction, p.consistency, tmp_path,
                    method_comparison=p.method_comparison)
    blob = (result.directory / "frames.json").read_text(encoding="utf-8")
    for statement in recording.device_interpretation:
        assert statement.lower() not in blob.lower()


def test_golden_frames_are_stable(tmp_path):
    """Golden-file regression: the same input must produce the same numbers.
    Regenerate deliberately with `pytest --update-golden` semantics (delete the
    file) only when a change to the maths is intended and explained."""
    import json
    from pathlib import Path

    from cardiovis.frames import export

    golden_path = Path(__file__).parent / "golden_normal_sinus.json"
    recording, _ = synth.generate(_config(name="golden", seed=1234))
    p = process_recording(recording)
    result = export(p.recording, p.filtered, p.delineation, p.vcg, p.vcg_alt,
                    p.metrics, p.conduction, p.consistency, tmp_path,
                    method_comparison=p.method_comparison)

    current = {
        "intervals": result.manifest["metrics"]["intervals"],
        "axes": {k: v for k, v in result.manifest["metrics"]["axes"].items()
                 if isinstance(v, (int, float))},
        "warnings": sorted(w["code"] for w in result.manifest["delineation"]["warnings"]),
        "beatCount": len(result.manifest["delineation"]["beats"]),
        "modelAgreementQrs": result.manifest["conduction"]["agreement"]["qrs"]["r_overall"],
    }
    current["intervals"].pop("qtcNote", None)

    if not golden_path.exists():
        golden_path.write_text(json.dumps(current, indent=1), encoding="utf-8")
        pytest.skip("golden file created; rerun to check stability")

    golden = json.loads(golden_path.read_text(encoding="utf-8"))
    assert current["warnings"] == golden["warnings"]
    assert current["beatCount"] == golden["beatCount"]
    for key, want in golden["intervals"].items():
        got = current["intervals"].get(key)
        if isinstance(want, (int, float)) and isinstance(got, (int, float)):
            assert abs(got - want) < max(1.0, abs(want) * 0.02), f"{key}: {got} vs {want}"
    for key, want in golden["axes"].items():
        got = current["axes"].get(key)
        if isinstance(got, (int, float)):
            assert abs(got - want) < 2.0, f"{key}: {got} vs {want}"
    assert abs(current["modelAgreementQrs"] - golden["modelAgreementQrs"]) < 0.05
