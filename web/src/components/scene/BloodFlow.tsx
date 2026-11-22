import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { cardiacState } from "../../lib/cardiacState";
import { clock } from "../../lib/clock";
import { HEART_SCALE } from "../../lib/geometry";
import { useStore } from "../../lib/store";
import { FLOW_PATHS } from "./heartModel";

/**
 * Blood flow, TIER 3 - illustrative.
 *
 * Particles follow the circulation through the heart: venae cavae -> RA ->
 * tricuspid -> RV -> pulmonary valve -> pulmonary arteries (deoxygenated,
 * blue), and pulmonary veins -> LA -> mitral -> LV -> aortic valve -> aorta
 * (oxygenated, red).
 *
 * Their speed is driven by the same mechanical state that makes the chambers
 * contract, so the timing comes from this recording's own beats:
 *  - ventricular systole (QRS -> end of T): the semilunar valves open and the
 *    blood waiting in the ventricles is ejected into the great arteries; the
 *    AV valves are shut, so venous return piles up in the atria;
 *  - diastole: the AV valves open and the ventricles fill, with an extra push
 *    when the atria contract (after the P wave);
 *  - between beats arterial flow coasts (the aorta's elastic recoil).
 *
 * Particles advance with *signal* time, so they freeze when playback pauses,
 * slow down with the speed control, and do not jump when you scrub.
 */

const PER_PATH = 56;
/** Fraction of the inflow path past which a particle is through the AV valve. */
const AV_VALVE = 0.62;

const COLOURS = { right: new THREE.Color("#5f8fff"), left: new THREE.Color("#ff5d55") };

const vertexShader = /* glsl */ `
  attribute vec3 color;
  uniform float uSize;
  uniform float uViewport;
  varying vec3 vColor;
  void main() {
    vColor = color;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * projectionMatrix[1][1] * uViewport * 0.5 / -mv.z;
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uOpacity;
  varying vec3 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.18, d);
    if (a < 0.01) discard;
    gl_FragColor = vec4(vColor, a * uOpacity);
  }
`;

export function BloodFlow() {
  const data = useStore((s) => s.data);
  const showFlow = useStore((s) => s.showFlow);

  const sim = useMemo(() => {
    const count = PER_PATH * FLOW_PATHS.length;
    const positions = new Float32Array(count * 3);
    const colours = new Float32Array(count * 3);
    const s = new Float32Array(count); // 0..1 inflow, 1..2 outflow
    const jitter = new Float32Array(count * 3);
    for (let p = 0; p < FLOW_PATHS.length; p++) {
      const c = COLOURS[FLOW_PATHS[p].side];
      for (let k = 0; k < PER_PATH; k++) {
        const i = p * PER_PATH + k;
        s[i] = (k / PER_PATH) * 2 + Math.random() * (2 / PER_PATH);
        colours.set([c.r, c.g, c.b], i * 3);
        // A fixed offset per particle so they stream as a column, not a line.
        const u = Math.random() * Math.PI * 2;
        const rad = Math.sqrt(Math.random()) * 0.075;
        jitter.set([Math.cos(u) * rad, (Math.random() - 0.5) * 0.06, Math.sin(u) * rad], i * 3);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colours, 3));
    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uSize: { value: 0.07 },
        uViewport: { value: 800 },
        uOpacity: { value: 0.9 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
    });
    return { geometry, material, s, jitter, count };
  }, []);

  const lastFrame = useRef<number | null>(null);
  const tmp = useMemo(() => new THREE.Vector3(), []);

  useFrame((state) => {
    if (!showFlow || !data) return;
    sim.material.uniforms.uViewport.value = state.size.height * state.gl.getPixelRatio();

    // Advance by signal time since the last frame (0 when paused or scrubbing).
    const f = clock.frame;
    let dt = lastFrame.current === null ? 0 : (f - lastFrame.current) / data.fs;
    lastFrame.current = f;
    if (dt < 0 || dt > 0.25) dt = 0;

    const st = cardiacState(data, f);
    // Flow follows volume change: ejection while the ventricles shorten,
    // filling while they relax, plus the atrial kick.
    const eject = st.available ? Math.max(0, st.dVentricles) : 0.8;
    const relax = st.available ? Math.max(0, -st.dVentricles) : 0.8;
    const kick = st.available ? Math.max(0, st.dAtria) : 0;
    const systole = st.available ? st.ventricles : 0.3;

    // Path fractions per second of signal time.
    const venous = 0.3 + 0.2 * (1 - systole); // continuous venous return
    const filling = (0.12 + 0.3 * relax + 0.12 * kick) * (1 - 0.9 * systole); // AV valves shut in systole
    const ejection = 0.03 + 0.85 * eject; // semilunar valves open while ejecting
    const coast = 0.2 + 0.45 * eject; // arterial run-off (elastic recoil)

    const pos = sim.geometry.attributes.position as THREE.BufferAttribute;
    for (let p = 0; p < FLOW_PATHS.length; p++) {
      const path = FLOW_PATHS[p];
      for (let k = 0; k < PER_PATH; k++) {
        const i = p * PER_PATH + k;
        let s = sim.s[i];
        let v: number;
        if (s < AV_VALVE) v = venous;
        else if (s < 1) v = filling;
        else if (s < 1.35) v = ejection;
        else v = coast;
        s += v * dt;
        if (s >= 2) s -= 2;
        sim.s[i] = s;

        if (s < 1) path.inflow.getPointAt(Math.min(1, s), tmp);
        else path.outflow.getPointAt(Math.min(1, s - 1), tmp);
        pos.setXYZ(i, tmp.x + sim.jitter[i * 3], tmp.y + sim.jitter[i * 3 + 1], tmp.z + sim.jitter[i * 3 + 2]);
      }
    }
    pos.needsUpdate = true;
  });

  if (!showFlow || !data) return null;
  return (
    <group scale={HEART_SCALE}>
      <points geometry={sim.geometry} material={sim.material} renderOrder={4} frustumCulled={false} />
    </group>
  );
}
