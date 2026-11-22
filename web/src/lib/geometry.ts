import * as THREE from "three";

/**
 * Two coordinate frames, and one place that converts between them.
 *
 *   Anatomical (what the Python side exports, Frank convention):
 *       +x subject left, +y subject foot (inferior), +z subject back (posterior)
 *   Scene (three.js convention, what the camera sees):
 *       +x subject left, +y up (superior), +z toward the viewer (anterior)
 *
 * So the conversion is a sign flip on y and z. Every vector that comes out of
 * frames.json - the dipole, lead unit vectors, region directions - goes through
 * `anatToScene`. Doing it ad hoc is how a visualisation ends up mirrored, which
 * is the one bug that would make this whole product teach the wrong thing.
 */
export function anatToScene(v: readonly number[]): THREE.Vector3 {
  return new THREE.Vector3(v[0], -v[1], -v[2]);
}

export function anatToSceneInto(out: THREE.Vector3, x: number, y: number, z: number): THREE.Vector3 {
  return out.set(x, -y, -z);
}

/** Scene units per millivolt for the dipole arrow and the VCG loop. */
export const MV_TO_UNITS = 1.35;

/** Radius of the torso reference sphere the lead axes are drawn across. */
export const TORSO_RADIUS = 2.6;

/** The heart mesh is scaled down so the dipole arrow and the VCG loop - the
 *  patient-specific things - are the largest objects on screen. The anatomy is
 *  context; the vector is the subject. */
export const HEART_SCALE = 0.9;

export const CAMERA_PRESETS: Record<string, { position: [number, number, number]; label: string; hint: string }> = {
  frontal: {
    position: [0, 0, 8],
    label: "Frontal",
    hint: "Looking at the front of the chest: the plane of the limb leads (I, II, III, aVR, aVL, aVF).",
  },
  horizontal: {
    position: [0, 8, 0.001],
    label: "Horizontal",
    hint: "Looking down through the chest: the plane of the precordial leads V1-V6.",
  },
  sagittal: {
    position: [8, 0, 0],
    label: "Sagittal",
    hint: "Looking from the patient's left side.",
  },
  oblique: {
    position: [5.0, 3.5, 5.0],
    label: "Oblique",
    hint: "Three-quarter view - the easiest angle for seeing the loop as a loop.",
  },
};

/* The 3D scene shares the data colours defined in styles.css: blue = Tier 1,
   green = Tier 2 and the projection, amber = Tier 3 and the lead axis, coral =
   the heart vector. Kept as literals here because WebGL materials are
   built before the CSS custom properties can be read. */
export const TIER_COLOURS: Record<number, string> = {
  1: "#7ea9ff",
  2: "#3ccb94",
  3: "#f0b03f",
};

export const LEAD_COLOUR = "#f0b03f";       // --c-lead
export const VECTOR_COLOUR = "#ff6b57";     // --c-vector
export const PROJECTION_COLOUR = "#3ccb94"; // --c-proj

/** Colours for the conduction model, by state. Tier 3 - illustrative. */
export const REGION_RESTING = new THREE.Color("#7a3c46");   // muted myocardium
export const REGION_DEPOLARISED = new THREE.Color("#f5a45e"); // tertiary, hot
export const REGION_REPOLARISED = new THREE.Color("#3f5f88"); // primary-container
