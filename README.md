# CardioVis

> **For education and research. Not a medical device. Not for diagnosis or
> clinical decision-making.**

An interactive 3D visualisation of how a real patient's 12-lead ECG maps onto the
heart's electrical activity in space — built for teaching and explanation.

Click a lead. Watch the heart vector swing, watch its shadow fall on that lead's
axis, and watch the trace being drawn by that shadow. That is the whole idea: **a
lead is a shadow of a rotating vector.** Once a student sees it, aVR's inversion,
axis deviation, R-wave progression and reciprocal changes stop being four facts
and become one.

---

## What it does, and what it refuses to do

CardioVis tags every visual element with its evidence tier, and the UI shows the
tier:

| Tier | What it is | Examples |
|---|---|---|
| **1 — Measured** | Directly in the file | the 12 waveforms, sample rate, device metadata |
| **2 — Derived** | Recovered from the 8 independent leads by published maths, patient-specific | the dipole `d(t)`, QRS axis, PR/QRS/QT/QTc, spatial QRS-T angle, loop shape |
| **3 — Illustrative** | Textbook physiology, timed by this patient's fiducials | the colour sweeping across the chambers |

Tier 3 carries a badge that **cannot be dismissed**, and the model **checks
itself**: its implied dipole is correlated against the measured one and the
result is displayed, flattering or not. On a right-axis-deviation case that
correlation is ≈ 0.01, and the app says so.

CardioVis will not emit a diagnostic statement, will not present the animation as
this patient's actual activation sequence, and will not display identifiable
patient data by default. See **[LIMITATIONS.md](LIMITATIONS.md)** for why the
wavefront is not recoverable from 8 signals, and **[PRIVACY.md](PRIVACY.md)** for
what is stripped.

## Quick start

```bash
# 1. Python pipeline
pip install -r requirements.txt

# 2. Build the teaching library (11 synthetic cases, no licence entanglements)
python -m cardiovis library -o web/public/data

# 3. Add your own recording (de-identified on the way in)
python -m cardiovis process data/samples/sample_normal_sinus.xml -o web/public/data \
    --title "Real recording - normal sinus"

# 4. Run the app
cd web && npm install --legacy-peer-deps && npm run dev
```

Other commands:

```bash
python -m cardiovis inspect data/samples/sample_normal_sinus.xml   # summary, tier by tier
python -m cardiovis plot    data/samples/sample_normal_sinus.xml -o scratch/sanity.png
python -m cardiovis scrub   data/example_ecg.xml -o data/samples/sample.xml
python -m cardiovis index   web/public/data                        # rebuild the case index
python -m pytest tests -q
```

`--notch 60` for US mains, `--notch 0` to disable; `--vcg kors | inverse_dower |
naive_pinv` to change the transform.

## The interface

- **Projection tab** — the feature above. Lead axis, dipole, dropped
  perpendicular, projection bar, and the live numbers: `d · u` next to the
  voltage the lead actually recorded. The gap between them is the size of the
  Tier-2 approximation, shown rather than hidden.
- **3D annotations** — anatomical orientation (left/right, superior/inferior,
  anterior/posterior), chamber names on the model regions, the **+/− ends of the
  selected lead axis**, and two live readouts pinned to the geometry: the
  vector's magnitude at its tip and the projected voltage where the
  perpendicular meets the axis. The polarity labels are what turn "aVR is
  inverted" from a rule into something visible: the positive electrode points up
  and to the patient's right, so a vector heading down and left reads negative.
  Toggle with **Labels** in the **Display** menu at the top-right of the 3D view.
- **12-lead panel** — click any trace to select that lead *and* seek to that
  instant. Canvas 2D with min/max decimation; the playhead is drawn without a
  React render.
  - **Three independent axes**, each with its own `−`/`+` in the toolbar:
    **time** (the window, 10 s down to ~20 ms), **mV** (amplitude gain, shown in
    mm/mV with a calibration bar on every row), and **rows** (pixels per lead).
  - **Wheel** zooms time about the pointer, **shift+wheel** zooms amplitude,
    **ctrl+wheel** changes row height. **Drag** pans; **alt+drag** (or the `box`
    button) draws a rectangle and zooms to it, setting time *and* amplitude at
    once. **Double-click** resets. `beat` fits the current beat, centred on its
    QRS.
  - **Rows have a real height and the panel scrolls.** Twelve leads squeezed
    into the leftover space gave ~18 px per trace, at which point zooming showed
    nothing; rows are sized in pixels and the panel scrolls when they no longer
    fit. In `selected only` mode the one lead fills the panel exactly.
  - Zoom re-rasterises the window rather than magnifying pixels, and past one
    sample per pixel it draws individual samples — enough to read a delta wave.
  - `follow` keeps the playhead in view while playing zoomed in; when the
    playhead is outside the window, the panel dims it against the edge it is
    beyond instead of drawing it at a time it is not at.
  - A time ruler picks its own tick spacing, from 5 s down to 10 ms, and carries
    a chip showing the exact time under the playhead.
- **Measurements tab** — intervals, axes, loop metrics, each next to the
  acquisition device's own number for comparison. QTc is always shown both ways.
- **Limits tab** — what this recording does not support, the warnings the
  pipeline raised, and where the Tier-3 model stands on it.
- **Placement lab** — rotate a lead's axis off its correct position and watch the
  recorded deflection change, and sometimes invert.
- Playback runs 0.05×–1×, loops a single beat, and steps in 4 ms increments.
  Space plays and pauses; arrow keys step; **f** collapses the side panel.
- **Layout**: drag the divider above the traces to resize the 3D view, or switch
  the panel between all 12 leads, the selected lead only, and hidden. Heights
  persist across sessions.

## Look and feel

The UI is built to feel like a quiet scientific instrument: graphite surfaces,
hairline rules, one type family (IBM Plex Sans and Mono), and saturated
colour kept for data only. All the colour values live as tokens at the top of
`web/src/styles.css`, and the 3D scene uses the same palette.

| Token | Used for |
|---|---|
| `--c-vector` (coral) | the heart vector, negative projections, the playhead |
| `--c-lead` (amber) | the selected lead axis and its trace; Tier 3 "illustrative" |
| `--c-proj` (green) | the projection onto the lead, the VCG loop; Tier 2 "derived" |
| `--t1` (blue) | Tier 1 "measured" |

Only one thing on screen is ever inverted (light fill, dark text): the lead you
are looking through. Every other selected state is a quiet raised surface.

**Responsive.** Above 1100 px the leads sit in a vertical rail beside the 3D
view and the explanations in a side inspector. Below that (tablet portrait,
phone), the leads become a scrollable strip under the 3D view, and the traces
and explanations share one tabbed dock. On phones the display options open as
a bottom sheet, and the stage keeps only the labels that carry the lesson.

## Architecture

```
  data/*.xml
      │  ecg_parser/      format adapters (GE Sapphire first) + deident at parse time
      ▼
  filters.py              0.5-40 Hz zero-phase Butterworth, configurable mains notch
  leads.py                Einthoven/Goldberger validation, lead geometry
  delineate.py            Pan-Tompkins on multi-lead RMS, multiscale wave boundaries
      ▼
  vcg.py                  d(t) via inverse Dower / Kors            [TIER 2]
  metrics.py              axis, intervals, QRS-T angle, loop shape [TIER 2]
      ▼
  conduction.py           regional activation timed by this patient [TIER 3]
      ▼
  frames.py               frames.json + float32 side-cars
      ▼
  web/                    React + TypeScript + React Three Fiber + zustand
```

Every stage is importable on its own; `pipeline.py` only wires them in the order
the tiers require. Adding SCP-ECG, DICOM-ECG, HL7 aECG, Philips XML or WFDB means
adding an adapter and touching nothing downstream.

## The teaching library

Eleven synthetic cases plus one de-identified real recording:

normal sinus · left axis deviation · right axis deviation · LBBB · RBBB · LVH ·
inferior STEMI · anterior STEMI · WPW pre-excitation · **atrial fibrillation** ·
ventricular paced rhythm

The atrial fibrillation and paced cases are in the library to show CardioVis
*refusing* to animate: there is no stable beat timing to key the model to, and
the app says so instead of playing a confident cartoon. That is a lesson, not a
bug.

Cases are synthetic on purpose. Open datasets (PTB-XL, LUDB, PhysioNet) each carry
their own licence and consent framework; `cardiovis/synth.py` chooses `d(t)`
first and projects it onto published lead vectors, so the cases carry no licence
entanglement **and** come with a known ground-truth dipole — the only way to test
the VCG reconstruction against truth rather than against another algorithm.

## Testing

```bash
python -m pytest tests -q        # 50 tests
```

- **Lead algebra** — the Einthoven and Goldberger identities on synthetic input;
  corrupt stored leads must be detected and recomputed.
- **Transform coefficients** — the inverse Dower matrix is checked against an
  independently published quantity, the forward Dower matrix it is the
  pseudo-inverse of (agreement < 1 × 10⁻³). Silently wrong coefficients produce a
  beautiful, confidently incorrect loop that nothing else would catch.
- **Ground truth** — inverse Dower recovers a known synthetic dipole at r > 0.99.
- **Adversarial inputs** — flat lead, mid-recording dropout, extreme baseline
  wander, mains hum, atrial fibrillation, paced rhythm, a 3-second strip, and
  pure noise. Each must fail visibly.
- **Golden-file regression** — frozen metrics for a fixed synthetic case.
- **Browser smoke test** — `cd web && node scripts/smoke.mjs` loads the app in
  headless Chromium, drives the case picker and lead selection, asserts no
  console errors, and writes screenshots to `scratch/`.

**Not yet done, and required before any public release:** benchmark the
delineator against LUDB expert annotations and publish the per-boundary error in
milliseconds. See [METHODS.md](METHODS.md), which states the current accuracy
against the acquisition device's own algorithm and the sensitivities behind it.

## Documentation

- **[LIMITATIONS.md](LIMITATIONS.md)** — why the wavefront cannot be recovered,
  in plain language. Linked from the app.
- **[METHODS.md](METHODS.md)** — every transform, filter and formula, with
  primary-source citations and the measured errors.
- **[PRIVACY.md](PRIVACY.md)** — what is stripped, what is retained, why.

## References

- Malmivuo J, Plonsey R. *Bioelectromagnetism* — lead vector theory, the dipole
  model and its limits.
- Pan J, Tompkins WJ. A real-time QRS detection algorithm. *IEEE TBME* 1985.
- Martínez JP et al. A wavelet-based ECG delineator. *IEEE TBME* 2004.
- Dower GE et al. *Clin Cardiol* 1980; Edenbrandt L, Pahlm O. *J Electrocardiol*
  1988; Kors JA et al. *Eur Heart J* 1990 — the VCG transforms.
- ECGI literature (Rudy and colleagues) — read specifically to understand what
  CardioVis is *not* doing, and why.
