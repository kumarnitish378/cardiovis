"""Synthetic 12-lead ECG generation.

Why this exists:

1. **Ground truth.** Every other module infers the dipole from leads. Here we
   choose the dipole d(t) first and *project* it onto the published forward
   Dower lead vectors to make the 12 leads. The VCG reconstruction can then be
   checked against a d(t) we actually know - impossible with a real recording.
2. **A teaching library we are allowed to ship.** Open ECG datasets (PTB-XL,
   LUDB, PhysioNet) each carry their own licence and their own consent
   framework. Synthetic cases carry neither, and can be shaped to show exactly
   one teaching point at a time.
3. **Adversarial inputs.** Flat leads, dropouts, mains hum, baseline wander,
   irregular rhythm and pacing spikes on demand, so the failure paths are
   tested rather than hoped about.

Everything generated here is labelled synthetic in the export and in the UI. It
is a cartoon with correct arithmetic: the waveform shapes come from summed
Gaussian vector components, not from a biophysical model of myocardium. It must
never be presented as a recording of a person.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .deident import pseudonymise
from .ecg_parser.base import DeviceMeasurements, Recording, Subject, WaveformBlock
from .leads import derive_from_i_ii
from .vcg import FORWARD_DOWER, TRANSFORM_LEADS


@dataclass
class Component:
    """One Gaussian vector contribution to the dipole.

    `t_ms` is relative to QRS onset; `direction` is in the anatomical frame
    (+x left, +y inferior, +z posterior) and need not be normalised.
    """

    t_ms: float
    width_ms: float
    amplitude_mv: float
    direction: tuple[float, float, float]
    label: str = ""


@dataclass
class SynthConfig:
    name: str = "normal"
    title: str = "Normal sinus rhythm"
    description: str = ""
    teaching_point: str = ""
    heart_rate_bpm: float = 72.0
    duration_s: float = 10.0
    sample_rate_hz: float = 500.0
    pr_ms: float = 160.0
    qt_ms: float = 380.0
    rr_jitter_frac: float = 0.02      # 0.25+ looks like atrial fibrillation
    p_amplitude_mv: float = 0.12
    p_direction: tuple = (0.45, 0.80, 0.25)
    components: list[Component] = field(default_factory=list)
    t_amplitude_mv: float = 0.30
    t_direction: tuple = (0.55, 0.55, -0.60)
    t_width_ms: float = 60.0
    st_shift_mv: float = 0.0          # injury current magnitude
    st_direction: tuple = (0.0, 1.0, 0.0)
    fibrillatory_mv: float = 0.0      # coarse f-waves instead of P waves
    pacing_spike_mv: float = 0.0
    noise_mv: float = 0.012
    baseline_wander_mv: float = 0.03
    mains_hz: float | None = None
    mains_mv: float = 0.0
    flat_leads: tuple = ()
    dropout_spans: tuple = ()         # ((lead, start_s, end_s), ...)
    seed: int = 20260917


def normal_qrs(scale: float = 1.0, axis: tuple = (0.75, 0.45, 0.45)) -> list[Component]:
    """Septal, main and terminal components of a normal ventricular activation."""
    a = np.array(axis, dtype=float)
    a = a / (np.linalg.norm(a) or 1.0)
    return [
        Component(12.0, 9.0, 0.22 * scale, (-0.70, -0.20, -0.65), "septal (L to R)"),
        Component(30.0, 11.0, 0.35 * scale, (-0.40, 0.30, -0.85), "RV free wall"),
        Component(42.0, 14.0, 1.45 * scale, tuple(a), "LV free wall"),
        Component(64.0, 12.0, 0.30 * scale, (0.40, -0.50, 0.75), "basal / posterior LV"),
    ]


def _gauss(t: np.ndarray, centre: float, width: float) -> np.ndarray:
    return np.exp(-0.5 * ((t - centre) / max(width, 1e-6)) ** 2)


def _beat_dipole(t_ms: np.ndarray, cfg: SynthConfig, rng) -> np.ndarray:
    """Dipole of one beat, with t_ms measured from QRS onset."""
    d = np.zeros((3, len(t_ms)))

    if cfg.p_amplitude_mv > 0:
        u = np.array(cfg.p_direction, float)
        u /= np.linalg.norm(u) or 1.0
        d += np.outer(u * cfg.p_amplitude_mv, _gauss(t_ms, -cfg.pr_ms + 45.0, 22.0))

    for c in cfg.components:
        u = np.array(c.direction, float)
        u /= np.linalg.norm(u) or 1.0
        d += np.outer(u * c.amplitude_mv, _gauss(t_ms, c.t_ms, c.width_ms))

    qrs_end = max((c.t_ms + 2 * c.width_ms) for c in cfg.components) if cfg.components else 90.0
    t_centre = cfg.qt_ms * 0.72
    if cfg.t_amplitude_mv:
        u = np.array(cfg.t_direction, float)
        u /= np.linalg.norm(u) or 1.0
        d += np.outer(u * cfg.t_amplitude_mv, _gauss(t_ms, t_centre, cfg.t_width_ms))

    if cfg.st_shift_mv:
        # Injury current: a plateau over the ST segment, in a fixed direction.
        u = np.array(cfg.st_direction, float)
        u /= np.linalg.norm(u) or 1.0
        plateau = 1.0 / (1.0 + np.exp(-(t_ms - qrs_end) / 6.0))
        plateau *= 1.0 / (1.0 + np.exp((t_ms - cfg.qt_ms * 0.85) / 25.0))
        d += np.outer(u * cfg.st_shift_mv, plateau)

    _ = rng
    return d


def generate(cfg: SynthConfig) -> tuple[Recording, np.ndarray]:
    """Return (Recording, true dipole d(t)) - the second value is the ground
    truth no real recording can give you."""
    rng = np.random.default_rng(cfg.seed)
    fs = cfg.sample_rate_hz
    n = int(round(cfg.duration_s * fs))
    t_s = np.arange(n) / fs
    d = np.zeros((3, n))

    rr_s = 60.0 / cfg.heart_rate_bpm
    beat_starts, beat_marks = [], []
    cursor = 0.30
    while cursor < cfg.duration_s:
        beat_starts.append(cursor)
        jitter = rng.normal(0.0, cfg.rr_jitter_frac * rr_s) if cfg.rr_jitter_frac else 0.0
        cursor += max(0.25, rr_s + jitter)

    for start in beat_starts:
        qrs_on = int(round(start * fs))
        lo = max(0, qrs_on - int(0.4 * fs))
        hi = min(n, qrs_on + int(0.7 * fs))
        if hi <= lo:
            continue
        rel_ms = (np.arange(lo, hi) - qrs_on) / fs * 1000.0
        d[:, lo:hi] += _beat_dipole(rel_ms, cfg, rng)
        beat_marks.append(qrs_on + int(0.04 * fs))

    if cfg.fibrillatory_mv:
        # Coarse fibrillatory activity: no organised P wave, continuous
        # low-amplitude atrial noise around 6-9 Hz.
        for freq in (6.0, 7.3, 8.8):
            phase = rng.uniform(0, 2 * np.pi)
            wave = np.sin(2 * np.pi * freq * t_s + phase)
            u = np.array(cfg.p_direction, float)
            u /= np.linalg.norm(u) or 1.0
            d += np.outer(u * cfg.fibrillatory_mv / 3.0, wave)

    # Only the 8 independent leads are "measured"; the other four are computed
    # from I and II. So noise, wander, hum and pacing spikes are added to the
    # independent leads and the dependent ones are derived afterwards - exactly
    # as a real machine does it, and the reason a real file satisfies
    # II = I + III to within a quantisation step.
    leads: dict[str, np.ndarray] = {}
    projected = FORWARD_DOWER @ d                      # (8, n)
    for i, lead in enumerate(TRANSFORM_LEADS):
        leads[lead] = projected[i].copy()

    pace_samples: list[int] = []
    if cfg.pacing_spike_mv:
        for m in beat_marks:
            s = m - int(0.045 * fs)
            pace_samples.append(s)
            for lead in TRANSFORM_LEADS:
                if 0 <= s < n - 2:
                    leads[lead][s:s + 2] += cfg.pacing_spike_mv * (
                        1.0 if lead in ("V1", "V2", "II") else 0.5)

    for lead in TRANSFORM_LEADS:
        x = leads[lead]
        if cfg.noise_mv:
            x += rng.normal(0.0, cfg.noise_mv, n)
        if cfg.baseline_wander_mv:
            f1, f2 = rng.uniform(0.15, 0.35), rng.uniform(0.05, 0.12)
            x += cfg.baseline_wander_mv * (np.sin(2 * np.pi * f1 * t_s + rng.uniform(0, 6))
                                           + 0.6 * np.sin(2 * np.pi * f2 * t_s))
        if cfg.mains_hz and cfg.mains_mv:
            x += cfg.mains_mv * np.sin(2 * np.pi * cfg.mains_hz * t_s)

    for lead in cfg.flat_leads:
        leads[lead] = rng.normal(0.0, 0.002, n)

    leads.update(derive_from_i_ii(leads["I"], leads["II"]))
    for lead, t0, t1 in cfg.dropout_spans:
        lo, hi = int(t0 * fs), int(t1 * fs)
        leads[lead][lo:hi] = np.nan

    order = ["I", "II", "III", "aVR", "aVL", "aVF", "V1", "V2", "V3", "V4", "V5", "V6"]
    block = WaveformBlock(kind="rhythm", sample_rate_hz=fs,
                          signals={l: leads[l] for l in order}, n_samples=n)

    dm = DeviceMeasurements()
    dm.beat_samples = beat_marks
    dm.pace_samples = pace_samples

    recording = Recording(
        source_format="cardiovis-synthetic",
        source_file="synthetic:%s" % cfg.name,
        device={"vendor": "CardioVis", "model": "synthetic generator",
                "deviceName": "synthetic", "software": {"cardiovis": "synth"},
                "hasPacemakerFlag": "true" if cfg.pacing_spike_mv else "false",
                "hookupQuality": "SYNTHETIC", "signalQuality": "SYNTHETIC"},
        subject=Subject(pseudo_id="syn_%s" % cfg.name,
                        age_band=None, sex=None, acquisition_year=None),
        rhythm=block,
        median=None,
        device_measurements=dm,
        notes=["SYNTHETIC RECORDING - generated by CardioVis, not a person. "
               "Waveforms are summed Gaussian vector components projected onto the "
               "Dower forward lead vectors."],
    )
    _ = pseudonymise  # kept imported: real files get hashed IDs, synthetic ones do not
    return recording, d


# --------------------------------------------------------------------------- #
# The teaching library
# --------------------------------------------------------------------------- #

def library() -> list[SynthConfig]:
    """Curated cases, each built to show one thing (spec 9)."""
    cases: list[SynthConfig] = []

    cases.append(SynthConfig(
        name="normal_sinus", title="Normal sinus rhythm",
        description="A textbook normal 12-lead at 72 bpm.",
        teaching_point=(
            "Watch the vector sweep left, down and posteriorly. That single rotation "
            "is what every one of the 12 traces is a shadow of: aVR sees it going away "
            "(inverted), II sees it coming toward (tall and upright)."),
        components=normal_qrs()))

    cases.append(SynthConfig(
        name="left_axis_deviation", title="Left axis deviation",
        description="Mean frontal QRS axis about -45 degrees.",
        teaching_point=(
            "The QRS loop has rotated superiorly. Lead II now records a net negative "
            "deflection because the vector points away from its axis, while aVL "
            "becomes dominantly positive."),
        components=normal_qrs(axis=(0.80, -0.55, 0.25))))

    cases.append(SynthConfig(
        name="right_axis_deviation", title="Right axis deviation",
        description="Mean frontal QRS axis about +120 degrees.",
        teaching_point=(
            "The vector now points down and to the patient's right. Lead I goes "
            "negative - the classic first clue - while III becomes tall."),
        components=normal_qrs(axis=(-0.45, 0.85, 0.25))))

    lbbb = normal_qrs(scale=1.15, axis=(0.80, 0.35, 0.50))
    lbbb[0] = Component(20.0, 14.0, 0.25, (0.55, 0.20, 0.55), "septum (reversed: R to L)")
    lbbb[1] = Component(38.0, 16.0, 0.30, (-0.30, 0.35, -0.75), "RV (early, small)")
    lbbb[2] = Component(85.0, 30.0, 1.60, (0.80, 0.35, 0.50), "LV (late, slurred)")
    lbbb[3] = Component(125.0, 24.0, 0.60, (0.60, 0.10, 0.70), "basal LV (very late)")
    cases.append(SynthConfig(
        name="lbbb", title="Left bundle branch block",
        description="QRS about 150 ms, late and slurred leftward forces.",
        teaching_point=(
            "The left bundle is blocked, so the LV is activated late and slowly, "
            "through muscle instead of Purkinje fibres. Septal activation reverses. "
            "Click V1: the vector spends the whole QRS pointing away from it, which is "
            "why V1 shows a broad deep QS. The Tier-3 sweep stretches but keeps the "
            "normal route - that is exactly where the model stops being true."),
        qt_ms=430.0, t_amplitude_mv=0.35, t_direction=(-0.55, -0.35, 0.75),
        components=lbbb))

    rbbb = normal_qrs(axis=(0.72, 0.45, 0.42))
    rbbb.append(Component(115.0, 22.0, 0.55, (-0.55, 0.10, -0.80), "late RV (blocked)"))
    cases.append(SynthConfig(
        name="rbbb", title="Right bundle branch block",
        description="QRS about 140 ms with terminal rightward, anterior forces.",
        teaching_point=(
            "Normal early activation, then a late rightward and anterior vector as the "
            "RV finally depolarises through muscle. That terminal vector points "
            "straight at V1, giving the second R wave (rSR'), and away from I and V6, "
            "giving their broad slurred S waves."),
        qt_ms=400.0, components=rbbb))

    cases.append(SynthConfig(
        name="lvh", title="Left ventricular hypertrophy (voltage criteria)",
        description="Large-amplitude leftward and posterior QRS forces.",
        teaching_point=(
            "More left ventricular muscle means a larger vector in the same direction, "
            "not a different sequence. The loop keeps its shape and grows - which is "
            "why the voltage criteria are sums of amplitudes in leads that face it."),
        t_amplitude_mv=0.35, t_direction=(-0.50, -0.30, 0.80),
        components=normal_qrs(scale=1.9, axis=(0.80, 0.30, 0.50))))

    cases.append(SynthConfig(
        name="inferior_stemi", title="Inferior ST elevation",
        description="Injury current directed inferiorly.",
        teaching_point=(
            "The ST segment is not a wave, it is a standing offset: a fixed vector "
            "pointing at the injured region. Here it points inferiorly, so II, III and "
            "aVF - which face that way - record elevation, while aVL, facing the "
            "opposite way, records the reciprocal depression. Same vector, two signs."),
        st_shift_mv=0.28, st_direction=(0.15, 1.0, 0.15),
        components=normal_qrs()))

    cases.append(SynthConfig(
        name="anterior_stemi", title="Anterior ST elevation",
        description="Injury current directed anteriorly.",
        teaching_point=(
            "The same standing ST vector, now pointing anteriorly at the precordial "
            "leads. V2-V4 face it and record elevation; the limb leads, which lie in "
            "the frontal plane, barely see it at all."),
        st_shift_mv=0.30, st_direction=(0.15, 0.10, -1.0),
        components=normal_qrs()))

    wpw = normal_qrs()
    wpw.insert(0, Component(-28.0, 20.0, 0.38, (0.55, 0.55, 0.45), "accessory pathway (delta)"))
    cases.append(SynthConfig(
        name="wpw", title="Pre-excitation (WPW pattern)",
        description="Short PR with a delta wave running into the QRS.",
        teaching_point=(
            "An accessory pathway lets ventricular muscle start depolarising before the "
            "AV node has finished delaying. The PR shortens and the QRS begins with a "
            "slow, muscle-to-muscle upstroke: the delta wave. The Tier-3 model assumes "
            "the AV node is the only route, so its timing is wrong here by construction."),
        pr_ms=110.0, components=wpw))

    cases.append(SynthConfig(
        name="atrial_fibrillation", title="Atrial fibrillation",
        description="No P waves, irregularly irregular RR - and the model breaks.",
        teaching_point=(
            "This case is in the library to show a limit, not a lesson in anatomy. "
            "There is no organised atrial activation to animate and no stable beat "
            "timing to key the model to, so CardioVis refuses to claim the conduction "
            "animation applies. The Tier-2 vector loop is still perfectly valid: it "
            "needs no assumption about rhythm at all."),
        heart_rate_bpm=88.0, rr_jitter_frac=0.28, p_amplitude_mv=0.0,
        fibrillatory_mv=0.05, components=normal_qrs()))

    paced = [
        Component(30.0, 20.0, 0.55, (0.35, -0.30, 0.85), "RV apex pacing spread"),
        Component(75.0, 26.0, 1.30, (0.70, -0.20, 0.60), "LV activated through muscle"),
        Component(120.0, 22.0, 0.45, (0.50, -0.45, 0.70), "late basal LV"),
    ]
    cases.append(SynthConfig(
        name="ventricular_paced", title="Ventricular paced rhythm",
        description="Pacing spikes with a wide, LBBB-like QRS.",
        teaching_point=(
            "Activation starts at the pacing lead tip, not at the His bundle, and "
            "spreads through muscle. The conduction model has no way to represent that "
            "and says so. The pacing spikes also trip the signal-quality warning."),
        heart_rate_bpm=70.0, p_amplitude_mv=0.0, pacing_spike_mv=1.2,
        qt_ms=440.0, t_amplitude_mv=0.40, t_direction=(-0.55, 0.30, -0.70),
        components=paced))

    return cases
