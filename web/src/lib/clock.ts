import { useEffect } from "react";
import { beatSpan, useStore } from "./store";

/**
 * The playback position lives here, outside React, deliberately.
 *
 * At 60 fps a React state update per frame would re-render every component that
 * reads the playhead - the 12-lead canvas among them - and the animation would
 * stutter on exactly the machines a lecture theatre has. So the 3D scene and the
 * trace canvas read `clock.frame` imperatively inside their own render loops,
 * and React state is updated about ten times a second, only for the text
 * readouts and the scrubber.
 */
export const clock = { frame: 0 };

const UI_SYNC_MS = 90;

export function useClockLoop(): void {
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let lastSync = 0;

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;

      const { playing, speed, loopBeat, data, currentBeat } = useStore.getState();
      if (data) {
        if (playing) {
          clock.frame += dt * data.fs * speed;
          const [lo, hi] = loopBeat ? beatSpan(data, currentBeat) : [0, data.n - 1];
          if (clock.frame > hi) clock.frame = lo;
          if (clock.frame < lo) clock.frame = lo;
        }
        if (now - lastSync > UI_SYNC_MS) {
          lastSync = now;
          const frame = Math.round(clock.frame);
          if (frame !== useStore.getState().frame) {
            useStore.setState({ frame, currentBeat: beatIndexFor(data, frame, loopBeat, currentBeat) });
          }
        }
      }
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
}

function beatIndexFor(
  data: NonNullable<ReturnType<typeof useStore.getState>["data"]>,
  frame: number,
  loopBeat: boolean,
  current: number,
): number {
  if (loopBeat) return current; // single-beat loop never leaves its beat
  const beats = data.manifest.delineation.beats;
  let idx = 0;
  for (let i = 0; i < beats.length; i++) {
    const start = beats[i].samples.pOn ?? beats[i].samples.qrsOn ?? beats[i].rSample;
    if (frame >= start) idx = i;
  }
  return idx;
}
