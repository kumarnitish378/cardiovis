import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/**
 * The heart mesh - procedural, anatomically shaped.
 *
 * Still procedural on purpose: no third-party mesh means no licence to verify
 * and no unverifiable provenance. But the shapes now follow gross anatomy
 * rather than being a cluster of ellipsoids:
 *
 *  - the LV is a truncated prolate "bullet" (a lathe of a measured-looking
 *    profile), split into apical/mid free wall, basal free wall and septum -
 *    exactly the regions the Python conduction model emits;
 *  - the RV is a crescent wrapped around the LV's right-anterior face, made by
 *    pushing an ellipsoid's inner surface out onto the LV, with an outflow tract
 *    (infundibulum) running up and left to the pulmonary valve;
 *  - the atria sit above the base, the RA to the right with its appendage, the
 *    LA posterior with its appendage and four pulmonary veins;
 *  - the conduction system is drawn as structures: AV node at the crux, His
 *    bundle piercing the septum, right and left bundle branches running down
 *    either side of it;
 *  - the great vessels are tubes along anatomical paths: ascending aorta, arch
 *    and descending aorta; pulmonary trunk and its bifurcation; SVC and IVC.
 *
 * The ventricles are authored in a heart-local frame (long axis = local y, apex
 * at -y) and then rotated so the apex points left, inferior and anterior - the
 * anatomical long axis, ~40 deg left of vertical in the frontal plane and tipped
 * forward. That orientation is the reason the normal mean QRS vector points
 * down and to the left, so it is worth getting right.
 *
 * Every geometry is baked into SCENE coordinates (+x subject left, +y superior,
 * +z anterior), so meshes carry identity transforms and `REGION_ANCHORS` can be
 * used directly for labels.
 *
 * Dimensions are schematic, in scene units (the whole heart is ~2.4 units from
 * the top of the aortic arch to the apex before HEART_SCALE).
 */

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

/** Heart-local -> scene. Rz swings the apex to the subject's left, Rx tips it
 *  forward. Translation re-centres the ventricles near the origin, where the
 *  dipole arrow starts. */
const LOCAL_TO_SCENE = new THREE.Matrix4()
  .makeTranslation(-0.42, 0.18, 0.0)
  .multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(-0.38, 0, 0.72, "XYZ")));

function toScene(x: number, y: number, z: number): THREE.Vector3 {
  return new THREE.Vector3(x, y, z).applyMatrix4(LOCAL_TO_SCENE);
}

// ---------------------------------------------------------------------------
// LV profile (heart-local). Radius as a function of height along the long axis.
// ---------------------------------------------------------------------------

/** LV long axis passes through (LV_X, *, LV_Z) in the local frame. */
const LV_X = 0.25;
const LV_Z = -0.1;

const LV_PROFILE: Array<[number, number]> = [
  [0.0, -1.55],
  [0.17, -1.48],
  [0.35, -1.31],
  [0.51, -1.06],
  [0.62, -0.76],
  [0.69, -0.43],
  [0.71, -0.1],
  [0.7, 0.14],
  [0.64, 0.32],
  [0.5, 0.43],
  [0.28, 0.48],
  [0.0, 0.5],
];
const SPLIT_INDEX = 6; // y = -0.10: below is apical/mid, above is basal

function lvRadius(y: number): number {
  if (y <= LV_PROFILE[0][1] || y >= LV_PROFILE[LV_PROFILE.length - 1][1]) return 0;
  for (let i = 1; i < LV_PROFILE.length; i++) {
    const [r1, y1] = LV_PROFILE[i];
    if (y <= y1) {
      const [r0, y0] = LV_PROFILE[i - 1];
      return r0 + ((y - y0) / (y1 - y0)) * (r1 - r0);
    }
  }
  return 0;
}

/** Unit direction, in the local x-z plane, from the LV axis toward the RV. */
const SEPTAL_DIR = new THREE.Vector2(-0.86, 0.51).normalize();
const SEPTAL_PHI = Math.atan2(SEPTAL_DIR.x, SEPTAL_DIR.y); // Lathe: x = r sin(phi), z = r cos(phi)
const SEPTAL_WIDTH = 1.75; // rad - the septal sector of the LV wall

function lathe(
  profile: Array<[number, number]>,
  phiStart: number,
  phiLength: number,
  segments: number,
  scale = 1,
): THREE.BufferGeometry {
  const pts = profile.map(([r, y]) => new THREE.Vector2(r * scale, y));
  const g = new THREE.LatheGeometry(pts, segments, phiStart, phiLength);
  g.translate(LV_X, 0, LV_Z);
  return g;
}

// ---------------------------------------------------------------------------
// Primitive helpers
// ---------------------------------------------------------------------------

function ellipsoid(
  radii: [number, number, number],
  centre: [number, number, number],
  rotation: [number, number, number] = [0, 0, 0],
  seg: [number, number] = [36, 24],
): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, seg[0], seg[1]);
  g.scale(...radii);
  g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...rotation)));
  g.translate(...centre);
  return g;
}

function tube(points: THREE.Vector3[], radius: number, radial = 14, taper = 1): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points, false, "centripetal");
  const seg = Math.max(24, points.length * 16);
  const g = new THREE.TubeGeometry(curve, seg, radius, radial, false);
  if (taper !== 1) {
    // Linearly taper the radius along the tube (used for bundle branches).
    const pos = g.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i <= seg; i++) {
      const c = curve.getPointAt(i / seg);
      const k = 1 + (taper - 1) * (i / seg);
      for (let j = 0; j <= radial; j++) {
        const idx = i * (radial + 1) + j;
        v.fromBufferAttribute(pos, idx).sub(c).multiplyScalar(k).add(c);
        pos.setXYZ(idx, v.x, v.y, v.z);
      }
    }
    g.computeVertexNormals();
  }
  return g;
}

function bake(g: THREE.BufferGeometry): THREE.BufferGeometry {
  g.applyMatrix4(LOCAL_TO_SCENE);
  g.computeVertexNormals();
  return g;
}

/** Merge geometries that may differ in attributes (Lathe vs Sphere vs Tube). */
function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const clean = parts.map((p) => {
    const g = p.index ? p.toNonIndexed() : p;
    for (const name of Object.keys(g.attributes)) {
      if (name !== "position" && name !== "normal") g.deleteAttribute(name);
    }
    return g;
  });
  const out = mergeGeometries(clean, false)!;
  out.computeVertexNormals();
  return out;
}

// ---------------------------------------------------------------------------
// Ventricles (heart-local, then baked)
// ---------------------------------------------------------------------------

function buildLvApical() {
  const p = LV_PROFILE.slice(0, SPLIT_INDEX + 1);
  return bake(lathe(p, SEPTAL_PHI + SEPTAL_WIDTH / 2, Math.PI * 2 - SEPTAL_WIDTH, 48));
}

function buildLvBasal() {
  const p = LV_PROFILE.slice(SPLIT_INDEX);
  return bake(lathe(p, SEPTAL_PHI + SEPTAL_WIDTH / 2, Math.PI * 2 - SEPTAL_WIDTH, 48, 1.01));
}

function buildSeptum() {
  // Shared wall between the ventricles: the septal sector of the LV, full height
  // except the very apex (which is LV free wall).
  const p = LV_PROFILE.slice(1, LV_PROFILE.length - 1);
  return bake(lathe(p, SEPTAL_PHI - SEPTAL_WIDTH / 2, SEPTAL_WIDTH, 20, 0.995));
}

/**
 * RV: an ellipsoid sitting on the LV's right-anterior face, plus an outflow
 * tract. Every vertex that falls inside the LV is pushed radially out onto the
 * LV surface, which turns the ellipsoid into the familiar crescent wrapped
 * around the septum.
 */
function buildRv() {
  const rotY = Math.atan2(-SEPTAL_DIR.x, SEPTAL_DIR.y) - Math.PI / 2; // local x -> tangent
  const centreR = 0.5;
  const body = ellipsoid(
    [0.78, 0.86, 0.5],
    [LV_X + SEPTAL_DIR.x * centreR, -0.42, LV_Z + SEPTAL_DIR.y * centreR],
    [0, rotY, 0.08],
    [48, 32],
  );
  // Infundibulum: up and toward the subject's left-anterior, to the pulmonary valve.
  const rvot = ellipsoid([0.27, 0.42, 0.25], [0.0, 0.42, 0.52], [0.25, 0, -0.35], [28, 20]);
  const g = merge([body, rvot]);

  const pos = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const dx = v.x - LV_X;
    const dz = v.z - LV_Z;
    const d = Math.hypot(dx, dz);
    const rl = lvRadius(v.y) * 1.035;
    if (rl > 0 && d < rl) {
      const k = d > 1e-4 ? rl / d : 0;
      pos.setXYZ(i, LV_X + dx * k, v.y, LV_Z + dz * k);
    }
  }
  return bake(g);
}

// ---------------------------------------------------------------------------
// Key landmarks (scene coordinates)
// ---------------------------------------------------------------------------

const CRUX = toScene(LV_X + SEPTAL_DIR.x * 0.55, 0.46, LV_Z + SEPTAL_DIR.y * 0.4 - 0.12);
const HIS_END = toScene(LV_X + SEPTAL_DIR.x * 0.64, 0.12, LV_Z + SEPTAL_DIR.y * 0.64);
const AORTIC_VALVE = toScene(0.12, 0.52, 0.12);
const PULMONARY_VALVE = toScene(0.12, 0.82, 0.62);
const APEX = toScene(LV_X, -1.55, LV_Z);

function septalPoint(y: number, rScale: number, phiOffset = 0): THREE.Vector3 {
  const phi = SEPTAL_PHI + phiOffset;
  const r = lvRadius(y) * rScale;
  return toScene(LV_X + r * Math.sin(phi), y, LV_Z + r * Math.cos(phi));
}

// ---------------------------------------------------------------------------
// Atria (authored in scene coordinates around the base)
// ---------------------------------------------------------------------------

function buildRa() {
  const body = ellipsoid([0.44, 0.48, 0.42], [-0.98, 0.5, 0.12], [0, 0, 0.15]);
  // Right atrial appendage: a broad triangular flap reaching up and anteriorly
  // over the root of the aorta.
  const appendage = ellipsoid([0.28, 0.14, 0.24], [-0.68, 0.86, 0.46], [0.5, 0.3, -0.6], [24, 16]);
  return merge([body, appendage]);
}

function buildLa() {
  const body = ellipsoid([0.5, 0.36, 0.38], [-0.12, 0.72, -0.62], [0, 0, -0.05]);
  // Left atrial appendage: a narrow, hooked finger round the left heart border.
  const appendage = ellipsoid([0.26, 0.1, 0.13], [0.36, 0.78, -0.16], [0.2, -0.9, -0.3], [24, 16]);
  return merge([body, appendage]);
}

// ---------------------------------------------------------------------------
// Conduction system
// ---------------------------------------------------------------------------

function buildAvNode() {
  const g = new THREE.SphereGeometry(0.07, 20, 14);
  g.translate(CRUX.x, CRUX.y, CRUX.z);
  return g;
}

/** His bundle plus right and left bundle branches (the left as two fascicles). */
function buildHisPurkinje() {
  const his = tube([CRUX, CRUX.clone().lerp(HIS_END, 0.5), HIS_END], 0.03, 10);
  const rbb = tube(
    [HIS_END, septalPoint(-0.25, 1.04), septalPoint(-0.7, 1.05), septalPoint(-1.05, 1.06, 0.25)],
    0.024,
    10,
    0.6,
  );
  const lafAnterior = tube(
    [HIS_END, septalPoint(-0.2, 0.94, 0.35), septalPoint(-0.65, 0.93, 0.6), septalPoint(-1.0, 0.95, 0.85)],
    0.022,
    10,
    0.6,
  );
  const lafPosterior = tube(
    [HIS_END, septalPoint(-0.2, 0.94, -0.35), septalPoint(-0.65, 0.93, -0.6), septalPoint(-1.0, 0.95, -0.85)],
    0.022,
    10,
    0.6,
  );
  return merge([his, rbb, lafAnterior, lafPosterior]);
}

// ---------------------------------------------------------------------------
// Great vessels (scene coordinates)
// ---------------------------------------------------------------------------

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

function buildAorta() {
  return tube(
    [
      AORTIC_VALVE,
      V(AORTIC_VALVE.x - 0.12, AORTIC_VALVE.y + 0.42, AORTIC_VALVE.z + 0.08),
      V(-0.4, 1.55, 0.02),
      V(-0.16, 1.86, -0.32),
      V(0.18, 1.8, -0.7),
      V(0.32, 1.35, -0.9),
      V(0.34, 0.5, -0.98),
      V(0.32, -0.6, -0.98),
    ],
    0.16,
    18,
  );
}

function buildPulmonary() {
  const bif = V(0.02, 1.42, 0.18);
  const trunk = tube([PULMONARY_VALVE, V(PULMONARY_VALVE.x + 0.04, 1.2, 0.48), bif], 0.14, 16);
  const lpa = tube([bif, V(0.36, 1.5, 0.0), V(0.7, 1.42, -0.32)], 0.1, 12);
  // The right pulmonary artery passes behind the ascending aorta.
  const rpa = tube([bif, V(-0.28, 1.36, -0.18), V(-0.8, 1.32, -0.36)], 0.1, 12);
  return merge([trunk, lpa, rpa]);
}

function buildVenaCavae() {
  const svc = tube([V(-1.02, 2.0, 0.05), V(-1.02, 1.4, 0.08), V(-1.0, 0.95, 0.12)], 0.13, 14);
  const ivc = tube([V(-0.96, 0.12, -0.02), V(-0.92, -0.35, -0.12), V(-0.88, -0.9, -0.18)], 0.14, 14);
  return merge([svc, ivc]);
}

function buildPulmonaryVeins() {
  const la = V(-0.12, 0.72, -0.62);
  const veins: THREE.BufferGeometry[] = [];
  for (const [dx, dy] of [
    [-0.32, 0.12],
    [-0.32, -0.12],
    [0.3, 0.12],
    [0.3, -0.12],
  ] as const) {
    const start = V(la.x + dx * 1.15, la.y + dy, la.z - 0.18);
    const end = V(la.x + dx * 2.6, la.y + dy * 1.6, la.z - 0.42);
    veins.push(tube([start, start.clone().lerp(end, 0.5), end], 0.065, 10));
  }
  return merge(veins);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export interface RegionPart {
  geometry: THREE.BufferGeometry;
  opacity: number;
  /** Small, thin structures draw on top so they are not lost inside chambers. */
  overlay?: boolean;
}

/** Keys are exactly the region keys the Python conduction model emits. */
export const REGION_PARTS: Record<string, RegionPart> = {
  ra: { geometry: buildRa(), opacity: 0.5 },
  la: { geometry: buildLa(), opacity: 0.5 },
  rv: { geometry: buildRv(), opacity: 0.5 },
  lv: { geometry: buildLvApical(), opacity: 0.55 },
  lv_basal: { geometry: buildLvBasal(), opacity: 0.55 },
  septum: { geometry: buildSeptum(), opacity: 0.6 },
  av: { geometry: buildAvNode(), opacity: 1, overlay: true },
  his: { geometry: buildHisPurkinje(), opacity: 1, overlay: true },
};

/** Context only - never coloured by data. */
export const STATIC_PARTS: Array<{ key: string; geometry: THREE.BufferGeometry; colour: string; opacity: number }> = [
  { key: "aorta", geometry: buildAorta(), colour: "#c0505e", opacity: 0.42 },
  { key: "pulmonary artery", geometry: buildPulmonary(), colour: "#5577b8", opacity: 0.42 },
  { key: "venae cavae", geometry: buildVenaCavae(), colour: "#4a6aa6", opacity: 0.36 },
  { key: "pulmonary veins", geometry: buildPulmonaryVeins(), colour: "#b0505e", opacity: 0.36 },
];

/** The SA node: where each beat starts. Static marker. */
export const SA_NODE = V(-0.9, 0.94, 0.26);

function centroid(g: THREE.BufferGeometry): THREE.Vector3 {
  g.computeBoundingBox();
  return g.boundingBox!.getCenter(new THREE.Vector3());
}

/** Label anchor and outward direction for each region, in scene coordinates
 *  (before HEART_SCALE). */
export const REGION_ANCHORS: Record<string, THREE.Vector3> = {
  ra: centroid(REGION_PARTS.ra.geometry),
  la: centroid(REGION_PARTS.la.geometry),
  rv: septalPoint(-0.55, 1.5),
  lv: toScene(LV_X - SEPTAL_DIR.x * 0.5, -0.95, LV_Z - SEPTAL_DIR.y * 0.5),
  lv_basal: toScene(LV_X - SEPTAL_DIR.x * 0.68, 0.18, LV_Z - SEPTAL_DIR.y * 0.68),
  septum: septalPoint(-0.45, 1.0),
  av: CRUX.clone(),
  his: HIS_END.clone(),
  apex: APEX.clone(),
  sa: SA_NODE.clone(),
  aorta: V(-0.16, 1.9, -0.32),
  pa: V(0.36, 1.52, 0.0),
};

/** Centre of the whole heart, used to push labels outward. */
export const HEART_CENTRE = (() => {
  const box = new THREE.Box3();
  for (const p of Object.values(REGION_PARTS)) {
    p.geometry.computeBoundingBox();
    box.union(p.geometry.boundingBox!);
  }
  return box.getCenter(new THREE.Vector3());
})();
