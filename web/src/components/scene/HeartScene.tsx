import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { clock } from "../../lib/clock";
import { HEART_SCALE, REGION_DEPOLARISED, REGION_REPOLARISED, REGION_RESTING } from "../../lib/geometry";
import { useStore } from "../../lib/store";
import { REGION_SHAPES, STATIC_PARTS } from "./heartModel";

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
    if (!data?.conduction) return;
    const i = Math.max(0, Math.min(data.n - 1, Math.round(clock.frame)));
    const r = regionKeys.length;
    for (let k = 0; k < r; k++) {
      const mat = materials.current[regionKeys[k]];
      if (!mat) continue;
      if (!showConduction) {
        mat.color.copy(REGION_RESTING);
        mat.emissive.copy(REGION_RESTING);
        mat.emissiveIntensity = 0.12;
        continue;
      }
      const dep = data.conduction[k * data.n + i] ?? 0;
      const rep = data.conduction[(r + k) * data.n + i] ?? 0;
      const excited = Math.max(0, dep - rep);
      // resting -> depolarised while the wavefront passes, then back through a
      // cool tone as the region repolarises.
      scratch.copy(REGION_RESTING).lerp(REGION_DEPOLARISED, excited);
      if (rep > 0.02) scratch.lerp(REGION_REPOLARISED, Math.min(1, rep * (1 - excited)));
      mat.color.copy(scratch);
      mat.emissive.copy(scratch);
      mat.emissiveIntensity = 0.15 + 0.85 * excited;
    }
  });

  return (
    <group scale={HEART_SCALE}>
      {Object.entries(REGION_SHAPES).map(([key, shape]) => (
        <mesh
          key={key}
          position={shape.position}
          rotation={shape.rotation ?? [0, 0, 0]}
          scale={shape.scale}
          castShadow={false}
        >
          <sphereGeometry args={[1, 28, 20]} />
          <meshStandardMaterial
            ref={(m) => {
              if (m) materials.current[key] = m as THREE.MeshStandardMaterial;
            }}
            color={REGION_RESTING}
            emissive={REGION_RESTING}
            emissiveIntensity={0.15}
            roughness={0.55}
            metalness={0.05}
            transparent
            opacity={shape.opacity ?? 0.5}
            // Without this the chambers hide the dipole arrow and the VCG loop,
            // which is precisely backwards: the anatomy is the context here.
            depthWrite={false}
          />
        </mesh>
      ))}

      {STATIC_PARTS.map((part) => (
        <mesh key={part.key} position={part.shape.position} scale={part.shape.scale}>
          <sphereGeometry args={[1, 16, 12]} />
          <meshStandardMaterial color={part.colour} roughness={0.7} transparent opacity={0.3} depthWrite={false} />
        </mesh>
      ))}
    </group>
  );
}
