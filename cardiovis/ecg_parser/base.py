"""Format-agnostic recording model and adapter registry.

Downstream modules (filters, delineate, vcg, metrics, conduction, frames) may
only ever see a `Recording`. Adding SCP-ECG / DICOM-ECG / HL7 aECG / Philips XML
/ WFDB means adding an adapter here and nothing else.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

import numpy as np

#: Canonical order used everywhere downstream.
LEAD_ORDER = ["I", "II", "III", "aVR", "aVL", "aVF", "V1", "V2", "V3", "V4", "V5", "V6"]

#: The 8 linearly independent leads. Everything else is a combination of these.
INDEPENDENT_LEADS = ["I", "II", "V1", "V2", "V3", "V4", "V5", "V6"]

_ALIASES = {
    "AVR": "aVR", "AVL": "aVL", "AVF": "aVF",
    "avr": "aVR", "avl": "aVL", "avf": "aVF",
    "L1": "I", "L2": "II", "L3": "III",
}


def canonical_lead(name: str) -> str:
    name = (name or "").strip()
    return _ALIASES.get(name, name.upper() if name.upper() in {"I", "II", "III"} else _ALIASES.get(name.upper(), name))


@dataclass
class WaveformBlock:
    """One contiguous block of simultaneous lead signals.

    `kind` is "rhythm" (the continuous strip) or "median" (the representative /
    median beat the device computed). They are never mixed downstream.
    """

    kind: str
    sample_rate_hz: float
    signals: dict[str, np.ndarray]          # lead -> mV, float64, NaN where invalid
    n_samples: int
    scale_uv_per_lsb: float | None = None
    device_filters: dict[str, Any] = field(default_factory=dict)

    @property
    def duration_s(self) -> float:
        return self.n_samples / self.sample_rate_hz

    def matrix(self, leads: Iterable[str] = LEAD_ORDER) -> np.ndarray:
        """(n_leads, n_samples) matrix in the given lead order."""
        return np.vstack([self.signals[l] for l in leads])

    def time_ms(self) -> np.ndarray:
        return np.arange(self.n_samples) / self.sample_rate_hz * 1000.0


@dataclass
class Subject:
    """What survives de-identification. See PRIVACY.md."""

    pseudo_id: str
    age_band: str | None = None
    sex: str | None = None
    acquisition_year: int | None = None
    phi_retained: bool = False
    phi: dict[str, Any] = field(default_factory=dict)  # only ever populated with --keep-phi


@dataclass
class DeviceMeasurements:
    """Numbers the acquisition device itself reported. Tier 1 (measured), but by
    the device's algorithm, not ours — always labelled as such so our own
    delineation can be compared against them rather than silently replaced."""

    global_ms: dict[str, float] = field(default_factory=dict)
    per_lead_uv: dict[str, dict[str, float]] = field(default_factory=dict)
    beat_samples: list[int] = field(default_factory=list)   # device R-peak / beat marks
    pace_samples: list[int] = field(default_factory=list)


@dataclass
class Recording:
    source_format: str
    source_file: str
    device: dict[str, Any]
    subject: Subject
    rhythm: WaveformBlock
    median: WaveformBlock | None = None
    device_measurements: DeviceMeasurements = field(default_factory=DeviceMeasurements)
    #: The device's own interpretive statements ("Normal sinus rhythm", ...).
    #: Parsed so they are not silently lost, NEVER exported to frames.json and
    #: NEVER rendered: CardioVis does not emit diagnostic statements (§1.1).
    device_interpretation: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    @property
    def record_id(self) -> str:
        return self.subject.pseudo_id


class EcgAdapter(abc.ABC):
    """Base class for format adapters."""

    format_name: str = "abstract"
    extensions: tuple[str, ...] = ()

    @classmethod
    @abc.abstractmethod
    def sniff(cls, path: Path) -> bool:
        """Cheap content check — is this file ours?"""

    @abc.abstractmethod
    def parse(self, path: Path, *, keep_phi: bool = False) -> Recording:
        """Parse to a Recording. MUST de-identify before returning unless
        keep_phi is explicitly set (see deident.py)."""


_REGISTRY: list[type[EcgAdapter]] = []


def register(adapter_cls: type[EcgAdapter]) -> type[EcgAdapter]:
    _REGISTRY.append(adapter_cls)
    return adapter_cls


def adapters() -> list[type[EcgAdapter]]:
    return list(_REGISTRY)


def load(path: str | Path, *, keep_phi: bool = False) -> Recording:
    """Parse any supported ECG file. De-identification happens inside."""
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(path)
    for cls in _REGISTRY:
        try:
            matched = cls.sniff(path)
        except Exception:  # noqa: BLE001 - one adapter's bad sniff must not hide the rest
            continue
        if matched:
            # Deliberately outside the try: once an adapter claims the file, its
            # parse errors belong to the caller. Swallowing them here turned a
            # refusal to retain PHI into a misleading "unrecognised format".
            return cls().parse(path, keep_phi=keep_phi)
    raise ValueError(
        f"No adapter recognised {path.name}. Registered: "
        + ", ".join(c.format_name for c in _REGISTRY)
    )
