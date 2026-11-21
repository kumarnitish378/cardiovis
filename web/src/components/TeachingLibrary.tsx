import { useStore } from "../lib/store";

export function TeachingLibrary() {
  const cases = useStore((s) => s.cases);
  const caseId = useStore((s) => s.caseId);
  const selectCase = useStore((s) => s.selectCase);
  const loading = useStore((s) => s.loading);

  return (
    <div className="library">
      <label htmlFor="case-select">case</label>
      <select
        id="case-select"
        value={caseId ?? ""}
        disabled={loading}
        onChange={(e) => selectCase(e.target.value)}
      >
        {cases.map((c) => (
          <option key={c.path} value={c.path}>
            {c.title}
            {c.qrsMs ? ` - QRS ${Math.round(c.qrsMs)} ms` : ""}
            {c.heartRateBpm ? `, ${Math.round(c.heartRateBpm)} bpm` : ""}
          </option>
        ))}
      </select>
      {loading && <span className="dim">loading…</span>}
    </div>
  );
}

/**
 * Lead placement lab: rotate a lead's axis away from where it should be and
 * watch the projection change. The traces in the panel are the real recording
 * and do not move - what moves is the lead vector, which is exactly the point:
 * misplacing an electrode changes the direction you are measuring along, and
 * therefore changes every deflection in that lead.
 */
export function LeadPlacementLab() {
  const data = useStore((s) => s.data);
  const lead = useStore((s) => s.selectedLead);
  const offsets = useStore((s) => s.electrodeOffsets);
  const setOffset = useStore((s) => s.setElectrodeOffset);
  const reset = useStore((s) => s.resetElectrodes);
  // Subscribed, not read from getState: this panel has to re-render as the
  // playhead moves, or its numbers silently freeze at whatever the frame was
  // when the tab was opened.
  const frame = useStore((s) => s.frame);
  if (!data) return null;

  const entry = data.manifest.leadVectors[lead];
  const offset = offsets[lead] ?? 0;
  const i = Math.max(0, Math.min(data.n - 1, frame));
  const d: [number, number, number] = [data.vcg[i], data.vcg[data.n + i], data.vcg[2 * data.n + i]];

  const rad = (offset * Math.PI) / 180;
  const u = entry.unitVector;
  // Rotate in the lead's own plane, matching LeadProjection.
  const rotated: [number, number, number] =
    entry.plane === "frontal"
      ? [u[0] * Math.cos(rad) - u[1] * Math.sin(rad), u[0] * Math.sin(rad) + u[1] * Math.cos(rad), u[2]]
      : [u[0] * Math.cos(rad) + u[2] * Math.sin(rad), u[1], -u[0] * Math.sin(rad) + u[2] * Math.cos(rad)];

  const correct = d[0] * u[0] + d[1] * u[1] + d[2] * u[2];
  const wrong = d[0] * rotated[0] + d[1] * rotated[1] + d[2] * rotated[2];

  return (
    <section className="panel">
      <h2>Lead placement lab</h2>
      <p className="lede">
        Move the {lead} electrode off its correct position and watch what the lead would
        record instead.
      </p>
      <div className="row">
        <input
          type="range"
          min={-60}
          max={60}
          step={1}
          value={offset}
          onChange={(e) => setOffset(lead, Number(e.target.value))}
        />
        <span className="readout">
          {offset > 0 ? "+" : ""}
          {offset}&deg;
        </span>
        <button onClick={reset}>reset all</button>
      </div>
      <table className="kv compact">
        <tbody>
          <tr>
            <th>correct placement</th>
            <td>{correct.toFixed(3)} mV</td>
          </tr>
          <tr>
            <th>displaced by {offset}&deg;</th>
            <td className={Math.sign(wrong) !== Math.sign(correct) ? "neg" : ""}>
              {wrong.toFixed(3)} mV
              {Math.sign(wrong) !== Math.sign(correct) && correct !== 0 && (
                <span className="dim"> &middot; the deflection has inverted</span>
              )}
            </td>
          </tr>
        </tbody>
      </table>
      <p className="footnote">
        This rotates the lead vector only. A real misplacement also moves the electrode
        relative to the heart, which changes the lead vector&rsquo;s length and the torso
        volume conductor around it - so treat this as the direction half of the story.
      </p>
    </section>
  );
}
