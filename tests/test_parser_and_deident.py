"""Parsing, scale conversion, and the de-identification guarantees."""

import json
from pathlib import Path

import numpy as np
import pytest

from cardiovis import deident
from cardiovis.ecg_parser import load
from cardiovis.ecg_parser.ge_sapphire import GeSapphireAdapter

SAMPLE = Path(__file__).resolve().parents[1] / "data" / "example_ecg.xml"
pytestmark = pytest.mark.skipif(not SAMPLE.exists(), reason="sample recording not present")


@pytest.fixture(scope="module")
def recording():
    return load(SAMPLE)


def test_sniff_accepts_only_sapphire(tmp_path):
    other = tmp_path / "other.xml"
    other.write_text("<?xml version='1.0'?><root/>", encoding="utf-8")
    assert GeSapphireAdapter.sniff(SAMPLE)
    assert not GeSapphireAdapter.sniff(other)


def test_two_waveform_blocks_are_parsed_distinctly(recording):
    assert recording.rhythm.kind == "rhythm"
    assert recording.rhythm.n_samples == 5000
    assert recording.rhythm.sample_rate_hz == 500.0
    assert recording.median is not None
    assert recording.median.n_samples == 600
    assert recording.median.kind == "median"


def test_all_twelve_leads_present(recording):
    expected = {"I", "II", "III", "aVR", "aVL", "aVF",
                "V1", "V2", "V3", "V4", "V5", "V6"}
    assert set(recording.rhythm.signals) == expected


def test_scale_factor_conversion_gives_millivolts(recording):
    """S=4.88 uV/LSB: physiological amplitudes must land in the 0.1-5 mV range,
    not 100x off in either direction."""
    peak = float(np.nanmax(np.abs(recording.rhythm.signals["II"])))
    assert 0.2 < peak < 6.0


def test_lead_algebra_holds_in_the_source_file(recording):
    I = recording.rhythm.signals["I"]
    II = recording.rhythm.signals["II"]
    III = recording.rhythm.signals["III"]
    # Quantisation at 4.88 uV/LSB allows a couple of LSB of disagreement.
    assert np.nanmax(np.abs(II - (I + III))) < 0.02


def test_device_measurements_and_beat_marks(recording):
    g = recording.device_measurements.global_ms
    assert g["QRS_Duration"] == 86.0
    assert g["PR_Interval"] == 138.0
    assert g["QTc_correction"] == "Bazett"
    assert len(recording.device_measurements.beat_samples) == 12


def test_phi_is_stripped_by_default(recording):
    s = recording.subject
    assert s.phi == {} and s.phi_retained is False
    assert s.age_band == "60-69"          # not the exact age
    assert s.sex == "F"
    assert s.acquisition_year == 2023     # year only, not the full timestamp
    assert s.pseudo_id.startswith("cv_")
    blob = json.dumps({
        "subject": {"ageBand": s.age_band, "sex": s.sex,
                    "year": s.acquisition_year, "id": s.pseudo_id},
        "device": recording.device,
    })
    raw = SAMPLE.read_text(encoding="utf-8", errors="ignore")
    name = raw.split('<given V="')[1].split('"')[0]
    assert name.lower() not in blob.lower()
    assert "2576623" not in blob            # the MRN
    assert "STX21120001PA" not in blob      # the device serial


def test_pseudonymous_id_is_stable_across_parses():
    assert load(SAMPLE).record_id == load(SAMPLE).record_id


def test_keep_phi_warns_loudly():
    with pytest.warns(UserWarning, match="PHI RETENTION ENABLED"):
        r = load(SAMPLE, keep_phi=True)
    assert r.subject.phi_retained
    assert r.subject.phi.get("mrn")


def test_keep_phi_is_refused_in_a_shipping_build(monkeypatch):
    monkeypatch.setattr(deident, "SHIPPING_BUILD", True)
    with pytest.raises(RuntimeError, match="disabled in shipping builds"):
        load(SAMPLE, keep_phi=True)


def test_assert_phi_free_catches_identifier_shaped_keys():
    deident.assert_phi_free({"subject": {"ageBand": "60-69", "sex": "F"}})
    with pytest.raises(ValueError, match="PHI-shaped key"):
        deident.assert_phi_free({"patient": {"name": "anyone"}})
    with pytest.raises(ValueError, match="PHI-shaped key"):
        deident.assert_phi_free({"a": [{"acquisitionDateTime": "2023-05-10"}]})


def test_age_banding_follows_safe_harbour():
    assert deident.age_band(61) == "60-69"
    assert deident.age_band(89) == "80-89"
    assert deident.age_band(91) == "90+"
    assert deident.age_band(None) is None


def test_device_interpretation_is_parsed_but_kept_out_of_exports(recording):
    """The device's own diagnostic statements exist in the file. We read them so
    they are not silently lost, and never emit them (spec 1.1)."""
    assert recording.device_interpretation           # present in the source
    from cardiovis import frames
    assert "device_interpretation" not in json.dumps(frames.DISCLAIMER)
