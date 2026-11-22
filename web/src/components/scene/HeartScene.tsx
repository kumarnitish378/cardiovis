import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { cardiacState } from "../../lib/cardiacState";
import { clock } from "../../lib/clock";
import { HEART_SCALE, REGION_DEPOLARISED, REGION_REPOLARISED, REGION_RESTING } from "../../lib/geometry";
import { useStore } from "../../lib/store";
import {
  ATRIA_PIVOT,
  ATRIAL_KEYS,
  REGION_PARTS,
  SA_NODE,
  STATIC_PARTS,
  VENTRICLE_PIVOT,
  VENTRICULAR_KEYS,
} from "./heartModel";

/** Resting tint for the thin conduction-system structures, so they read as a
 *  distinct tissue even before the wavefront reaches them. */
const CONDUCTION_RESTING = new THREE.Color("#8a6a3a");

/** Peak linear shortening at full contraction. Ventricles shorten more along
 *  the long axis (the AV plane descends toward the apex) than across it. */
const ATRIAL_SHORTENING = 0.13;
const VENTRICULAR_RADIAL = 0.085;
const VENTRICULAR_LONG = 0.12;

/**
 * TIER 3. Every colour and every movement in here is a model, not a
 * measurement: textbook physiology, timed by this recording's fiducials.
 *
 * Colour and scale are written into objects that already exist (uniform and
 * transform writes) inside useFrame, so animation costs no React renders.
 */
export function HeartScene() {
  const data = useStore((s) => s.data);
  const showConduction = useStore((s) => s.showConduction);
  const showMotion = useStore((s) => s.showMotion);
  const regionKeys = data?.regionKeys ?? [];

  const materials = useRef<Record<string, THREE.MeshStandardMaterial>>({});
  const atria = useRef<THREE.Group>(null);
  const ventricles = useRef<THREE.Group>(null);
  const scratch = useMemo(() => new THREE.Color(), []);

  useFrame(() => {
    // --- mechanics ---------------------------------------------------------
    const st = showMotion ? cardiacState(data, clock.frame) : null;
    const a = st?.atria ?? 0;
    const v = st?.ventricles ?? 0;
    atria.current?.scale.setScalar(1 - ATRIAL_SHORTENING * a);
    ventricles.current?.scale.set(1 - VENTRICULAR_RADIAL * v, 1 - VENTRICULAR_LONG * v, 1 - VENTRICULAR_RADIAL * v);

    // --- colour ------------------------------------------------------------
    const r = regionKeys.length;
    const i = data ? Math.max(0, Math.min(data.n - 1, Math.round(clock.frame))) : 0;
    for (let k = 0; k < r; k++) {
      const key = regionKeys[k];
      const mat = materials.current[key];
      if (!mat) continue;
      const part = REGION_PARTS[key];
      const resting = part?.overlay ? CONDUCTION_RESTING : REGION_RESTING;
      if (!showConduction || !data?.conduction) {
        mat.color.copy(resting);
        mat.emissive.copy(resting);
        mat.emissiveIntensity = 0.1;
        continue;
      }
      const dep = data.conduction[k * data.n + i] ?? 0;
      const rep = data.conduction[(r + k) * data.n + i] ?? 0;
      const excited = Math.max(0, dep - rep);
      // resting -> depolarised while the wavefront passes, then back through a
      // cool tone as the region repolarises.
      scratch.copy(resting).lerp(REGION_DEPOLARISED, excited);
      if (rep > 0.02) scratch.lerp(REGION_REPOLARISED, Math.min(1, rep * (1 - excited)));
      mat.color.copy(scratch);
      mat.emissive.copy(scratch);
      mat.emissiveIntensity = 0.12 + 0.8 * excited;
    }
  });

  const regionMesh = (key: string) => {
    const part = REGION_PARTS[key];
    if (!part) return null;
    return (
      <mesh key={key} geometry={part.geometry} renderOrder={part.overlay ? 3 : 1}>
        <meshStandardMaterial
          ref={(m) => {
            if (m) materials.current[key] = m as THREE.MeshStandardMaterial;
          }}
          color={part.overlay ? CONDUCTION_RESTING : REGION_RESTING}
          emissive={part.overlay ? CONDUCTION_RESTING : REGION_RESTING}
          emissiveIntensity={0.12}
          roughness={0.5}
          metalness={0.0}
          transparent
          opacity={part.opacity}
          side={THREE.DoubleSide}
          // The anatomy is context: it must never hide the dipole arrow or the
          // VCG loop. Thin conduction structures draw over the chambers.
          depthWrite={false}
          depthTest={!part.overlay}
        />
      </mesh>
    );
  };

  return (
    <group scale={HEART_SCALE}>
      {/* Each chamber group is scaled about its own pivot: translate the pivot
          to the origin, scale, translate back. */}
      <group ref={atria} position={ATRIA_PIVOT}>
        <group position={ATRIA_PIVOT.clone().negate()}>
          {ATRIAL_KEYS.map(regionMesh)}
          <mesh position={SA_NODE} renderOrder={3}>
            <sphereGeometry args={[0.065, 16, 12]} />
            <meshStandardMaterial
              color={CONDUCTION_RESTING}
              emissive="#f5c77e"
              emissiveIntensity={0.6}
              depthTest={false}
              transparent
            />
          </mesh>
        </group>
      </group>

      <group ref={ventricles} position={VENTRICLE_PIVOT}>
        <group position={VENTRICLE_PIVOT.clone().negate()}>{VENTRICULAR_KEYS.map(regionMesh)}</group>
      </group>

      {STATIC_PARTS.map((part) => (
        <mesh key={part.key} geometry={part.geometry} renderOrder={0}>
          <meshStandardMaterial
            color={part.colour}
            roughness={0.6}
            transparent
            opacity={part.opacity}
            depthWrite={false}
          />
        </mesh>
      ))}
    </group>
  );
}
