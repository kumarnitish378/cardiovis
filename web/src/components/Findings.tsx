import { useMemo } from "react";
import { intervalRows, measureLeads, TERRITORIES, type LeadMeasure } from "../lib/ecgMeasure";
import { useStore } from "../lib/store";

const fmt = (v: number | null | undefined, d = 0) => (v == null || !Number.isFinite(v) ? "–" : v.toFixed(d));

/**
 * Measurements for reading the tracing: intervals against reference ranges,
 * the frontal axis on a hexaxial wheel, and per-lead ST deviation as a heat
 * grid grouped by territory. Flags mark values outside a reference range; the
 * reading itself is the clinician's.
 */
export function Findings() {
  const data = useStore((s) => s.data);
  const showRaw = useStore((s) => s.showRaw);
  const selectedLead = useStore((s) => s.selectedLead);
  const setSelectedLead = useStore((s) => s.setSelectedLead);

  const leads = useMemo(() => (data ? measureLeads(data, showRaw) : []), [data, showRaw]);
  if (!data) return null;
  const rows = intervalRows(data);
  const byLead = new Map(leads.map((m) => [m.lead, m]));
  const a = data.manifest.metrics.axes;

  return (
    <>
      <section className="panel">
        <h2>Intervals</h2>
        <table className="kv findings">
          <thead>
            <tr>
              <th />
              <th>Value</th>
              <th>Ref.</th>
              <th className="dim">Device</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className={`flag-${r.flag}`}>
                <th>{r.label}</th>
                <td>
                  <span className="val">
                    {fmt(r.value)}
                    <small>{r.unit}</small>
                  </span>
                  {(r.flag === "high" || r.flag === "low") && (
                    <span className="flag" title={`Outside ${r.range}`}>
                      {r.flag === "high" ? "▲" : "▼"}
                    </span>
                  )}
                </td>
                <td className="dim">{r.range}</td>
                <td className="dim">{fmt(r.device)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h2>Frontal axis</h2>
        <AxisWheel qrs={a.frontalQrsAxisDeg} t={a.frontalTAxisFromVcgDeg} p={a.deviceReported?.pAxisDeg} />
      </section>

      <section className="panel">
        <h2>ST deviation at J point</h2>
        <div className="st-grid">
          {TERRITORIES.map((t) => (
            <div key={t.name} className="st-territory">
              <span className="eyebrow">{t.name}</span>
              <div className="st-cells">
                {t.leads.map((l) => {
                  const m = byLead.get(l);
                  return m ? (
                    <StCell key={l} m={m} active={l === selectedLead} onClick={() => setSelectedLead(l)} />
                  ) : null;
                })}
              </div>
            </div>
          ))}
        </div>
        <details className="more">
          <summary>Amplitudes and ST60 per lead</summary>
          <table className="kv findings compact">
            <thead>
              <tr>
                <th />
                <th>R</th>
                <th>S</th>
                <th>ST J</th>
                <th>ST60</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((m) => (
                <tr key={m.lead} className={m.stFlag ? "flag-high" : ""}>
                  <th>{m.lead}</th>
                  <td>{fmt(m.r, 2)}</td>
                  <td>{fmt(m.s, 2)}</td>
                  <td>{fmt(m.stJ, 2)}</td>
                  <td>{fmt(m.st60, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            mV, median across beats; baseline = PR segment. Elevation thresholds 0.1 mV
            (V2–V3: 0.15–0.25 mV by sex and age), depression 0.05 mV.
          </p>
        </details>
      </section>

      <p className="footnote">Automated measurements, not clinically validated. Verify on the tracing.</p>
    </>
  );
}

function StCell({ m, active, onClick }: { m: LeadMeasure; active: boolean; onClick: () => void }) {
  // Colour by deviation relative to the lead's threshold: full colour at 2x.
  const v = m.stJ;
  const ref = v >= 0 ? m.stThreshold : 0.05;
  const k = Number.isFinite(v) ? Math.min(1, Math.abs(v) / (ref * 2)) : 0;
  const style = {
    "--heat": `${Math.round(k * 100)}%`,
  } as React.CSSProperties;
  return (
    <button
      className={`st-cell ${v >= 0 ? "up" : "down"} ${m.stFlag ? "flagged" : ""} ${active ? "active" : ""}`}
      style={style}
      onClick={onClick}
      title={`${m.lead}: ST at J ${fmt(v, 2)} mV, at J+60 ${fmt(m.st60, 2)} mV (threshold +${m.stThreshold} / −0.05 mV)`}
    >
      <span className="st-lead">{m.lead}</span>
      <span className="st-val">
        {Number.isFinite(v) ? `${v >= 0 ? "+" : "−"}${Math.abs(v * 10).toFixed(1)}` : "–"}
        <small>mm</small>
      </span>
    </button>
  );
}

/** Hexaxial reference wheel with the measured axes. Angles in the ECG
 *  convention: 0° = lead I (patient's left), +90° = aVF (down). */
function AxisWheel({ qrs, t, p }: { qrs?: number; t?: number; p?: number }) {
  const R = 70;
  const c = 90;
  const pt = (deg: number, r: number) => {
    const rad = (deg * Math.PI) / 180;
    return [c + r * Math.cos(rad), c + r * Math.sin(rad)] as const;
  };
  const arc = (from: number, to: number, r: number) => {
    const [x0, y0] = pt(from, r);
    const [x1, y1] = pt(to, r);
    const large = Math.abs(to - from) > 180 ? 1 : 0;
    return `M ${c} ${c} L ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} Z`;
  };
  const leads: Array<[string, number]> = [
    ["I", 0],
    ["II", 60],
    ["III", 120],
    ["aVF", 90],
    ["aVL", -30],
    ["aVR", -150],
  ];
  const vector = (deg: number | undefined, cls: string, label: string) => {
    if (deg == null || !Number.isFinite(deg)) return null;
    const [x, y] = pt(deg, R - 6);
    const [lx, ly] = pt(deg, R + 14);
    return (
      <g className={`axis-vec ${cls}`}>
        <line x1={c} y1={c} x2={x} y2={y} />
        <circle cx={x} cy={y} r={3.5} />
        <text x={lx} y={ly} textAnchor="middle" dominantBaseline="middle">
          {label}
        </text>
      </g>
    );
  };
  return (
    <div className="axis-wheel">
      <svg viewBox="0 0 180 180" role="img" aria-label={`QRS axis ${fmt(qrs)} degrees`}>
        <path d={arc(-30, 90, R)} className="axis-normal" />
        <circle cx={c} cy={c} r={R} className="axis-ring" />
        {leads.map(([name, deg]) => {
          const [x0, y0] = pt(deg + 180, R);
          const [x1, y1] = pt(deg, R);
          const [lx, ly] = pt(deg, R + 11);
          return (
            <g key={name} className="axis-lead">
              <line x1={x0} y1={y0} x2={x1} y2={y1} />
              <text x={lx} y={ly} textAnchor="middle" dominantBaseline="middle">
                {name}
              </text>
            </g>
          );
        })}
        {vector(t, "t", "T")}
        {vector(p, "p", "P")}
        {vector(qrs, "qrs", "QRS")}
      </svg>
      <dl className="axis-values">
        <div>
          <dt>QRS</dt>
          <dd>{fmt(qrs)}°</dd>
        </div>
        <div>
          <dt>T</dt>
          <dd>{fmt(t)}°</dd>
        </div>
        {p != null && (
          <div>
            <dt>P</dt>
            <dd>{fmt(p)}°</dd>
          </div>
        )}
        <div className="dim">
          <dt>Normal</dt>
          <dd>−30…+90°</dd>
        </div>
      </dl>
    </div>
  );
}
