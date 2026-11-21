import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Line } from "@react-three/drei";
import * as THREE from "three";
import { clock } from "../../lib/clock";
import { MV_TO_UNITS, VECTOR_COLOUR, anatToSceneInto } from "../../lib/geometry";
import { useStore } from "../../lib/store";

/** Current dipole, in scene coordinates. Shared by the arrow and the projection. */
export function currentDipole(out: THREE.Vector3): THREE.Vector3 {
  const { data, vcgChoice, showModelDipole } = useStore.getState();
  if (!data) return out.set(0, 0, 0);
  const src = showModelDipole
    ? (data.modelVcg ?? data.vcg)
    : vcgChoice === "alternate" && data.vcgAlt
      ? data.vcgAlt
      : data.vcg;
  const i = Math.max(0, Math.min(data.n - 1, Math.round(clock.frame)));
  const n = data.n;
  let x = src[i] ?? 0;
  let y = src[n + i] ?? 0;
  let z = src[2 * n + i] ?? 0;
  if (showModelDipole && data.modelVcg) {
    // The model dipole has arbitrary units; scale it so it is comparable on
    // screen with the measured one, and say so in the UI.
    const s = 0.35;
    x *= s;
    y *= s;
    z *= s;
  }
  return anatToSceneInto(out, x, y, z);
}

/**
 * TIER 2 - the instantaneous heart vector d(t), drawn from the electrical
 * centre of the heart, length proportional to magnitude.
 *
 * Drawn as a thick Line2 plus a cone rather than three's ArrowHelper, whose
 * shaft is a one-pixel line on every desktop driver. Both are rendered with
 * depth testing off: the chambers are context, and an arrow hidden behind them
 * explains nothing.
 */
export function VectorArrow() {
  const shaft = useRef<any>(null);
  const head = useRef<THREE.Mesh>(null);
  const group = useRef<THREE.Group>(null);

  const vec = useMemo(() => new THREE.Vector3(), []);
  const dir = useMemo(() => new THREE.Vector3(), []);
  const up = useMemo(() => new THREE.Vector3(0, 1, 0), []);
  const quat = useMemo(() => new THREE.Quaternion(), []);

  useEffect(() => {
    if (shaft.current) {
      shaft.current.renderOrder = 12;
      shaft.current.material.depthTest = false;
    }
    if (head.current) {
      head.current.renderOrder = 12;
      (head.current.material as THREE.Material).depthTest = false;
    }
  }, []);

  useFrame(() => {
    if (!group.current) return;
    currentDipole(vec);
    const length = vec.length() * MV_TO_UNITS;
    group.current.visible = length > 1e-3;
    if (!group.current.visible) return;

    dir.copy(vec).normalize();
    const headLength = Math.min(0.3, Math.max(0.08, length * 0.22));
    const tip = dir.clone().multiplyScalar(length);
    const shoulder = dir.clone().multiplyScalar(Math.max(0, length - headLength));

    shaft.current?.geometry.setPositions([0, 0, 0, shoulder.x, shoulder.y, shoulder.z]);
    if (head.current) {
      head.current.position.copy(shoulder.clone().add(tip).multiplyScalar(0.5));
      quat.setFromUnitVectors(up, dir);
      head.current.quaternion.copy(quat);
      head.current.scale.set(1, Math.max(0.2, headLength / 0.2), 1);
    }
  });

  return (
    <group ref={group}>
      <Line
        ref={shaft}
        points={[
          [0, 0, 0],
          [0, 0.001, 0],
        ]}
        color={VECTOR_COLOUR}
        lineWidth={5}
      />
      <mesh ref={head}>
        <coneGeometry args={[0.09, 0.2, 18]} />
        <meshBasicMaterial color={VECTOR_COLOUR} />
      </mesh>
    </group>
  );
}
