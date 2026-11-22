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
        Why {lead} looks like this <TierBadge tier={2} />
      </h2>
      <p className="lede">
        {lead} records the heart vector&rsquo;s shadow on its own axis.
      </p>
      <table className="kv">
        <tbody>
          <tr>
            <th>Axis</th>
            <td>
              {num(entry.angleDeg, 0, "°")} <span className="dim">{entry.plane === "frontal" ? "frontal" : "horizontal"}</span>
            </td>
          </tr>
          <tr>
            <th>Vector</th>
            <td>{num(magnitude, 2, " mV")}</td>
          </tr>
          <tr>
            <th>Projection</th>
            <td className={projection >= 0 ? "pos" : "neg"}>
              <b>{num(projection, 2, " mV")}</b> <span className="dim">cos θ {num(cos, 2)}</span>
            </td>
          </tr>
          <tr>
            <th>Recorded</th>
            <td>
              {num(recorded, 2, " mV")} <span className="dim">Δ {num(recorded - projection, 2)}</span>
            </td>
          </tr>
        </tbody>
      </table>
      <details className="more">
        <summary>Why they differ</summary>
        <p>
          A real heart is not a single rotating arrow, and the transform behind d(t) was
          fitted on other people&rsquo;s torsos. The gap is the honest size of the Tier-2
          approximation.
        </p>
        <p className="mono dim">
          u = [{u.map((v) => v.toFixed(2)).join(", ")}] · d = [{d.map((v) => v.toFixed(3)).join(", ")}] mV
        </p>
      </details>
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
        Measurements <TierBadge tier={2} />
      </h2>
      <table className="kv compact">
        <tbody>
          <tr>
            <th>Rate</th>
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
            <th>QRS axis</th>
            <td>{num(a.frontalQrsAxisDeg, 0, "°")}</td>
            <td className="dim">{num(a.frontalQrsAxisFromVcgDeg, 0, "°")} from VCG</td>
          </tr>
          <tr>
            <th>QRS-T angle</th>
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
      <details className="more">
        <summary>About these numbers</summary>
        <p>
          {i.qtcNote} The grey column is the acquisition device&rsquo;s own value, for
          comparison only - neither is ground truth. CardioVis does not interpret these
          numbers.
        </p>
      {data.manifest.vcg.comparison && (
        <p>
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
      </details>
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
      <h2>This recording</h2>
      {warnings.length === 0 ? (
        <p className="lede">No warnings. Beats are regular and the leads are consistent.</p>
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
        <details className="more">
          <summary>Synthetic recording - not a person</summary>
          <p>
            {data.manifest.teaching.warning} Waveforms were built by projecting a known
            dipole onto published lead vectors, so the true dipole is known exactly.
          </p>
          {(data.manifest.teaching as { transformNote?: string } | null)?.transformNote && (
            <p>{(data.manifest.teaching as { transformNote?: string }).transformNote}</p>
          )}
        </details>
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
