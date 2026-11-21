"""The whole pipeline in one call: file in, export directory out.

    parse (+ de-identify)  ->  validate lead algebra  ->  filter
        ->  delineate  ->  VCG (Tier 2)  ->  metrics  ->  conduction (Tier 3)
        ->  export

Every stage is importable on its own; this module only wires them together in
the order the tiers require.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from . import conduction as conduction_mod
from . import frames as frames_mod
from . import metrics as metrics_mod
from . import vcg as vcg_mod
from .conduction import ConductionFrames
from .delineate import Delineation, delineate, find_pacing_spikes
from .ecg_parser import Recording, load
from .filters import FilterConfig, FilteredBlock, apply_filters
from .leads import LeadConsistency, enforce_lead_consistency
from .metrics import Metrics


@dataclass
class Processed:
    recording: Recording
    consistency: LeadConsistency
    filtered: FilteredBlock
    delineation: Delineation
    vcg: vcg_mod.Vcg
    vcg_alt: vcg_mod.Vcg
    method_comparison: dict
    metrics: Metrics
    conduction: ConductionFrames

    def summary_lines(self) -> list[str]:
        i = self.metrics.intervals
        a = self.metrics.axes
        dev = i.get("deviceReported") or {}

        def fmt(v, unit=""):
            return "-" if v is None else ("%.0f%s" % (v, unit) if isinstance(v, float)
                                          else "%s%s" % (v, unit))

        lines = [
            "record            %s   (%s, %s, %s)" % (
                self.recording.record_id, self.recording.subject.age_band or "age ?",
                self.recording.subject.sex or "sex ?",
                self.recording.subject.acquisition_year or "year ?"),
            "signal            %d leads, %.0f Hz, %.1f s" % (
                len(self.filtered.filtered.signals), self.filtered.sample_rate_hz,
                self.filtered.filtered.n_samples / self.filtered.sample_rate_hz),
            "filter            %s" % self.filtered.config.describe(),
            "",
            "TIER 1  measured",
            "  beats detected  %s" % fmt(i.get("beatCount")),
            "TIER 2  derived from this recording",
            "  heart rate      %s   (device %s)" % (fmt(i.get("heartRateBpm"), " bpm"),
                                                    fmt(dev.get("rrMs") and 60000 / dev["rrMs"], " bpm")),
            "  PR              %s   (device %s)" % (fmt(i.get("prMs"), " ms"), fmt(dev.get("prMs"), " ms")),
            "  QRS             %s   (device %s)" % (fmt(i.get("qrsMs"), " ms"), fmt(dev.get("qrsMs"), " ms")),
            "  QT              %s   (device %s)" % (fmt(i.get("qtMs"), " ms"), fmt(dev.get("qtMs"), " ms")),
            "  QTc Bazett      %s   Fridericia %s" % (fmt(i.get("qtcBazettMs"), " ms"),
                                                      fmt(i.get("qtcFridericiaMs"), " ms")),
            "  frontal QRS axis %s  (from VCG %s, device %s)" % (
                fmt(a.get("frontalQrsAxisDeg"), " deg"),
                fmt(a.get("frontalQrsAxisFromVcgDeg"), " deg"),
                fmt((a.get("deviceReported") or {}).get("qrsAxisDeg"), " deg")),
            "  spatial QRS-T   %s" % fmt(a.get("spatialQrsTAngleDeg"), " deg"),
            "  VCG %s vs %s    r_x %.3f  r_y %.3f  r_z %.3f" % (
                self.method_comparison["methodA"], self.method_comparison["methodB"],
                self.method_comparison["r_x"], self.method_comparison["r_y"],
                self.method_comparison["r_z"]),
            "TIER 3  illustrative conduction model",
            "  applicable      %s" % ("yes" if self.conduction.applicable
                                      else "no - see warnings"),
        ]
        ag = self.conduction.agreement.get("qrs", {}) if self.conduction.agreement else {}
        if ag.get("r_overall") is not None:
            lines.append("  model vs measured dipole (QRS)  r = %.3f" % ag["r_overall"])
            lines.append("  %s" % self.conduction.agreement["verdict"])
        if self.delineation.warnings:
            lines.append("")
            lines.append("WARNINGS")
            for w in self.delineation.warnings:
                lines.append("  [%s] %s: %s" % (w.severity.upper(), w.code, w.message))
        return lines


def process(path: str | Path, *, keep_phi: bool = False,
            filter_config: FilterConfig | None = None,
            vcg_method: str = "kors", vcg_alt_method: str = "inverse_dower",
            skip_conduction: bool = False) -> Processed:
    return process_recording(
        load(path, keep_phi=keep_phi), filter_config=filter_config,
        vcg_method=vcg_method, vcg_alt_method=vcg_alt_method,
        skip_conduction=skip_conduction)


def process_recording(recording: Recording, *,
                      filter_config: FilterConfig | None = None,
                      vcg_method: str = "kors", vcg_alt_method: str = "inverse_dower",
                      skip_conduction: bool = False) -> Processed:
    """Same pipeline, for a Recording that is already in memory - a synthetic
    case, or one produced by an adapter that does not read from disk."""
    block, consistency = enforce_lead_consistency(recording.rhythm)
    # Spikes must be found before filtering: a 40 Hz low-pass hides them.
    spikes = find_pacing_spikes(block)
    filtered = apply_filters(block, filter_config)

    delin = delineate(
        filtered.filtered,
        device_pace_samples=recording.device_measurements.pace_samples,
        flat_leads=consistency.flat_leads,
        recomputed_leads=consistency.recomputed,
        spike_samples=spikes,
    )

    v = vcg_mod.synthesize(filtered.filtered, vcg_method)
    v_alt = vcg_mod.synthesize(filtered.filtered, vcg_alt_method)
    comparison = vcg_mod.compare_methods(filtered.filtered, vcg_method, vcg_alt_method)

    mets = metrics_mod.compute(v, delin, filtered.filtered,
                               recording.device_measurements.global_ms)

    if skip_conduction:
        cond = ConductionFrames(region_keys=[], depolarised=None, repolarised=None,
                                model_dipole=None, sample_rate_hz=filtered.sample_rate_hz,
                                applicable=False,
                                caveats=["Conduction model was not built."])
    else:
        cond = conduction_mod.build(delin, filtered.filtered.n_samples, measured_vcg=v)

    return Processed(recording=recording, consistency=consistency, filtered=filtered,
                     delineation=delin, vcg=v, vcg_alt=v_alt,
                     method_comparison=comparison, metrics=mets, conduction=cond)


def process_and_export(path: str | Path, out_root: str | Path, **kwargs):
    return _export(process(path, **_split(kwargs)[0]), out_root, **_split(kwargs)[1])


def process_recording_and_export(recording: Recording, out_root: str | Path, **kwargs):
    proc_kwargs, export_kwargs = _split(kwargs)
    return _export(process_recording(recording, **proc_kwargs), out_root, **export_kwargs)


def _split(kwargs: dict) -> tuple[dict, dict]:
    export_keys = {"title", "description", "teaching"}
    return ({k: v for k, v in kwargs.items() if k not in export_keys},
            {k: v for k, v in kwargs.items() if k in export_keys})


def _export(p: Processed, out_root, title=None, description=None, teaching=None):
    result = frames_mod.export(
        p.recording, p.filtered, p.delineation, p.vcg, p.vcg_alt, p.metrics,
        p.conduction if p.conduction.depolarised is not None else None,
        p.consistency, out_root, method_comparison=p.method_comparison,
        title=title, description=description, teaching=teaching)
    return p, result
