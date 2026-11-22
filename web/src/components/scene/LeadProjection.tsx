import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Line } from "@react-three/drei";
import * as THREE from "three";
import {
  LEAD_COLOUR,
  MV_TO_UNITS,
  PROJECTION_COLOUR,
  TORSO_RADIUS,
  anatToScene,
} from "../../lib/geometry";
import { useStore } from "../../lib/store";
import { currentDipole } from "./VectorArrow";

/**
 * THE feature (spec section 3).
 *
 * A lead is a shadow. This draws the shadow being cast: the lead axis as a fixed
 * line through the torso, the dipole arrow (drawn by VectorArrow), the dropped
 * perpendicular from the arrow tip to that axis, and the projection itself as a
 * bar along the axis whose length is the voltage the lead records at this
 * instant - the same number the pen is drawing in the trace panel.
 *
 * Lines use drei's Line (three's Line2 under the hood) rather than the plain
 * WebGL line primitive, whose width is stuck at one pixel on every desktop
 * driver - unusable for the one element the whole view is about.
 */

/** Lead unit vector in scene space, including any misplacement offset. */
export function leadVectorScene(lead: string): THREE.Vector3 {
  const { data, electrodeOffsets } = useStore.getState();
  const entry = data?.manifest.leadVectors[lead];
  if (!entry) return new THREE.Vector3(1, 0, 0);
  const v = anatToScene(entry.unitVector).normalize();
  const offsetDeg = electrodeOffsets[lead] ?? 0;
  if (offsetDeg) {
    // Rotate within the lead's own plane: frontal leads about the
    // anterior-posterior axis, precordial leads about the vertical axis.
    const axis =
      entry.plane === "frontal" ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
    v.applyAxisAngle(axis, THREE.MathUtils.degToRad(offsetDeg));
  }
  return v;
}

export function LeadProjection() {
  const selectedLead = useStore((s) => s.selectedLead);
  const data = useStore((s) => s.data);
  const offsets = useStore((s) => s.electrodeOffsets);

  const axisRef = useRef<any>(null);
  const perpRef = useRef<any>(null);
  const projRef = useRef<any>(null);
  const marker = useRef<THREE.Mesh>(null);
  const plusEnd = useRef<THREE.Mesh>(null);
  const minusEnd = useRef<THREE.Mesh>(null);

  const d = useMemo(() => new THREE.Vector3(), []);
  const p = useMemo(() => new THREE.Vector3(), []);
  const u = useMemo(() => new THREE.Vector3(), []);

  useEffect(() => {
    for (const ref of [axisRef, perpRef, projRef]) {
      const obj = ref.current;
      if (!obj) continue;
      obj.renderOrder = 10;
      obj.material.depthTest = false;
    }
    for (const ref of [marker, plusEnd, minusEnd]) {
      const obj = ref.current;
      if (!obj) continue;
      obj.renderOrder = 11;
      (obj.material as THREE.Material).depthTest = false;
    }
  }, []);

  // Axis endpoints, recomputed only when the lead or its offset changes. They
  // are passed to <Line> as props: writing them imperatively with
  // setPositions was undone by drei on any unrelated re-render, which left the
  // axis lying horizontal (the placeholder points) while its end markers were
  // correct.
  const axisEnds = useMemo(() => {
    const v = leadVectorScene(selectedLead);
    const a = v.clone().multiplyScalar(-TORSO_RADIUS);
    const b = v.clone().multiplyScalar(TORSO_RADIUS);
    return { a, b, points: [a.toArray(), b.toArray()] as [number, number, number][] };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLead, data, offsets]);
  useEffect(() => {
    plusEnd.current?.position.copy(axisEnds.b);
    minusEnd.current?.position.copy(axisEnds.a);
  }, [axisEnds]);

  useFrame(() => {
    if (!data) return;
    u.copy(leadVectorScene(selectedLead));
    currentDipole(d).multiplyScalar(MV_TO_UNITS);
    const scalar = d.dot(u);
    p.copy(u).multiplyScalar(scalar);

    perpRef.current?.geometry.setPositions([d.x, d.y, d.z, p.x, p.y, p.z]);
    projRef.current?.geometry.setPositions([0, 0, 0, p.x, p.y, p.z]);
    if (marker.current) marker.current.position.copy(p);
    if (projRef.current?.material) {
      (projRef.current.material as THREE.Material & { color: THREE.Color }).color.set(
        scalar >= 0 ? PROJECTION_COLOUR : "#ff7b7b",
      );
    }
  });

  if (!data) return null;

  return (
    <group>
      <Line
        ref={axisRef}
        points={axisEnds.points}
        color={LEAD_COLOUR}
        lineWidth={1.6}
        transparent
        opacity={0.8}
      />
      <Line
        ref={perpRef}
        points={[
          [0, 0, 0],
          [0, 0, 0],
        ]}
        color="#ffffff"
        lineWidth={1.2}
        dashed
        dashScale={6}
        transparent
        opacity={0.55}
      />
      <Line
        ref={projRef}
        points={[
          [0, 0, 0],
          [0, 0, 0],
        ]}
        color={PROJECTION_COLOUR}
        lineWidth={5}
      />
      <mesh ref={marker}>
        <sphereGeometry args={[0.1, 16, 12]} />
        <meshBasicMaterial color={PROJECTION_COLOUR} />
      </mesh>
      {/* Which end of the axis is the positive electrode - the reason aVR is
          upside down is visible here before any arithmetic. */}
      <mesh ref={plusEnd}>
        <sphereGeometry args={[0.13, 16, 12]} />
        <meshBasicMaterial color={LEAD_COLOUR} />
      </mesh>
      <mesh ref={minusEnd}>
        <sphereGeometry args={[0.09, 16, 12]} />
        <meshBasicMaterial color="#6b5a2a" />
      </mesh>
    </group>
  );
}

/** All twelve lead axes at once - the hexaxial figure, in 3D. */
export function LeadAxes() {
  const data = useStore((s) => s.data);
  const selectedLead = useStore((s) => s.selectedLead);
  if (!data) return null;

  return (
    <group>
      {Object.entries(data.manifest.leadVectors).map(([lead, entry]) => {
        if (lead === selectedLead) return null;
        const v = anatToScene(entry.unitVector).normalize().multiplyScalar(TORSO_RADIUS);
        return (
          <Line
            key={lead}
            points={[
              [-v.x, -v.y, -v.z],
              [v.x, v.y, v.z],
            ]}
            color={entry.plane === "frontal" ? "#6d7f9c" : "#7f6d9c"}
            lineWidth={1}
            transparent
            opacity={0.35}
          />
        );
      })}
    </group>
  );
}
