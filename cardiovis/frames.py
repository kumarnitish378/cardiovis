"""Export: one recording -> one directory the web app can fetch.

Layout
------
  <out>/<record-id>/
      frames.json        metadata, tiers, fiducials, metrics, schedule, warnings
      leads.f32          Float32, 12 x N, lead-major, filtered, mV
      leads_raw.f32      Float32, 12 x N, lead-major, unfiltered, mV
      vcg.f32            Float32,  3 x N, x/y/z-major, mV
      vcg_alt.f32        Float32,  3 x N, the comparison transform
      model_vcg.f32      Float32,  3 x N, the Tier-3 synthetic dipole
      conduction.f32     Float32, (2*R) x N: R depolarised rows then R repolarised
      median.f32         Float32, 12 x M, the device median beat (if present)

Binary, not JSON: 12 leads x 5000 samples is 60k numbers, and parsing that as
JSON on every load costs more than fetching it. The frontend uploads these
straight into typed arrays and shader attributes.

frames.json never contains PHI - `deident.assert_phi_free` is run over it
before it is written, and the write fails rather than leaks.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from . import __version__, deident
from .conduction import ConductionFrames
from .delineate import Delineation
from .ecg_parser.base import LEAD_ORDER, Recording
from .filters import FilteredBlock
from .leads import (
    FRONTAL_LEAD_ANGLES_DEG,
    PRECORDIAL_LEAD_ANGLES_DEG,
    LeadConsistency,
    lead_unit_vector,
)
from .metrics import Metrics
from .tiers import TIER_LABELS, Tier
from .vcg import CITATIONS, METHOD_NOTES, Vcg

DISCLAIMER = ("For education and research. Not a medical device. Not for diagnosis "
              "or clinical decision-making.")


@dataclass
class ExportResult:
    directory: Path
    manifest: dict
    files: list[Path]


def _write_f32(path: Path, array: np.ndarray) -> dict:
    a = np.ascontiguousarray(np.nan_to_num(array, nan=0.0), dtype=np.float32)
    path.write_bytes(a.tobytes())
    return {"file": path.name, "shape": list(a.shape), "dtype": "float32",
            "order": "row-major"}


def export(recording: Recording, filtered: FilteredBlock, delin: Delineation,
           vcg: Vcg, vcg_alt: Vcg | None, metrics: Metrics,
           conduction: ConductionFrames | None, consistency: LeadConsistency,
           out_root: str | Path, *, method_comparison: dict | None = None,
           title: str | None = None, description: str | None = None,
           teaching: dict | None = None) -> ExportResult:
    out_root = Path(out_root)
    directory = out_root / recording.record_id
    directory.mkdir(parents=True, exist_ok=True)
    files: list[Path] = []
    binaries: dict[str, dict] = {}

    fs = filtered.sample_rate_hz
    n = filtered.filtered.n_samples

    def _stack(block, leads=LEAD_ORDER):
        return np.vstack([block.signals[l] for l in leads if l in block.signals])

    binaries["leads"] = _write_f32(directory / "leads.f32", _stack(filtered.filtered))
    binaries["leads"].update(leads=LEAD_ORDER, units="mV", sampleRateHz=fs, tier=1)
    binaries["leadsRaw"] = _write_f32(directory / "leads_raw.f32", _stack(filtered.raw))
    binaries["leadsRaw"].update(leads=LEAD_ORDER, units="mV", sampleRateHz=fs, tier=1)
    binaries["vcg"] = _write_f32(directory / "vcg.f32", vcg.xyz)
    binaries["vcg"].update(axes=["x", "y", "z"], units="mV", sampleRateHz=fs, tier=2,
                           method=vcg.method, citation=vcg.citation)
    if vcg_alt is not None:
        binaries["vcgAlt"] = _write_f32(directory / "vcg_alt.f32", vcg_alt.xyz)
        binaries["vcgAlt"].update(axes=["x", "y", "z"], units="mV", sampleRateHz=fs,
                                  tier=2, method=vcg_alt.method,
                                  citation=vcg_alt.citation)
    if conduction is not None:
        stacked = np.vstack([conduction.depolarised, conduction.repolarised])
        binaries["conduction"] = _write_f32(directory / "conduction.f32", stacked)
        binaries["conduction"].update(
            tier=3, sampleRateHz=fs, regions=conduction.region_keys,
            layout="rows 0..R-1 = depolarised fraction, rows R..2R-1 = repolarised fraction")
        binaries["modelVcg"] = _write_f32(directory / "model_vcg.f32",
                                          conduction.model_dipole)
        binaries["modelVcg"].update(axes=["x", "y", "z"], units="mV (arbitrary scale)",
                                    sampleRateHz=fs, tier=3)
    if recording.median is not None:
        binaries["medianBeat"] = _write_f32(directory / "median.f32",
                                            _stack(recording.median))
        binaries["medianBeat"].update(leads=LEAD_ORDER, units="mV", tier=1,
                                      sampleRateHz=recording.median.sample_rate_hz,
                                      note="Device-computed median/representative beat.")

    files.extend(directory / b["file"] for b in binaries.values())

    lead_vectors = {}
    for lead in LEAD_ORDER:
        v = lead_unit_vector(lead)
        lead_vectors[lead] = {
            "unitVector": [round(float(x), 4) for x in v],
            "plane": "frontal" if lead in FRONTAL_LEAD_ANGLES_DEG else "transverse",
            "angleDeg": FRONTAL_LEAD_ANGLES_DEG.get(lead,
                                                    PRECORDIAL_LEAD_ANGLES_DEG.get(lead)),
            "tier": 2 if lead in PRECORDIAL_LEAD_ANGLES_DEG else 1,
        }

    manifest = {
        "cardiovisVersion": __version__,
        "disclaimer": DISCLAIMER,
        "recordId": recording.record_id,
        "title": title or recording.record_id,
        "description": description,
        "teaching": teaching,
        "sourceFormat": recording.source_format,
        "subject": {
            "ageBand": recording.subject.age_band,
            "sex": recording.subject.sex,
            "acquisitionYear": recording.subject.acquisition_year,
        },
        "device": {k: v for k, v in recording.device.items() if k != "serialID"},
        "signal": {
            "sampleRateHz": fs,
            "nSamples": n,
            "durationS": round(n / fs, 3),
            "leads": LEAD_ORDER,
            "independentLeads": ["I", "II", "V1", "V2", "V3", "V4", "V5", "V6"],
            "filter": filtered.config.to_json(),
            "deviceFilters": filtered.raw.device_filters,
            "invalidSampleFraction": {k: round(v, 5)
                                      for k, v in filtered.invalid_fraction.items()},
            "leadConsistency": consistency.to_json(),
        },
        "leadVectors": lead_vectors,
        "delineation": delin.to_json(),
        "metrics": metrics.to_json(),
        "vcg": {
            "primary": vcg.to_json_meta(),
            "alternate": vcg_alt.to_json_meta() if vcg_alt else None,
            "comparison": method_comparison,
            "methodNotes": METHOD_NOTES,
            "citations": CITATIONS,
        },
        "conduction": conduction.to_json_meta() if conduction else None,
        "conductionSchedule": conduction.schedule if conduction else None,
        "tiers": {
            str(t.value): {"name": t.name, "label": TIER_LABELS[t],
                           "dismissible": t is not Tier.ILLUSTRATIVE}
            for t in Tier
        },
        "binaries": binaries,
        "notes": recording.notes,
    }

    # The device's own interpretive statements are deliberately absent: see
    # spec 1.1. They are parsed, they are never exported, they are never shown.
    deident.assert_phi_free(manifest, allow=(
        "$.tiers.*.name",                             # tier enum names, not people
        "$.conduction.regions[].name",                # anatomical region names
        "$.signal.deviceFilters.algorithms[].name",   # e.g. "Anti-Drift System"
    ))

    manifest_path = directory / "frames.json"
    manifest_path.write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    files.append(manifest_path)
    return ExportResult(directory=directory, manifest=manifest, files=files)


def write_index(out_root: str | Path) -> Path:
    """Rebuild the case index the frontend reads to populate the library."""
    out_root = Path(out_root)
    cases = []
    for child in sorted(out_root.iterdir()):
        mf = child / "frames.json"
        if not mf.is_file():
            continue
        data = json.loads(mf.read_text(encoding="utf-8"))
        cases.append({
            "recordId": data["recordId"],
            "path": child.name,
            "title": data.get("title") or data["recordId"],
            "description": data.get("description"),
            "ageBand": data["subject"]["ageBand"],
            "sex": data["subject"]["sex"],
            "heartRateBpm": data["metrics"]["intervals"].get("heartRateBpm"),
            "qrsMs": data["metrics"]["intervals"].get("qrsMs"),
            "durationS": data["signal"]["durationS"],
            "warnings": [w["code"] for w in data["delineation"]["warnings"]],
        })
    path = out_root / "index.json"
    path.write_text(json.dumps({"cases": cases, "disclaimer": DISCLAIMER}, indent=1),
                    encoding="utf-8")
    return path
