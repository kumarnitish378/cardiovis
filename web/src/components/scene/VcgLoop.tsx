import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Line } from "@react-three/drei";
import { clock } from "../../lib/clock";
import { MV_TO_UNITS } from "../../lib/geometry";
import { beatSpan, useStore } from "../../lib/store";

/**
 * TIER 2 - the trajectory the tip of d(t) traces out: the vectorcardiogram.
 *
 * The whole current beat is drawn dim, and the last few hundred milliseconds
 * bright, so the direction of rotation is readable. The bright trail is a Line2
 * with a fixed vertex count allocated once; each frame only overwrites its
 * positions, so nothing is allocated inside the render loop.
 */

const MAX_TRAIL_POINTS = 512;

export function VcgLoop() {
  const data = useStore((s) => s.data);
  const vcgChoice = useStore((s) => s.vcgChoice);
  const trailMs = useStore((s) => s.trailMs);
  const currentBeat = useStore((s) => s.currentBeat);

  const trailRef = useRef<any>(null);
  const buffer = useMemo(() => new Float32Array(MAX_TRAIL_POINTS * 3), []);

  const source = useMemo(() => {
    if (!data) return null;
    return vcgChoice === "alternate" && data.vcgAlt ? data.vcgAlt : data.vcg;
  }, [data, vcgChoice]);

  /** Scene-space point of sample i. Anatomical y is inferior and z posterior. */
  const pointAt = useMemo(() => {
    return (i: number): [number, number, number] => {
      if (!data || !source) return [0, 0, 0];
      const n = data.n;
      return [
        (source[i] ?? 0) * MV_TO_UNITS,
        -(source[n + i] ?? 0) * MV_TO_UNITS,
        -(source[2 * n + i] ?? 0) * MV_TO_UNITS,
      ];
    };
  }, [data, source]);

  const beatPoints = useMemo(() => {
    if (!data || !source) return [[0, 0, 0] as [number, number, number]];
    const [lo, hi] = beatSpan(data, currentBeat);
    const stride = Math.max(1, Math.floor((hi - lo) / 900));
    const pts: Array<[number, number, number]> = [];
    for (let i = lo; i < hi; i += stride) pts.push(pointAt(i));
    return pts.length > 1 ? pts : [[0, 0, 0] as [number, number, number], pointAt(lo)];
  }, [data, source, currentBeat, pointAt]);

  useEffect(() => {
    // Park the trail at the start so the first frame never shows stale geometry.
    buffer.fill(0);
    trailRef.current?.geometry.setPositions(buffer);
  }, [beatPoints, buffer]);

  useFrame(() => {
    if (!data || !source || !trailRef.current) return;
    const i = Math.max(0, Math.min(data.n - 1, Math.round(clock.frame)));
    const [lo] = beatSpan(data, currentBeat);
    const wanted = Math.round((trailMs / 1000) * data.fs);
    const start = Math.max(lo, i - wanted);
    const count = Math.max(2, i - start + 1);
    const stride = Math.max(1, Math.ceil(count / MAX_TRAIL_POINTS));

    let w = 0;
    for (let s = start; s <= i && w < MAX_TRAIL_POINTS; s += stride) {
      const p = pointAt(s);
      buffer[w * 3] = p[0];
      buffer[w * 3 + 1] = p[1];
      buffer[w * 3 + 2] = p[2];
      w++;
    }
    // Collapse the unused tail onto the head: zero-length segments draw nothing.
    const last = Math.max(0, (w - 1) * 3);
    for (; w < MAX_TRAIL_POINTS; w++) {
      buffer[w * 3] = buffer[last];
      buffer[w * 3 + 1] = buffer[last + 1];
      buffer[w * 3 + 2] = buffer[last + 2];
    }
    trailRef.current.geometry.setPositions(buffer);
  });

  if (!data) return null;

  return (
    <group>
      <Line points={beatPoints} color="#3f7f72" lineWidth={1.2} transparent opacity={0.55} />
      <Line
        ref={trailRef}
        points={Array.from({ length: MAX_TRAIL_POINTS }, () => [0, 0, 0] as [number, number, number])}
        color="#7fd8c4"
        lineWidth={3}
      />
    </group>
  );
}
