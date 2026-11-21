# Methods

Every transform, filter and formula in CardioVis, with its source and its known
error. If a number appears in the app, it should be traceable to a line in this
document.

---

## 1. Parsing

### GE Sapphire / DCAR XML (`urn:ge:sapphire:dcar_1`)

Two waveform blocks are parsed and kept distinct:

| Block | Location | Typical size |
|---|---|---|
| rhythm strip | `ecg/wav/ecgWaveformMXG` | 5000 samples = 10 s @ 500 Hz per lead |
| median beat | `ecg/var/medianTemplate/ecgWaveformMXG` | 600 samples |

Amplitude conversion, from the block's own attributes:

    mV = raw × S / 1000        (when U = "uV", e.g. S = 4.88)

Samples equal to the `INV` sentinel (e.g. `-32768`) become `NaN` and are masked
from filtering rather than filtered across.

Also parsed: the device's global and per-lead measurements, its beat marks
(`evt/beat/.../toc`, in rhythm-strip samples), its pacemaker-spike marks, and its
interpretive statements — the last of which are **never exported and never
displayed** (see `LIMITATIONS.md` §"Things CardioVis will never do").

Adapters register themselves through `cardiovis/ecg_parser/base.py`, so SCP-ECG,
DICOM-ECG, HL7 aECG, Philips XML and WFDB can be added without touching anything
downstream.

### Lead algebra validation

Files claim to contain all twelve leads. That claim is not trusted. The four
dependent leads are recomputed from I and II:

    III = II − I        aVR = −(I + II)/2
    aVL = (I − III)/2   aVF = (II + III)/2

and compared against what the file stored. Disagreement beyond 0.05 mV (well
above the ~0.005 mV quantisation step at S = 4.88 µV/LSB) replaces the stored lead
and raises `LEADS_RECOMPUTED`. On the bundled real recording the stored leads
agree to within 0.010 mV, i.e. one to two LSB.

---

## 2. Filtering

- **Bandpass**: Butterworth, order 3, 0.5–40 Hz, zero-phase (`scipy.signal.sosfiltfilt`).
  Zero-phase matters: a causal filter shifts fiducials in time and every interval
  measured downstream inherits the shift.
- **Notch**: 50 Hz (India/EU) or 60 Hz (US), `iirnotch`, Q = 30. **Configuration,
  not a constant** — `--notch 60` or `--notch 0` to disable.
- The **unfiltered signal is kept and exported alongside** the filtered one, and
  the UI toggles between them. Over-filtering erases clinically real features: an
  aggressive high-pass flattens genuine ST deviation, which is exactly the finding
  a student is trying to see.
- Invalid samples are interpolated for the filter pass and restored as `NaN`
  afterwards, so a dropout cannot smear filter ringing into good data unnoticed.
- `detect_powerline_hz` estimates mains frequency from the spectrum. It is
  **advisory only** and never overrides the configured value.

---

## 3. Fiducial detection

### QRS detection — Pan & Tompkins (1985)

Bandpass 5–15 Hz → 5-point derivative → squaring → 150 ms moving-window
integration → dual adaptive thresholds (`SPKI`/`NPKI`, 12.5 % update) → 200 ms
refractory → search-back at 1.66 × mean RR → T-wave discrimination by slope
comparison inside 360 ms.

> Pan J, Tompkins WJ. A real-time QRS detection algorithm. *IEEE Trans Biomed
> Eng.* 1985;32(3):230–236.

Run on the **root-mean-square across the 8 independent leads**, not on lead II
alone, so one detached electrode does not take detection down with it. Detections
are then refined to the local RMS maximum within ±75 ms.

### Wave boundaries — multiscale derivative

Martínez et al. (2004) delineate with a quadratic-spline wavelet whose transform
is a smoothed derivative of the signal. CardioVis uses a **Gaussian-derivative
filter bank**: the same idea with a symmetric — therefore exactly zero-phase —
kernel. Scales: 16 ms for QRS, 32 ms for P, 64 ms for T. Boundaries are found on
the cross-lead RMS of that derivative envelope.

> Martínez JP, Almeida R, Olmos S, Rocha AP, Laguna P. A wavelet-based ECG
> delineator: evaluation on standard databases. *IEEE Trans Biomed Eng.*
> 2004;51(4):570–581.

**This is not a literal reimplementation of the published filter bank**, and it
has not been benchmarked against expert annotations. Do not quote its intervals
as though it had been.

Three implementation details that are not incidental:

1. **Modulus-maximum pairs, not the single maximum.** A monophasic wave produces
   *two* derivative maxima — upslope and downslope — with a minimum between them
   at the apex. Taking the largest maximum as the wave peak puts the peak on a
   flank and shortens every interval measured from it: doing that put PR at 78 ms
   against the device's 138 ms on the bundled recording. Pairing the maxima and
   placing the apex at the minimum between them gives 140 ms.
2. **P and T searches use a windowed envelope.** Smoothed at 32–64 ms, the QRS
   upstroke still carries derivative energy 40–60 ms outside its own boundaries,
   and a P-wave search that can see it locks onto that skirt every time. The
   envelope for each wave is therefore computed over its own window in isolation,
   with edge extension, so the leak is impossible rather than merely unlikely.
3. **The noise floor is a low percentile, not the median.** Much of the envelope
   is QRS and T energy; the median is not a floor. Using it suppressed every P
   wave in a recording that plainly had them.

### QRS boundary threshold

`QRS_BOUNDARY_FRACTION = 0.12` of the peak QRS derivative envelope. This is a real
trade-off, and it moves the measurement. On the bundled real recording:

| Threshold | QRS duration | Frontal axis (net-area method) |
|---|---|---|
| 0.08 | 98 ms | −16° |
| **0.12** | **94 ms** | **−14°** |
| 0.16 | 88 ms | −13° |
| 0.25 | 78 ms | −10° |
| *device algorithm* | *86 ms* | *19°* |

A high threshold truncates the low-amplitude onset of a wide, slurred QRS —
exactly the beats that matter most — so CardioVis sits deliberately on the
generous side and publishes the number rather than tuning until it matches one
vendor.

### Pacing spikes

Detected on the **unfiltered** signal: a 1–2 ms spike sits almost entirely above a
40 Hz corner, so after filtering it is indistinguishable from a steep QRS. On the
synthetic paced case the largest raw step is 1.27 mV/sample against a 0.06 mV
99.5th percentile; after filtering both collapse to ≈ 0.09 mV. A spike is a step
above `max(0.30 mV, 5 × p99.5)` whose excursion reverses within 8 ms.

Left in place, a spike dominates every derivative envelope and the boundary search
collapses onto it — which produced a confident, completely wrong **4 ms QRS** on
the paced case before this was handled. Spikes are blanked for measurement only;
the displayed traces still show them.

### Accuracy, stated plainly

Against the acquisition device's own algorithm on the bundled real recording
(**not** ground truth — a second algorithm):

| | CardioVis | Device (GE 12SL) | Δ |
|---|---|---|---|
| Heart rate | 72 bpm | 72 bpm | 0 |
| PR | 144 ms | 138 ms | +6 |
| QRS | 94 ms | 86 ms | +8 |
| QT | 396 ms | 388 ms | +8 |
| QTc (Bazett) | 433 ms | 424 ms | +9 |
| P duration | 124 ms | 98 ms | +26 |
| Frontal QRS axis | −14° (net area) / +7° (VCG) | 19° | up to 33° |

**Required before public release:** benchmark the delineator against the **LUDB**
expert P/QRS/T annotations and publish mean absolute error in milliseconds per
wave boundary. Do not hide the number.

The axis disagreement is instructive rather than alarming: the net-area axis is
highly sensitive to where QRS offset is placed when there is a prominent terminal
S wave. Trimming our QRS window by 30 ms moves the axis from −7° to +15°. All
three estimates (net-area, VCG-derived, device) are exported side by side.

---

## 4. Vectorcardiography (Tier 2)

Coordinate frame throughout: **+x subject left, +y subject foot (inferior), +z
subject back (posterior)** — the Frank convention, shared by the transforms, the
lead vectors and the exported data.

    d(t) = M · V(t),    V(t) = [I, II, V1, V2, V3, V4, V5, V6]ᵀ

### Inverse Dower (8 × 3 → 3 × 8)

|  | I | II | V1 | V2 | V3 | V4 | V5 | V6 |
|---|---|---|---|---|---|---|---|---|
| **X** | 0.156 | −0.010 | −0.172 | −0.074 | 0.122 | 0.231 | 0.239 | 0.194 |
| **Y** | −0.227 | 0.887 | 0.057 | −0.019 | −0.106 | −0.022 | 0.041 | 0.048 |
| **Z** | 0.022 | 0.102 | −0.229 | −0.310 | −0.246 | −0.063 | 0.055 | 0.108 |

> Edenbrandt L, Pahlm O. Vectorcardiogram synthesized from a 12-lead ECG:
> superiority of the inverse Dower matrix. *J Electrocardiol.* 1988;21(4):361–367.

### Kors regression

|  | I | II | V1 | V2 | V3 | V4 | V5 | V6 |
|---|---|---|---|---|---|---|---|---|
| **X** | 0.38 | −0.07 | −0.13 | 0.05 | −0.01 | 0.14 | 0.06 | 0.54 |
| **Y** | −0.07 | 0.93 | 0.06 | −0.02 | −0.05 | 0.06 | −0.17 | 0.13 |
| **Z** | 0.11 | −0.23 | −0.43 | −0.06 | −0.14 | −0.20 | −0.11 | 0.31 |

> Kors JA, van Herpen G, Sittig AC, van Bemmel JH. Reconstruction of the Frank
> vectorcardiogram from standard electrocardiographic leads: diagnostic
> comparison of different methods. *Eur Heart J.* 1990;11(12):1083–1092.

Both tables were cross-checked against the review tables in *Front Physiol.*
2022;13:856590 (Tables 2 and 4) before being written into code.

### How we know the coefficients are not mistyped

Silently wrong coefficients produce a beautiful, confidently incorrect loop that
nothing downstream can detect. So `tests/test_transforms.py` checks the inverse
Dower matrix against an **independently published** quantity — Dower's forward
matrix, which it is the pseudo-inverse of:

    max | pinv(FORWARD_DOWER) − INVERSE_DOWER |  <  1 × 10⁻³      (measured: 4.9 × 10⁻⁴)

> Dower GE, Machado HB, Osborne JA. On deriving the electrocardiogram from
> vectorcardiographic leads. *Clin Cardiol.* 1980;3(2):87–95.

Round-tripping XYZ → 12 leads → XYZ returns the input to < 5 × 10⁻³. The
transforms are also checked for orientation (positive II must give an inferior Y;
positive V1 must give an anterior, i.e. negative, Z).

### Naive least-squares baseline

    d(t) = pinv(L) · V(t)

where `L` is the 8 × 3 matrix of textbook unit lead vectors (hexaxial frontal
angles; classical precordial angles V1 115° … V6 0°, measured from the left axis
toward the anterior chest). Shipped **so students can see it is worse** — it
assumes idealised, patient-independent lead directions in an infinite homogeneous
torso and is systematically wrong in the horizontal plane. A regression test
asserts it stays worse than Kors on synthetic data with a known dipole.

### Method comparison

Both transforms are run on every recording and the disagreement is exported and
displayed. On the bundled real recording: r_x = 0.982, r_y = 0.997, r_z = 0.955,
relative RMS difference 27.6 %. That spread is the honest precision of Tier 2.

---

## 5. Derived metrics (Tier 2)

    frontal axis = atan2(y, x)            0° = lead I,  +90° = aVF
    azimuth      = atan2(z, x)            0° = left,    +90° = posterior
    elevation    = atan2(y, hypot(x, z))  +90° = inferior

- **Frontal QRS axis**: `atan2(net QRS area in aVF, net QRS area in I)` — the
  classical bedside construction — plus the angle of the mean QRS vector from the
  VCG, plus whatever the device reported. All three, side by side.
- **Spatial QRS-T angle**: angle between the mean QRS vector and the mean T vector
  (time integrals of `d(t)` over each window). The peak-vector variant is reported
  alongside it; the two differ substantially and the literature uses both.
- **Loop planarity**: SVD of the loop points, reported as `s₃/(s₁+s₂+s₃)` — 0 is
  perfectly flat — plus the unit normal of the best-fit plane.
- **Loop area** in each projection plane, by the shoelace formula (mV²).
- **QTc**: Bazett **and** Fridericia, always both, always labelled:

      QTc_Bazett     = QT / √(RR)          (RR in seconds)
      QTc_Fridericia = QT / RR^(1/3)

  Bazett over-corrects at high rates and under-corrects at low ones. A QTc with
  the correction hidden is not a measurement.

Per-beat values are aggregated by median (circular median for angles), taken over
the beat whose intervals sit closest to the medians rather than a blend.

---

## 6. Conduction model (Tier 3)

Region onsets and durations, from the teaching table, anchored to **this
recording's** fiducials:

| Region | Anchor | Onset | Duration | Scales with |
|---|---|---|---|---|
| RA (SA node spread) | P onset | 0 | 30 ms | P duration |
| LA | P onset | +30 ms | 50 ms | P duration |
| AV node (silent) | P offset | 0 | *remainder of the measured PR* | — |
| His / bundle branches | QRS onset | −10 ms | 15 ms | QRS width |
| Septum (L→R) | QRS onset | 0 | 15 ms | QRS width |
| RV free wall | QRS onset | +15 ms | 25 ms | QRS width |
| LV free wall (endo→epi, apex→base) | QRS onset | +20 ms | 45 ms | QRS width |
| Basal / posterior LV | QRS onset | +55 ms | 25 ms | QRS width |
| Repolarisation (epi→endo, reversed order) | ST onset | — | through T offset | — |

Ventricular durations are scaled by `measured QRS / 85 ms`, so a 170 ms QRS
stretches every ventricular event by 2×. The AV delay is not a constant at all: it
is whatever is left of that beat's measured PR interval.

Activation ramps are smoothstep rather than linear — the derivative of a linear
ramp is a rectangle, which makes the synthetic dipole a box car.

### The synthetic dipole and the cross-check

Each region contributes `weight × d(activation)/dt × direction` to a modelled
dipole. Repolarisation contributes in the **same** direction at 30 % weight, since
a repolarising wavefront has reversed polarity travelling in the reverse
direction — which is why the normal T wave is concordant with the QRS.

That modelled dipole is correlated against the measured Tier-2 dipole over the
QRS windows and over whole beats, and the result is displayed. See
`LIMITATIONS.md` for the table of correlations across the bundled cases, and for
the conditions under which the model declares itself inapplicable.

---

## 7. Synthetic generation

`cardiovis/synth.py` chooses `d(t)` first — as a sum of Gaussian vector components
with textbook directions — and **projects** it onto the published forward Dower
lead vectors to produce the 12 leads. Noise, baseline wander, mains hum and pacing
spikes are added to the 8 independent leads only, and the dependent leads are
derived afterwards, exactly as a real machine does it. That is why a synthetic
file satisfies `II = I + III` to within noise, as a real one does.

Because the true dipole is known exactly, synthetic cases are the only place where
VCG reconstruction can be checked against truth rather than against another
algorithm.

---

## 8. Export format

See the module docstring of `cardiovis/frames.py`. `frames.json` carries metadata,
tiers, fiducials, metrics, the region schedule and the warnings; the waveforms
travel as raw `float32` side-cars so the frontend can upload them straight into
typed arrays. `deident.assert_phi_free` runs over the manifest before it is
written, and the export fails rather than leaks.
