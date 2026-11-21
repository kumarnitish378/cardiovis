import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { clock } from "../../lib/clock";
import { HEART_SCALE, REGION_DEPOLARISED, REGION_REPOLARISED, REGION_RESTING } from "../../lib/geometry";
import { useStore } from "../../lib/store";
import { REGION_PARTS, SA_NODE, STATIC_PARTS } from "./heartModel";

/** Resting tint for the thin conduction-system structures, so they read as a
 *  distinct tissue even before the wavefront reaches them. */
const CONDUCTION_RESTING = new THREE.Color("#8a6a3a");

/**
 * TIER 3. Every colour in here is a model, not a measurement.
 *
 * Colour is written into the material that already exists (a uniform write),
 * never by assigning a new material per frame, and the whole update runs off
 * `clock.frame` inside useFrame so it costs no React renders.
 */
export function HeartScene() {
  const data = useStore((s) => s.data);
  const showConduction = useStore((s) => s.showConduction);
  const regionKeys = data?.regionKeys ?? [];

  const materials = useRef<Record<string, THREE.MeshStandardMaterial>>({});
  const scratch = useMemo(() => new THREE.Color(), []);

  useFrame(() => {
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

  return (
    <group scale={HEART_SCALE}>
      {Object.entries(REGION_PARTS).map(([key, part]) => (
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
      ))}

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
  );
}
