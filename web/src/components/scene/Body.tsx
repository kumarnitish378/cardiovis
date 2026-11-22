import { useMemo } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/**
 * A human torso for reference - where the heart sits, and where the electrodes
 * are. Procedural (no third-party mesh), drawn as an X-ray-style silhouette:
 * a fresnel rim that is bright where the surface turns away from the viewer
 * and nearly invisible face-on, so it frames the heart without hiding it.
 *
 * Scene units match the lead axes (TORSO_RADIUS = 2.6): the arms sit just
 * beyond the ends of lead I, which is where the limb electrodes really are.
 */

/** [y, half-width, half-depth] from the hips to the neck. */
const PROFILE: Array<[number, number, number]> = [
  [-3.1, 1.5, 0.92],
  [-2.6, 1.42, 0.88],
  [-2.1, 1.4, 0.9],
  [-1.4, 1.52, 0.98],
  [-0.6, 1.72, 1.08],
  [0.3, 1.88, 1.14],
  [1.2, 1.98, 1.08],
  [1.8, 2.1, 0.96],
  [2.2, 2.12, 0.86],
  [2.5, 1.9, 0.76],
  [2.7, 1.25, 0.66],
  [2.86, 0.66, 0.52],
  [3.05, 0.52, 0.46],
  [3.5, 0.5, 0.45],
];

/** Superellipse cross-section: boxier than an ellipse, like a ribcage. */
function ring(w: number, d: number, segments: number, power = 2.6): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const x = Math.sign(c) * Math.pow(Math.abs(c), 2 / power) * w;
    // Slightly flatter back than front.
    const z = Math.sign(s) * Math.pow(Math.abs(s), 2 / power) * d * (s < 0 ? 0.9 : 1);
    out.push([x, z]);
  }
  return out;
}

function buildTorso(): THREE.BufferGeometry {
  const seg = 64;
  // Densify the profile so the silhouette is smooth.
  const curve = new THREE.CatmullRomCurve3(PROFILE.map(([y, w, d]) => new THREE.Vector3(w, y, d)));
  const rows = 72;
  const pts = curve.getPoints(rows);
  const positions: number[] = [];
  const indices: number[] = [];
  pts.forEach((p) => {
    for (const [x, z] of ring(p.x, p.z, seg)) positions.push(x, p.y, z);
  });
  for (let r = 0; r < rows; r++) {
    for (let i = 0; i < seg; i++) {
      const a = r * seg + i;
      const b = r * seg + ((i + 1) % seg);
      const c = (r + 1) * seg + i;
      const d = (r + 1) * seg + ((i + 1) % seg);
      indices.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

function buildArm(side: 1 | -1): THREE.BufferGeometry {
  const path = new THREE.CatmullRomCurve3([
    new THREE.Vector3(side * 1.95, 2.25, -0.05),
    new THREE.Vector3(side * 2.38, 1.7, 0.0),
    new THREE.Vector3(side * 2.6, 0.3, 0.06),
    new THREE.Vector3(side * 2.72, -1.1, 0.14),
    new THREE.Vector3(side * 2.8, -2.6, 0.28),
  ]);
  const seg = 48;
  const radial = 24;
  const g = new THREE.TubeGeometry(path, seg, 1, radial, false);
  // Taper from shoulder (0.5) to forearm (0.3).
  const pos = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i <= seg; i++) {
    const c = path.getPointAt(i / seg);
    const t = i / seg;
    const r = 0.52 - 0.22 * t;
    for (let j = 0; j <= radial; j++) {
      const idx = i * (radial + 1) + j;
      v.fromBufferAttribute(pos, idx).sub(c).multiplyScalar(r).add(c);
      pos.setXYZ(idx, v.x, v.y, v.z);
    }
  }
  g.deleteAttribute("uv");
  g.computeVertexNormals();
  return g;
}

function buildHead(): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, 40, 28);
  g.scale(0.62, 0.78, 0.7);
  g.translate(0, 4.15, 0.05);
  g.deleteAttribute("uv");
  return g;
}

const vertexShader = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform float uRim;
  uniform float uFill;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    float facing = abs(dot(normalize(vNormal), normalize(vView)));
    float rim = pow(1.0 - facing, 2.4);
    gl_FragColor = vec4(uColor, rim * uRim + uFill);
  }
`;

export function Body() {
  const geometry = useMemo(() => {
    const torso = buildTorso();
    const parts = [torso, buildArm(1), buildArm(-1), buildHead()].map((g) => {
      const n = g.index ? g.toNonIndexed() : g;
      for (const k of Object.keys(n.attributes)) if (k !== "position" && k !== "normal") n.deleteAttribute(k);
      return n;
    });
    return mergeGeometries(parts, false)!;
  }, []);

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms: {
          uColor: { value: new THREE.Color("#9fb3cc") },
          uRim: { value: 0.42 },
          uFill: { value: 0.012 },
        },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      }),
    [],
  );

  return <mesh geometry={geometry} material={material} renderOrder={-1} />;
}
