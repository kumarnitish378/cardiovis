import { Suspense, useEffect, useRef } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { GizmoHelper, GizmoViewport, Grid, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { CAMERA_PRESETS, TORSO_RADIUS } from "../../lib/geometry";
import { useStore } from "../../lib/store";
import { useMediaQuery } from "../../lib/useMediaQuery";
import { HeartScene } from "./HeartScene";
import { LeadAxes, LeadProjection } from "./LeadProjection";
import { VcgLoop } from "./VcgLoop";
import { SceneLabels } from "./SceneLabels";
import { VectorArrow } from "./VectorArrow";

function CameraRig() {
  const preset = useStore((s) => s.cameraPreset);
  const { camera } = useThree();
  const controls = useRef<any>(null);

  useEffect(() => {
    const p = CAMERA_PRESETS[preset];
    if (!p) return;
    camera.position.set(...p.position);
    camera.up.set(0, 1, 0);
    camera.lookAt(0, 0, 0);
    controls.current?.target.set(0, 0, 0);
    controls.current?.update();
  }, [preset, camera]);

  return <OrbitControls ref={controls} enablePan={false} minDistance={2.5} maxDistance={18} />;
}

/** A translucent shell standing in for the torso, so the lead axes have
 *  somewhere to end and the viewer keeps their bearings. */
function TorsoShell() {
  return (
    <group>
      <mesh scale={[TORSO_RADIUS * 0.98, TORSO_RADIUS * 1.2, TORSO_RADIUS * 0.6]}>
        <sphereGeometry args={[1, 28, 18]} />
        <meshBasicMaterial color="#8a93a3" wireframe transparent opacity={0.055} depthWrite={false} />
      </mesh>
    </group>
  );
}

export function Scene() {
  const showAllLeadAxes = useStore((s) => s.showAllLeadAxes);
  const phone = useMediaQuery("(max-width: 640px)");

  return (
    <Canvas
      camera={{ position: CAMERA_PRESETS.oblique.position, fov: 42, near: 0.1, far: 100 }}
      dpr={[1, 2]}
      gl={{ antialias: true }}
      onCreated={({ gl }) => gl.setClearColor(new THREE.Color("#0a0b0d"))}
    >
      <hemisphereLight args={["#dfe8ff", "#2a1c22", 0.7]} />
      <directionalLight position={[4, 6, 8]} intensity={1.25} />
      <directionalLight position={[-6, -3, -6]} intensity={0.45} color="#a8c7fa" />

      <Suspense fallback={null}>
        <HeartScene />
        <VcgLoop />
        <VectorArrow />
        <LeadProjection />
        {showAllLeadAxes && <LeadAxes />}
        <TorsoShell />
        <SceneLabels />
      </Suspense>

      <Grid
        args={[20, 20]}
        position={[0, -TORSO_RADIUS * 1.2, 0]}
        cellColor="#16191d"
        sectionColor="#252a31"
        fadeDistance={26}
        infiniteGrid
      />
      <GizmoHelper alignment="bottom-right" margin={phone ? [36, 40] : [56, 56]}>
        <GizmoViewport
          labelColor="#0a0b0d"
          axisColors={["#ff6b57", "#3ccb94", "#7ea9ff"]}
          axisHeadScale={0.85}
          scale={phone ? 24 : 38}
        />
      </GizmoHelper>
      <CameraRig />
    </Canvas>
  );
}
