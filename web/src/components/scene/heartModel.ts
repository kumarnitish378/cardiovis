/**
 * The heart mesh - procedural, deliberately.
 *
 * The spec asks for an openly-licensed anatomical GLTF with named chamber
 * nodes. That is the right answer for a release, and this file is written to be
 * replaced by one: `REGION_SHAPES` keys are exactly the region keys the Python
 * conduction model emits, so a GLTF whose nodes carry those names drops into
 * `HeartScene` by swapping the geometry source and keeping the colour logic.
 *
 * Until a specific model has been found *and its licence read*, shipping
 * ellipsoids is the honest option: nobody mistakes these for anatomy, whereas a
 * detailed mesh of unverified provenance invites exactly that. The chamber
 * positions below are anatomically ordered (RA right-anterior-superior, LA
 * posterior, RV anterior, LV left-posterior-inferior, apex pointing down-left)
 * so the spatial story the animation tells is still the right one.
 *
 * Positions are SCENE coordinates: +x subject left, +y superior, +z anterior.
 */

export interface RegionShape {
  /** Sphere radii along x, y, z, in scene units. */
  scale: [number, number, number];
  position: [number, number, number];
  rotation?: [number, number, number];
  opacity?: number;
}

export const REGION_SHAPES: Record<string, RegionShape> = {
  // Atria: small and high. They are a fifth of the muscle mass of the
  // ventricles, and drawing them any larger makes the P wave look as important
  // as the QRS.
  ra: { scale: [0.46, 0.38, 0.44], position: [-0.62, 0.78, 0.26] },
  la: { scale: [0.42, 0.36, 0.42], position: [0.5, 0.82, -0.42] },
  av: { scale: [0.13, 0.13, 0.13], position: [-0.06, 0.42, 0.02], opacity: 0.95 },
  his: { scale: [0.08, 0.3, 0.08], position: [-0.02, 0.12, 0.0] },
  septum: { scale: [0.12, 0.72, 0.5], position: [-0.04, -0.5, 0.0], rotation: [0, 0, -0.12] },
  rv: { scale: [0.5, 0.82, 0.58], position: [-0.58, -0.55, 0.26], rotation: [0, 0, 0.22] },
  // The LV is the dominant mass and its apex points down and to the left -
  // which is why the mean QRS vector does too.
  lv: { scale: [0.82, 1.08, 0.8], position: [0.42, -0.72, -0.1], rotation: [0, 0, -0.2] },
  lv_basal: { scale: [0.52, 0.36, 0.52], position: [0.52, 0.22, -0.26] },
};

/** Great vessels and the apex marker - context only, never coloured by data. */
export const STATIC_PARTS: Array<{ key: string; shape: RegionShape; colour: string }> = [
  { key: "aorta", shape: { scale: [0.26, 0.85, 0.26], position: [0.05, 1.25, -0.1] }, colour: "#8d3b46" },
  { key: "pulmonary artery", shape: { scale: [0.24, 0.7, 0.24], position: [-0.42, 1.2, 0.28] }, colour: "#3f5f8d" },
  { key: "superior vena cava", shape: { scale: [0.2, 0.6, 0.2], position: [-0.95, 1.25, 0.2] }, colour: "#3f5f8d" },
];
