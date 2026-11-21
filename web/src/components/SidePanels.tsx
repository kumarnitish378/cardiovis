import { useStore } from "../lib/store";
import { TierBadge } from "./TierBadge";

function num(v: unknown, digits = 0, unit = ""): string {
  return typeof v === "number" && isFinite(v) ? `${v.toFixed(digits)}${unit}` : "-";
}

/**
 * The live numbers behind the projection view: the lead vector, the dipole, the
 * dot product, and - the honest part - the voltage the lead actually recorded
 * at this instant. They are close but not equal, because a single equivalent
 * dipole is a model of the heart, not the heart.
 */
export function ProjectionReadout() {
  const data = useStore((s) => s.data);
  const lead = useStore((s) => s.selectedLead);
  const frame = useStore((s) => s.frame);
  const showRaw = useStore((s) => s.showRaw);
  const vcgChoice = useStore((s) => s.vcgChoice);
  if (!data) return null;

  const entry = data.manifest.leadVectors[lead];
  const src = vcgChoice === "alternate" && data.vcgAlt ? data.vcgAlt : data.vcg;
  const i = Math.max(0, Math.min(data.n - 1, frame));
  const d: [number, number, number] = [src[i], src[data.n + i], src[2 * data.n + i]];
  const u = entry.unitVector;
  const projection = d[0] * u[0] + d[1] * u[1] + d[2] * u[2];

  const leadIndex = data.leadNames.indexOf(lead);
  const recorded = (showRaw ? data.leadsRaw : data.leads)[leadIndex * data.n + i];
  const magnitude = Math.hypot(d[0], d[1], d[2]);
  const cos = magnitude > 1e-9 ? projection / magnitude : 0;

  return (
    <section className="panel">
      <h2>
        Why does {lead} look like this? <TierBadge tier={2} />
      </h2>
      <p className="lede">
        A lead is a shadow. The heart&rsquo;s electrical activity at this instant is one
        vector; lead {lead} records its length along one fixed direction through the
        torso. Everything {lead} does - its sign, its size, its shape - is that
        projection changing as the vector swings.
      </p>
      <table className="kv">
        <tbody>
          <tr>
            <th>lead axis {lead}</th>
            <td>
              [{u.map((v) => v.toFixed(2)).join(", ")}]{" "}
              <span className="dim">
                {entry.plane === "frontal"
                  ? `${num(entry.angleDeg, 0, "°")} in the frontal plane`
                  : `${num(entry.angleDeg, 0, "°")} in the transverse plane`}
              </span>
            </td>
          </tr>
          <tr>
            <th>heart vector d(t)</th>
            <td>
              [{d.map((v) => v.toFixed(3)).join(", ")}] mV
              <span className="dim"> &middot; magnitude {num(magnitude, 3, " mV")}</span>
            </td>
          </tr>
          <tr>
            <th>projection d &middot; u</th>
            <td className={projection >= 0 ? "pos" : "neg"}>
              <b>{num(projection, 3, " mV")}</b>
              <span className="dim"> &middot; cos &theta; = {num(cos, 2)}</span>
            </td>
          </tr>
          <tr>
            <th>recorded {lead}</th>
            <td>
              {num(recorded, 3, " mV")}
              <span className="dim"> &middot; difference {num(recorded - projection, 3, " mV")}</span>
            </td>
          </tr>
        </tbody>
      </table>
      <p className="footnote">
        The projection and the recorded voltage are close but not identical. That gap is
        the dipole model itself: a real heart is not a single rotating arrow, and the
        transform that produced d(t) was fitted on other people&rsquo;s torsos, not this
        one. The gap is the honest size of the Tier-2 approximation.
      </p>
    </section>
  );
}

export function MetricsPanel() {
  const data = useStore((s) => s.data);
  if (!data) return null;
  const m = data.manifest.metrics;
  const i = m.intervals;
  const a = m.axes;
  const dev = i.deviceReported ?? {};

  return (
    <section className="panel">
      <h2>
        Measurements <TierBadge tier={2} detail="from this recording" />
      </h2>
      <table className="kv compact">
        <tbody>
          <tr>
            <th>heart rate</th>
            <td>{num(i.heartRateBpm, 0, " bpm")}</td>
            <td className="dim">{num(dev.rrMs && 60000 / dev.rrMs, 0, " device")}</td>
          </tr>
          <tr>
            <th>PR</th>
            <td>{num(i.prMs, 0, " ms")}</td>
            <td className="dim">{num(dev.prMs, 0, " device")}</td>
          </tr>
          <tr>
            <th>QRS</th>
            <td>{num(i.qrsMs, 0, " ms")}</td>
            <td className="dim">{num(dev.qrsMs, 0, " device")}</td>
          </tr>
          <tr>
            <th>QT</th>
            <td>{num(i.qtMs, 0, " ms")}</td>
            <td className="dim">{num(dev.qtMs, 0, " device")}</td>
          </tr>
          <tr>
            <th>QTc</th>
            <td>
              {num(i.qtcBazettMs, 0, " ms")} <span className="dim">Bazett</span>
            </td>
            <td className="dim">{num(i.qtcFridericiaMs, 0, " ms")} Fridericia</td>
          </tr>
          <tr>
            <th>frontal QRS axis</th>
            <td>{num(a.frontalQrsAxisDeg, 0, "°")}</td>
            <td className="dim">{num(a.frontalQrsAxisFromVcgDeg, 0, "°")} from VCG</td>
          </tr>
          <tr>
            <th>spatial QRS-T angle</th>
            <td>{num(a.spatialQrsTAngleDeg, 0, "°")}</td>
            <td className="dim">{num(a.peakQrsTAngleDeg, 0, "°")} peak method</td>
          </tr>
          <tr>
            <th>QRS loop</th>
            <td>{num(m.loops?.qrs?.maxMagnitudeMv, 2, " mV peak")}</td>
            <td className="dim">planarity {num(m.loops?.qrs?.planarityRatio, 3)}</td>
          </tr>
        </tbody>
      </table>
      <p className="footnote">
        {i.qtcNote} Device values come from the acquisition machine&rsquo;s own algorithm
        and are shown for comparison only - neither column is ground truth. CardioVis
        does not interpret these numbers or suggest a diagnosis.
      </p>
      {data.manifest.vcg.comparison && (
        <p className="footnote">
          Two published transforms, same recording:{" "}
          <b>{String(data.manifest.vcg.comparison.methodA)}</b> vs{" "}
          <b>{String(data.manifest.vcg.comparison.methodB)}</b> correlate{" "}
          r<sub>x</sub>={num(data.manifest.vcg.comparison.r_x, 3)}, r<sub>y</sub>=
          {num(data.manifest.vcg.comparison.r_y, 3)}, r<sub>z</sub>=
          {num(data.manifest.vcg.comparison.r_z, 3)}, differing by{" "}
          {num((data.manifest.vcg.comparison.relativeRms as number) * 100, 0, "%")} RMS. That
          spread is how much precision the Tier-2 layer actually has.
        </p>
      )}
    </section>
  );
}

export function WarningsPanel() {
  const data = useStore((s) => s.data);
  if (!data) return null;
  const warnings = data.manifest.delineation.warnings;
  const consistency = data.manifest.signal.leadConsistency;

  return (
    <section className="panel">
      <h2>What this recording does not support</h2>
      {warnings.length === 0 ? (
        <p className="lede">
          No detection or rhythm warnings. Beats are regular and consistent, the lead
          algebra checks out, and every stage of the pipeline found what it expected.
        </p>
      ) : (
        <ul className="warnings">
          {warnings.map((w) => (
            <li key={w.code} className={w.severity}>
              <b>{w.code.replace(/_/g, " ").toLowerCase()}</b>
              <span>{w.message}</span>
            </li>
          ))}
        </ul>
      )}
      {consistency.recomputed.length > 0 && (
        <p className="footnote">
          Stored lead(s) {consistency.recomputed.join(", ")} disagreed with the Einthoven
          and Goldberger definitions by more than {consistency.toleranceMv} mV and were
          recomputed from I and II.
        </p>
      )}
      {data.manifest.teaching?.synthetic && (
        <p className="footnote synthetic">
          <b>Synthetic recording.</b> {data.manifest.teaching.warning} Waveforms were built
          by summing Gaussian vector components and projecting them onto published lead
          vectors, so the &ldquo;true&rdquo; dipole is known exactly - useful for teaching
          and for testing, but this is not a person.
        </p>
      )}
      {(data.manifest.teaching as { transformNote?: string } | null)?.transformNote && (
        <p className="footnote synthetic">
          {(data.manifest.teaching as { transformNote?: string }).transformNote}
        </p>
      )}
    </section>
  );
}

export function TeachingNote() {
  const data = useStore((s) => s.data);
  const point = data?.manifest.teaching?.point;
  if (!point) return null;
  return (
    <section className="panel teaching">
      <h2>{data!.manifest.title}</h2>
      <p className="lede">{point}</p>
    </section>
  );
}
