"""GE Sapphire / DCAR XML adapter (urn:ge:sapphire:dcar_1).

Layout of the format, as observed in MAC2000 exports:

  sapphire/dcarRecord/patientInfo/visit/order/ecgResting/params/ecg
    cfg   - report configuration (writer speed, gains, rhythm lead groups)
    wav   - ecgWaveformMXG  : the rhythm strip (e.g. 5000 samples = 10 s @ 500 Hz)
    num   - device rate/interval numerics
    var/medianTemplate
          - measurements    : global + per-lead numbers from the device algorithm
          - ecgWaveformMXG  : the median / representative beat (e.g. 600 samples)
    interpretation          : the device statements (parsed, never shown - see 1.1)
    evt/beat/any/tpoint/toc : device beat marks, in samples of the rhythm block
    evt/wavp/pace/.../toc   : device pacemaker-spike marks

  ecgWaveformMXG attributes: U (unit, e.g. "uV"), S (scale per LSB, e.g. 4.88),
  INV (sentinel for invalid samples, e.g. -32768).

Conversion: mV = raw * S / 1000 when U == "uV".
"""

from __future__ import annotations

import hashlib
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

import numpy as np

from .. import deident
from .base import (
    DeviceMeasurements,
    EcgAdapter,
    Recording,
    Subject,
    WaveformBlock,
    canonical_lead,
    register,
)

NS = {"s": "urn:ge:sapphire:dcar_1"}
_UNIT_TO_MV = {"uv": 1e-3, "mv": 1.0, "v": 1e3}


def _v(el, attr: str = "V", cast=str, default=None):
    if el is None:
        return default
    raw = el.get(attr)
    if raw is None or raw == "":
        return default
    try:
        return cast(raw)
    except (TypeError, ValueError):
        return default


def _find(root, path: str):
    return root.find(path, NS)


def scrub_file(src: Path, dst: Path) -> dict:
    """Write a de-identified copy of a Sapphire XML file.

    The waveforms, device measurements and acquisition parameters are untouched,
    so the scrubbed file behaves identically in the pipeline. Removed: patient
    name, identifiers, site name and address, device serial number, and the
    acquisition timestamp (coarsened to 1 January of the same year). The exact
    age is replaced by the midpoint of its 10-year band.

    `patientInfo` cannot simply be deleted - the whole ecgResting tree hangs off
    it - so its identifying children are removed individually.
    """
    ET.register_namespace("", NS["s"])
    tree = ET.parse(src)
    root = tree.getroot()
    removed: list[str] = []

    def _drop(parent, child):
        if parent is not None and child is not None:
            parent.remove(child)
            removed.append(child.tag.split("}")[-1])

    for parent in root.iter():
        for child in list(parent):
            tag = child.tag.split("}")[-1]
            if tag in {"name", "identifier", "siteAddress", "serialID"}:
                _drop(parent, child)

    site = _find(root, ".//s:site")
    if site is not None and "displayName" in site.attrib:
        site.set("displayName", "removed")
        removed.append("site/@displayName")

    age_el = _find(root, ".//s:patientAge")
    if age_el is not None:
        band = deident.age_band(_v(age_el, cast=float))
        if band:
            lo = band.replace("+", "").split("-")[0]
            age_el.set("V", str(int(lo) + 5))
            age_el.set("cardiovisNote", "age coarsened to band %s" % band)
            removed.append("patientAge (coarsened)")

    acq = _find(root, ".//s:acquisitionDateTime")
    if acq is not None:
        year = deident.acquisition_year(_v(acq))
        acq.set("V", "%d-01-01T00:00:00.00" % (year or 1900))
        removed.append("acquisitionDateTime (year only)")

    dst.parent.mkdir(parents=True, exist_ok=True)
    tree.write(dst, encoding="utf-8", xml_declaration=True)
    return {"source": src.name, "output": str(dst), "removed": sorted(set(removed))}


@register
class GeSapphireAdapter(EcgAdapter):
    format_name = "ge-sapphire-dcar"
    extensions = (".xml",)

    @classmethod
    def sniff(cls, path: Path) -> bool:
        if path.suffix.lower() not in cls.extensions:
            return False
        with path.open("r", encoding="utf-8", errors="ignore") as fh:
            head = fh.read(2048)
        return "urn:ge:sapphire" in head

    # ---------------------------------------------------------------- waveform

    def _waveform_block(self, mxg, kind: str) -> WaveformBlock:
        unit = (mxg.get("U") or "uV").lower()
        scale = float(mxg.get("S") or 1.0)
        invalid = mxg.get("INV")
        invalid_val = float(invalid) if invalid not in (None, "") else None
        to_mv = _UNIT_TO_MV.get(unit)
        if to_mv is None:
            raise ValueError("Unsupported waveform unit %r in %s block" % (unit, kind))

        fs = _v(_find(mxg, "s:sampleRate"), cast=float)
        if not fs:
            raise ValueError("Missing sampleRate in %s block" % kind)

        signals: dict[str, np.ndarray] = {}
        n_samples = 0
        for wf in mxg.findall("s:ecgWaveform", NS):
            lead = canonical_lead(wf.get("label") or wf.get("lead") or "")
            raw_text = wf.get("V") or ""
            raw = (np.fromstring(raw_text, dtype=np.float64, sep=" ")
                   if raw_text else np.empty(0))
            declared = wf.get("asizeVT")
            if declared and len(raw) != int(declared):
                raise ValueError(
                    "%s lead %s: %d samples but asizeVT=%s"
                    % (kind, lead, len(raw), declared))
            if invalid_val is not None:
                raw = np.where(raw == invalid_val, np.nan, raw)
            signals[lead] = raw * scale * to_mv
            n_samples = max(n_samples, len(raw))

        lengths = {len(v) for v in signals.values()}
        if len(lengths) > 1:
            raise ValueError("%s block has ragged leads: %s" % (kind, lengths))

        filters: dict[str, Any] = {}
        f_el = _find(mxg, "s:filters")
        if f_el is not None:
            filters = {
                "highPassHz": _v(_find(f_el, "s:highPass/s:frequency"), cast=float),
                "lowPassHz": _v(_find(f_el, "s:lowPass/s:frequency"), cast=float),
                "algorithms": [
                    {"name": _v(_find(a, "s:name")), "purpose": _v(_find(a, "s:purpose"))}
                    for a in f_el.findall("s:algorithm", NS)
                ],
            }

        return WaveformBlock(
            kind=kind,
            sample_rate_hz=float(fs),
            signals=signals,
            n_samples=n_samples,
            scale_uv_per_lsb=scale if unit == "uv" else scale * to_mv * 1000.0,
            device_filters=filters,
        )

    # ------------------------------------------------------------------- parse

    def parse(self, path: Path, *, keep_phi: bool = False) -> Recording:
        root = ET.parse(path).getroot()
        notes: list[str] = []

        ecg = _find(root, ".//s:ecgResting/s:params/s:ecg")
        if ecg is None:
            raise ValueError("No ecgResting/params/ecg block found")

        wav_mxg = _find(ecg, "s:wav/s:ecgWaveformMXG")
        med_mxg = _find(ecg, "s:var/s:medianTemplate/s:ecgWaveformMXG")
        if wav_mxg is None:
            mxgs = root.findall(".//s:ecgWaveformMXG", NS)
            if not mxgs:
                raise ValueError("No ecgWaveformMXG blocks found")
            mxgs = sorted(mxgs, key=lambda m: -max(
                (int(w.get("asizeVT") or 0) for w in m.findall("s:ecgWaveform", NS)),
                default=0))
            wav_mxg = mxgs[0]
            med_mxg = mxgs[1] if len(mxgs) > 1 else None
            notes.append("Rhythm/median blocks identified by length, not by position.")

        rhythm = self._waveform_block(wav_mxg, "rhythm")
        median = self._waveform_block(med_mxg, "median") if med_mxg is not None else None
        if median is None:
            notes.append("No median/representative beat block in this file.")

        # ------------------------------------------------------- PHI handling
        info = _find(root, ".//s:patientInfo")
        dev_el = _find(root, ".//s:device")
        test_el = _find(root, ".//s:testInfo")
        site_el = _find(root, ".//s:site")

        raw_identifiers = {
            "name": " ".join(
                (_v(g) or "")
                for g in (info.findall(".//s:name/s:given", NS) if info is not None else [])
            ).strip(),
            "mrn": _v(_find(root, ".//s:identifier/s:id")),
            "site": site_el.get("displayName") if site_el is not None else None,
            "serial": _v(_find(root, ".//s:serialID")),
            "acquired": _v(_find(root, ".//s:acquisitionDateTime")),
        }

        # A file that has already been scrubbed has no identifiers left to hash,
        # and hashing the filename alone would give the same recording a new ID
        # every time it is renamed. Fall back to the waveform itself, which is
        # stable, high-entropy, and does not identify anyone on its own.
        if raw_identifiers["mrn"] or raw_identifiers["serial"]:
            id_parts = (raw_identifiers["mrn"], raw_identifiers["serial"],
                        raw_identifiers["acquired"], path.name)
        else:
            content = np.ascontiguousarray(
                rhythm.matrix(sorted(rhythm.signals)), dtype=np.float32).tobytes()
            id_parts = ("content", hashlib.sha256(content).hexdigest())

        subject = Subject(
            pseudo_id=deident.pseudonymise(*id_parts),
            age_band=deident.age_band(_v(_find(root, ".//s:patientAge"), cast=float)),
            sex=deident.normalise_sex(_v(_find(root, ".//s:gender"))),
            acquisition_year=deident.acquisition_year(raw_identifiers["acquired"]),
        )
        if keep_phi:
            deident.warn_phi_retained("source=%s" % path.name)
            subject.phi_retained = True
            subject.phi = {k: v for k, v in raw_identifiers.items() if v}

        device = {
            "vendor": _v(_find(dev_el, "s:vendorID")) if dev_el is not None else None,
            "model": _v(_find(dev_el, "s:modelID")) if dev_el is not None else None,
            "deviceName": _v(_find(dev_el, "s:deviceName")) if dev_el is not None else None,
            "software": {
                (_v(sw, "name") or "unnamed"): _v(sw)
                for sw in (dev_el.findall("s:softwareVersion", NS)
                           if dev_el is not None else [])
            },
            "hasPacemakerFlag": (_v(_find(test_el, "s:hasPacemaker"))
                                 if test_el is not None else None),
            "hookupQuality": _v(_find(root, ".//s:hookupAdvisor/s:ackLevel")),
            "signalQuality": _v(_find(root, ".//s:num/s:signalQuality")),
        }

        # ------------------------------------------------ device measurements
        dm = DeviceMeasurements()

        def _collect(container, into: dict):
            if container is None:
                return
            for child in container:
                tag = child.tag.split("}")[-1]
                val = _v(child, cast=float)
                inv = _v(child, "INV", cast=float)
                if val is not None and (inv is None or val != inv):
                    into[tag] = val
                elif child.get("V"):
                    into[tag] = child.get("V")
                if tag == "QT_Corrected" and child.get("correction"):
                    into["QTc_correction"] = child.get("correction")

        _collect(_find(ecg, "s:num"), dm.global_ms)
        _collect(_find(ecg, "s:var/s:medianTemplate/s:measurements/s:global"), dm.global_ms)

        for pl in ecg.findall("s:var/s:medianTemplate/s:measurements/s:perLead", NS):
            lead = canonical_lead(pl.get("displayName") or pl.get("lead") or "")
            vals: dict[str, float] = {}
            _collect(pl, vals)
            dm.per_lead_uv[lead] = vals

        dm.beat_samples = [
            int(t) for t in (
                _v(_find(b, "s:tpoint/s:toc"), cast=float)
                for b in ecg.findall("s:evt/s:beat/s:any", NS)
            ) if t is not None
        ]
        dm.pace_samples = [
            int(t) for t in (
                _v(_find(p, "s:tpoint/s:toc"), cast=float)
                for p in ecg.findall("s:evt/s:wavp/s:pace", NS)
            ) if t is not None
        ]

        statements = [_v(s) for s in ecg.findall("s:interpretation/s:statement", NS)
                      if _v(s)]

        return Recording(
            source_format=self.format_name,
            source_file=path.name,
            device=device,
            subject=subject,
            rhythm=rhythm,
            median=median,
            device_measurements=dm,
            device_interpretation=statements,
            notes=notes,
        )
