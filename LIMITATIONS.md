# Limitations

**For education and research. Not a medical device. Not for diagnosis or clinical
decision-making.**

This document is linked from the footer of the app because it is not a disclaimer
bolted on afterwards — it is the reason the software is shaped the way it is.

---

## The short version

CardioVis shows you a heart with colour sweeping across it. **That sweep is not a
measurement of the patient.** It is textbook physiology, played at the patient's
timing. The arrow and the loop *are* patient-specific. The anatomy is not.

---

## Why the wavefront cannot be recovered

A 12-lead ECG looks like twelve signals. It is eight.

    I, II, V1, V2, V3, V4, V5, V6      — independent
    III = II − I                        — arithmetic
    aVR = −(I + II)/2                   — arithmetic
    aVL = (I − III)/2                   — arithmetic
    aVF = (II + III)/2                  — arithmetic

Those relationships are definitional; they are how the leads are built out of the
electrode potentials. So the information a 12-lead recording contains is eight
numbers per sample.

Now count what a reconstruction would need:

| Quantity | Degrees of freedom per time instant |
|---|---|
| The 12-lead ECG | **8** |
| A single equivalent dipole `d(t)` | **3** |
| An activation wavefront over a myocardial mesh | **thousands** |

Going from 8 to 3 is over-determined — a least-squares problem with a comfortable
margin, which is why the vectorcardiogram is defensible. Going from 8 to thousands
is massively under-determined: infinitely many wavefront patterns produce exactly
the same eight signals, and no amount of clever software distinguishes between
them. This is not a limitation of our implementation. It is a property of the
measurement.

## What about ECGI?

Electrocardiographic imaging is the clinical technology that does attempt genuine
3D reconstruction. It uses:

- a **200–250 electrode body-surface vest**, not 10 electrodes, and
- **patient-specific CT heart–torso geometry**, so the forward model knows where
  this patient's heart actually sits in this patient's chest.

Even with all that, spatial accuracy in human validation studies has been
described as only moderate, which is one of the principal reasons ECGI has not
achieved broad clinical adoption.

CardioVis has ten electrodes and no imaging. **We are not doing ECGI, and we do
not pretend to.** We do something narrower and honest: an exact vectorcardio-
graphic reconstruction (Tier 2) driving a plausible textbook conduction animation
(Tier 3), with the boundary between them visible at all times.

---

## The three tiers

The tier of every displayed quantity is carried in the data, not decided by the
UI — see `cardiovis/tiers.py` and the `tier` fields in `frames.json`.

### Tier 1 — Measured
Directly present in the file: the twelve waveforms, the sample rate, the device
metadata, the acquisition filter settings.

### Tier 2 — Derived
Recoverable from the 8 independent leads by defensible mathematics, specific to
this patient:

- the dipole trajectory `d(t)` (inverse Dower or Kors transform),
- the frontal QRS axis, PR / QRS / QT / QTc, heart rate,
- the spatial QRS-T angle, T-loop orientation, loop planarity and area.

Tier 2 is still a **model**: it assumes the heart's electrical activity at each
instant can be summarised by one equivalent dipole in a homogeneous torso. It
cannot be exactly true. The app shows you the size of the error directly — the
projection panel prints the projected value next to the voltage the lead actually
recorded, and the difference between them is the approximation, made visible.

Two published transforms also disagree with each other by a measurable amount on
the same recording. That disagreement is displayed too, because it is the honest
precision of this layer.

### Tier 3 — Illustrative
The spatial anatomy of the wavefront: the colour sweeping atria → AV node →
septum → RV → LV → basal LV, and the chamber contraction.

Region shapes, ordering and directions are **identical for every patient**. Only
the timing is patient-specific — each region's onset and duration is anchored to
this recording's own P onset, PR interval, QRS onset and QRS width, so a wide QRS
visibly stretches and desynchronises the sweep instead of replaying a canned
normal animation.

Tier 3 carries a badge that **cannot be dismissed**.

---

## The model checks itself

The Tier-3 region activation is integrated into a synthetic dipole and correlated
against the Tier-2 dipole measured from the recording. That correlation is
displayed, flattering or not:

| Case (bundled) | QRS correlation, model vs measured |
|---|---|
| Normal sinus (synthetic) | r ≈ 0.93 |
| LBBB (synthetic) | r ≈ 0.90 |
| RBBB (synthetic) | r ≈ 0.73 |
| Right axis deviation (synthetic) | r ≈ 0.01 |
| Ventricular paced (synthetic) | r ≈ −0.15 |
| Real de-identified recording | r ≈ 0.70 |

The right-axis and paced rows are the point. The model assumes a normal
activation route; when the heart does not use one, the model is wrong, and it says
so rather than animating confidently past it.

## When the model refuses to apply at all

`modelApplicable` goes false, and the banner turns red, when the recording breaks
the model's assumptions:

- **irregular rhythm** — there is no repeating activation sequence to animate,
- **no P waves** — atrial activation cannot be timed from this recording,
- **pacing spikes** — activation starts at a lead tip, not the His bundle,
- **low template consistency** — beats differ; detection may be unreliable.

The atrial fibrillation case in the teaching library exists specifically to show
this happening. It is a lesson, not a bug.

---

## Things CardioVis will never do

- Emit a diagnostic statement, an ICD code, or a "possible MI"-style suggestion.
  The source files often contain the acquisition device's own interpretive
  statements; CardioVis parses them so they are not silently lost and then
  **never exports or displays them**.
- Present the animated wavefront as this patient's actual activation sequence.
- Be used for clinical decision-making.
- Store or display identifiable patient data by default (see `PRIVACY.md`).

## Known limitations of this implementation

- **Delineation has not yet been benchmarked against expert annotations.** The
  boundary detector is a multiscale-derivative method, not a literal
  reimplementation of the published wavelet filter bank, and its QRS boundary
  threshold is a documented trade-off that moves measured intervals by ~20 ms
  across its plausible range. Benchmarking against LUDB and publishing the
  per-boundary error in milliseconds is the gate before any public release. See
  `METHODS.md`.
- **Precordial lead vectors are textbook directions, not this patient's.** Real
  precordial lead vectors depend on heart position, body habitus and lung
  volume. The lead axes drawn in 3D are the classical teaching angles.
- **The heart mesh is procedural.** Ellipsoids with correct topology and ordering,
  not an anatomical model. Nobody should mistake it for anatomy — which is
  preferable to a detailed mesh of unverified provenance, which invites exactly
  that mistake.
- **Most bundled cases are synthetic**, generated by `cardiovis.synth`, and are
  labelled as such everywhere they appear. They are cartoons with correct
  arithmetic, not recordings of people.
