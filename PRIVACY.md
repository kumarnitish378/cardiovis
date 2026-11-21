# Privacy

**De-identification runs inside the parser, before the data reaches any other
module.** It is not a post-processing step that can be skipped, forgotten, or
run in the wrong order — `cardiovis/ecg_parser/ge_sapphire.py` calls
`cardiovis/deident.py` while it is still reading the file, and nothing
downstream ever sees the identifiers.

---

## What a source file contains

A GE Sapphire / DCAR export carries, among the waveforms:

| Field | Example | Disposition |
|---|---|---|
| patient name | `<given V="..."/>` | **removed** |
| medical record number | `<identifier><id V="..."/>` | **removed** |
| site name | `<site displayName="..."/>` | **removed** |
| site address, city | `<siteAddress>` | **removed** |
| device serial number | `<serialID V="..."/>` | **removed** |
| acquisition date and time | `2023-05-10T10:12:23.00` | **coarsened to the year** |
| exact age | `61` | **coarsened to a 10-year band** |
| sex | `F` | **kept** |

## What is kept, and why

- **Age band** (`60-69`, or `90+` above 89, following HIPAA Safe Harbor) —
  physiologically relevant: normal intervals and axes shift with age.
- **Sex** — physiologically relevant: QTc thresholds and normal amplitude ranges
  differ.
- **Acquisition year** — lets a device generation be identified without giving a
  date of service.
- **Device vendor and model** (not the serial number) — the acquisition filter
  settings and the algorithm that produced the comparison measurements matter for
  interpreting our own.

## The pseudonymous ID

    pseudo_id = "cv_" + HMAC-SHA256(local_salt, mrn | serial | timestamp | filename)[:12]

- **Deterministic**: the same recording gets the same ID across sessions, so
  exports can be regenerated and compared.
- **Salted and non-reversible**: the ID cannot be turned back into an identifier,
  and IDs cannot be matched across installations, because the salt is local.
- The salt lives in `~/.cardiovis/deident_salt` (32 random bytes, created on
  first use, `chmod 600` where the OS supports it) or comes from
  `CARDIOVIS_DEIDENT_SALT`.
- **Already-scrubbed files have no identifiers left to hash.** Rather than
  hashing the filename — which would give the same recording a new ID every time
  it was renamed — the ID falls back to a hash of the waveform itself: stable,
  high-entropy, and not identifying on its own.

## `--keep-phi`

A `--keep-phi` flag exists for local clinical use, where a clinician needs the
name on screen to know whose ECG they are looking at. It:

- prints a loud, unmissable warning banner and raises a Python `UserWarning`,
- marks the recording `phi_retained = True`,
- and **raises a `RuntimeError` instead of running** when
  `CARDIOVIS_SHIPPING_BUILD=1` is set.

Set `CARDIOVIS_SHIPPING_BUILD=1` in any environment that deploys or distributes
this software. The check is covered by a test
(`test_keep_phi_is_refused_in_a_shipping_build`).

## Nothing leaks into exports

`deident.assert_phi_free()` walks the entire manifest before `frames.json` is
written and raises on any identifier-shaped key — `name`, `mrn`, `id`, `site`,
`address`, `serialID`, `acquisitionDateTime`, and others. The export **fails**
rather than writes.

A short allowlist exists for keys that are innocently named (`tiers.*.name` is a
tier enum, `conduction.regions[].name` is an anatomical region, and the device's
own filter algorithms have names like "Anti-Drift System"). Every entry in that
list is a place the guard has been deliberately switched off, so it is kept
short and explicit, in `cardiovis/frames.py`.

PHI is also never written to logs, error traces or telemetry: the exported
manifest is the only artefact the pipeline produces, and the parser's error
messages quote element paths, never values.

## Scrubbing a source file

To produce a de-identified copy of the original XML — waveforms and measurements
untouched, so it behaves identically in the pipeline:

    python -m cardiovis scrub data/example_ecg.xml -o data/samples/sample.xml

It removes the `name`, `identifier`, `siteAddress` and `serialID` elements,
blanks the site display name, replaces the exact age with the midpoint of its
band, and truncates the acquisition timestamp to 1 January of its year.
`patientInfo` cannot simply be deleted — the whole `ecgResting` tree hangs off
it — so its identifying children are removed individually.

## What is in this repository

- `data/samples/sample_normal_sinus.xml` — a **de-identified** real recording.
- `web/public/data/` — exported, de-identified case data (manifests and float32
  waveforms). Eleven of the twelve cases are synthetic.
- `data/example_ecg.xml` — the **original, identifiable** file. It is listed in
  `.gitignore` and must never be committed. If you are reading this in a clone,
  it should not be present.

## Your obligations

De-identification under HIPAA Safe Harbor, the DPDP Act, the GDPR or your local
equivalent is a judgement about the whole disclosure, not a checklist this tool
can complete for you. A waveform is itself high-entropy and, combined with an
external dataset, can in principle be re-identifying. Before sharing exports
outside the environment the recording came from, get that decision made by
whoever is accountable for it at your institution.
