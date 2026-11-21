"""Filtering (Tier 1 stays Tier 1 - filtering does not create information).

Design rules that matter clinically:

* Zero-phase only (``filtfilt``). A causal filter shifts fiducial points in
  time, and every downstream interval measurement would inherit that shift.
* The high-pass corner is 0.5 Hz by default and is deliberately gentle. An
  aggressive high-pass flattens genuine ST deviation, which is exactly the
  finding a student is trying to see. The unfiltered signal is always kept
  alongside the filtered one so the UI can toggle between them.
* Mains frequency is a configuration parameter, not a constant: 50 Hz in
  India/EU, 60 Hz in the US.
* Invalid samples (the INV sentinel in the source file) are NaN by the time
  they reach here. We never filter across them blindly: they are interpolated
  for the filter pass and then restored as NaN, so a dropout cannot smear
  ringing into good data unnoticed.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy import signal as sig

from .ecg_parser.base import WaveformBlock


@dataclass
class FilterConfig:
    highpass_hz: float = 0.5
    lowpass_hz: float = 40.0
    order: int = 3
    notch_hz: float | None = 50.0   # 50 = India/EU, 60 = US, None = off
    notch_q: float = 30.0
    enabled: bool = True

    def describe(self) -> str:
        if not self.enabled:
            return "no filtering"
        parts = [
            "Butterworth order %d bandpass %.2f-%.1f Hz, zero-phase (filtfilt)"
            % (self.order, self.highpass_hz, self.lowpass_hz)
        ]
        if self.notch_hz:
            parts.append("%.0f Hz notch (Q=%.0f)" % (self.notch_hz, self.notch_q))
        return "; ".join(parts)

    def to_json(self) -> dict:
        return {
            "highpassHz": self.highpass_hz,
            "lowpassHz": self.lowpass_hz,
            "order": self.order,
            "notchHz": self.notch_hz,
            "notchQ": self.notch_q,
            "enabled": self.enabled,
            "description": self.describe(),
        }


@dataclass
class FilteredBlock:
    """Filtered signals plus the raw ones they came from."""

    raw: WaveformBlock
    filtered: WaveformBlock
    config: FilterConfig
    invalid_fraction: dict[str, float] = field(default_factory=dict)

    @property
    def sample_rate_hz(self) -> float:
        return self.raw.sample_rate_hz


def _interpolate_nans(x: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Return (gap-filled copy, mask of originally-invalid samples)."""
    bad = ~np.isfinite(x)
    if not bad.any():
        return x.astype(float, copy=True), bad
    out = x.astype(float, copy=True)
    good = ~bad
    if good.sum() < 2:
        out[bad] = 0.0
        return out, bad
    idx = np.arange(len(x))
    out[bad] = np.interp(idx[bad], idx[good], x[good])
    return out, bad


def detect_powerline_hz(x: np.ndarray, fs: float) -> float | None:
    """Best guess at mains frequency from the spectrum. Advisory only - the
    filter still uses whatever the config says, so the user stays in control."""
    x = x[np.isfinite(x)]
    if len(x) < int(fs * 2):
        return None
    freqs, pxx = sig.welch(x - x.mean(), fs=fs, nperseg=min(len(x), int(fs * 2)))
    p50 = pxx[(freqs > 48) & (freqs < 52)].max(initial=0.0)
    p60 = pxx[(freqs > 58) & (freqs < 62)].max(initial=0.0)
    base = np.median(pxx[(freqs > 20) & (freqs < 40)]) or 1e-12
    if max(p50, p60) < 3 * base:
        return None
    return 50.0 if p50 >= p60 else 60.0


def apply_filters(block: WaveformBlock, config: FilterConfig | None = None) -> FilteredBlock:
    """Filter every lead of a block. Never modifies the input."""
    config = config or FilterConfig()
    fs = block.sample_rate_hz
    nyq = fs / 2.0

    out: dict[str, np.ndarray] = {}
    invalid_fraction: dict[str, float] = {}

    sos = None
    notch_ba = None
    if config.enabled:
        low = max(config.highpass_hz / nyq, 1e-6)
        high = min(config.lowpass_hz / nyq, 0.99)
        if low >= high:
            raise ValueError("Invalid band: %s-%s Hz at fs=%s"
                             % (config.highpass_hz, config.lowpass_hz, fs))
        sos = sig.butter(config.order, [low, high], btype="bandpass", output="sos")
        if config.notch_hz and config.notch_hz < nyq:
            notch_ba = sig.iirnotch(config.notch_hz / nyq, config.notch_q)

    for lead, x in block.signals.items():
        filled, bad = _interpolate_nans(x)
        invalid_fraction[lead] = float(bad.mean()) if len(x) else 1.0
        y = filled
        if config.enabled and len(filled) > 3 * (config.order * 3 + 1):
            y = sig.sosfiltfilt(sos, y)
            if notch_ba is not None:
                y = sig.filtfilt(notch_ba[0], notch_ba[1], y)
        elif config.enabled:
            # Too short for zero-phase filtering: leave it alone rather than
            # returning a plausible-looking but wrong signal.
            y = filled - np.median(filled)
        y = np.asarray(y, dtype=float)
        y[bad] = np.nan
        out[lead] = y

    filtered = WaveformBlock(
        kind=block.kind + "-filtered",
        sample_rate_hz=fs,
        signals=out,
        n_samples=block.n_samples,
        scale_uv_per_lsb=block.scale_uv_per_lsb,
        device_filters=block.device_filters,
    )
    return FilteredBlock(raw=block, filtered=filtered, config=config,
                         invalid_fraction=invalid_fraction)
