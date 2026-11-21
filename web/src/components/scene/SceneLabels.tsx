import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import { HEART_SCALE, MV_TO_UNITS, TORSO_RADIUS } from "../../lib/geometry";
import { useStore } from "../../lib/store";
import { HEART_CENTRE, REGION_ANCHORS } from "./heartModel";
import { currentDipole } from "./VectorArrow";
import { leadVectorScene } from "./LeadProjection";

/**
 * Annotation in the 3D view.
 *
 * Without labels the scene is a coloured abstraction: a student cannot tell
 * which way is the patient's left, which end of the lead axis is the positive
 * electrode, or which blob is the left ventricle - and those three facts are
 * most of what the view is trying to teach.
 *
 * Labels are DOM elements positioned in 3D (drei's Html) rather than meshed
 * text: they stay crisp at any zoom, need no font to be fetched at runtime, and
 * the two live ones are updated by writing textContent inside useFrame, so
 * nothing re-renders React sixty times a second.
 */

const LIVE_UPDATE_MS = 60;

function Label({
  position,
  children,
  variant = "anatomy",
  innerRef,
  distanceFactor,
}: {
  position: [number, number, number];
  children?: React.ReactNode;
  variant?: "anatomy" | "chamber" | "conduction" | "lead" | "lead-negative" | "vector" | "projection";
  innerRef?: React.Ref<HTMLDivElement>;
  /** drei scales distanceFactor labels by the canvas height as well as the
   *  camera distance, so anatomy labels doubled in size whenever the 3D
   *  viewport was resized. Every label is therefore fixed-size; depth is read
   *  from the geometry, not from the type. */
  distanceFactor?: number;
}) {
  return (
    <Html
      position={position}
      center
      distanceFactor={distanceFactor}
      style={{ pointerEvents: "none" }}
      zIndexRange={[20, 10]}
    >
      <div ref={innerRef} className={`scene-label ${variant}`}>
        {children}
      </div>
    </Html>
  );
}

/**
 * Which way is up, left and forward - in the patient's terms, not the camera's.
 * A label whose axis points almost straight at (or away from) the camera would
 * land in the middle of the screen on top of the heart, so it is hidden while
 * the view looks along it (e.g. anterior/posterior in the frontal view).
 */
const ORIENTATION: Array<[string, [number, number, number]]> = [
  ["left", [1.04, 0, 0]],
  ["right", [-1.04, 0, 0]],
  ["superior", [0, 1.14, 0]],
  ["inferior", [0, -1.14, 0]],
  ["anterior", [0, 0, 0.68]],
  ["posterior", [0, 0, -0.68]],
];

function OrientationLabels() {
  const r = TORSO_RADIUS;
  const refs = useRef<Array<HTMLDivElement | null>>([]);
  const view = useMemo(() => new THREE.Vector3(), []);
  const dir = useMemo(() => new THREE.Vector3(), []);

  useFrame(({ camera }) => {
    camera.getWorldDirection(view);
    ORIENTATION.forEach(([, v], i) => {
      const el = refs.current[i];
      if (!el) return;
      dir.set(...v).normalize();
      const hidden = Math.abs(dir.dot(view)) > 0.8;
      const want = hidden ? "none" : "";
      if (el.style.display !== want) el.style.display = want;
    });
  });

  return (
    <group>
      {ORIENTATION.map(([text, v], i) => (
        <Label
          key={text}
          position={[v[0] * r, v[1] * r, v[2] * r]}
          innerRef={(el: HTMLDivElement | null) => {
            refs.current[i] = el;
          }}
        >
          {text}
        </Label>
      ))}
    </group>
  );
}

const CHAMBER_LABELS: Record<string, string> = {
  ra: "RA",
  la: "LA",
  rv: "RV",
  lv: "LV",
  septum: "septum",
  av: "AV node",
  sa: "SA node",
};

/** TIER 3: these name the model's regions, not measured anatomy. */
function ChamberLabels() {
  return (
    <group>
      {Object.entries(CHAMBER_LABELS).map(([key, text]) => {
        const anchor = REGION_ANCHORS[key];
        if (!anchor) return null;
        // Push each label outward from the centre of the heart, so labels fan
        // out around the silhouette instead of piling up in the middle where
        // the live readouts are.
        const p = anchor.clone().multiplyScalar(HEART_SCALE);
        const c = HEART_CENTRE.clone().multiplyScalar(HEART_SCALE);
        const out = p.clone().sub(c);
        if (out.lengthSq() < 1e-6) out.set(0, 1, 0);
        // The AV node sits right under the RA; send its label down and right
        // (subject's right, inferior) so the two never collide.
        if (key === "av") out.set(-1, -1.1, 0.5);
        const small = key === "av" || key === "sa";
        out.normalize().multiplyScalar(small ? 0.7 : 0.45);
        const pos = p.add(out);
        return (
          <Label key={key} variant={small ? "conduction" : "chamber"} position={[pos.x, pos.y, pos.z]}>
            {text}
          </Label>
        );
      })}
    </group>
  );
}

/**
 * The ends of the lead axis, labelled with their polarity. This is where aVR
 * stops being a rule to memorise: its positive electrode points up and to the
 * patient's right, so a vector heading down and left records as negative.
 */
function LeadAxisLabels() {
  const selectedLead = useStore((s) => s.selectedLead);
  const offsets = useStore((s) => s.electrodeOffsets);
  const data = useStore((s) => s.data);

  const ends = useMemo(() => {
    const v = leadVectorScene(selectedLead);
    const plus = v.clone().multiplyScalar(TORSO_RADIUS * 1.09);
    const minus = v.clone().multiplyScalar(-TORSO_RADIUS * 1.09);
    return { plus, minus };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLead, offsets, data]);

  if (!data) return null;
  return (
    <group>
      <Label variant="lead" position={[ends.plus.x, ends.plus.y, ends.plus.z]}>
        + {selectedLead}
      </Label>
      <Label variant="lead-negative" position={[ends.minus.x, ends.minus.y, ends.minus.z]}>
        &minus; {selectedLead}
      </Label>
    </group>
  );
}

/**
 * The two live readouts: the vector's magnitude at its tip, and the projection
 * value at the point where the perpendicular meets the lead axis - the same
 * number the pen is drawing in the trace panel at this instant.
 */
function LiveLabels() {
  const selectedLead = useStore((s) => s.selectedLead);
  const data = useStore((s) => s.data);

  const vectorGroup = useRef<THREE.Group>(null);
  const projectionGroup = useRef<THREE.Group>(null);
  const vectorText = useRef<HTMLDivElement>(null);
  const projectionText = useRef<HTMLDivElement>(null);

  const d = useMemo(() => new THREE.Vector3(), []);
  const u = useMemo(() => new THREE.Vector3(), []);
  const p = useMemo(() => new THREE.Vector3(), []);
  const lastWrite = useRef(0);

  useFrame(({ clock: three }) => {
    if (!data) return;
    currentDipole(d);
    const magnitude = d.length();
    d.multiplyScalar(MV_TO_UNITS);
    u.copy(leadVectorScene(selectedLead));
    const scalar = d.dot(u);
    p.copy(u).multiplyScalar(scalar);

    // Nudge the labels off the geometry they annotate so they do not sit on it.
    vectorGroup.current?.position.copy(d).multiplyScalar(1.22);
    projectionGroup.current?.position.copy(p).addScaledVector(u, 0.45).setY(p.y - 0.22);

    // Text is comparatively expensive to write, so do it ~16 times a second.
    const now = three.getElapsedTime() * 1000;
    if (now - lastWrite.current < LIVE_UPDATE_MS) return;
    lastWrite.current = now;
    if (vectorText.current) {
      vectorText.current.textContent = `d(t) ${magnitude.toFixed(2)} mV`;
    }
    if (projectionText.current) {
      const mv = scalar / MV_TO_UNITS;
      projectionText.current.textContent = `${selectedLead} ${mv >= 0 ? "+" : "−"}${Math.abs(mv).toFixed(2)} mV`;
      projectionText.current.dataset.sign = mv >= 0 ? "pos" : "neg";
    }
  });

  if (!data) return null;
  return (
    <group>
      <group ref={vectorGroup}>
        <Label variant="vector" position={[0, 0, 0]} innerRef={vectorText} />
      </group>
      <group ref={projectionGroup}>
        <Label variant="projection" position={[0, 0, 0]} innerRef={projectionText} />
      </group>
    </group>
  );
}

export function SceneLabels() {
  const showLabels = useStore((s) => s.showLabels);
  const showConduction = useStore((s) => s.showConduction);

  // Html mounts DOM nodes; unmounting them when labels are off is cheaper than
  // hiding them, and keeps the overlay out of the way of OrbitControls.
  useEffect(() => undefined, [showLabels]);
  if (!showLabels) return null;

  return (
    <group>
      <OrientationLabels />
      {showConduction && <ChamberLabels />}
      <LeadAxisLabels />
      <LiveLabels />
    </group>
  );
}
