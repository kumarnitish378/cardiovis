import { useEffect, useState } from "react";
import { Controls, LeadPicker, Splitter, TraceModePicker } from "./components/Controls";
import { LeadTracePanel } from "./components/LeadTracePanel";
import { Scene } from "./components/scene/Scene";
import {
  MetricsPanel,
  ProjectionReadout,
  TeachingNote,
  WarningsPanel,
} from "./components/SidePanels";
import { LeadPlacementLab, TeachingLibrary } from "./components/TeachingLibrary";
import { ConductionBanner, TierBadge } from "./components/TierBadge";
import { useClockLoop } from "./lib/clock";
import { useStore } from "./lib/store";

type Tab = "projection" | "measurements" | "limits" | "lab";

export default function App() {
  const init = useStore((s) => s.init);
  const data = useStore((s) => s.data);
  const error = useStore((s) => s.error);
  const loading = useStore((s) => s.loading);
  const togglePlay = useStore((s) => s.togglePlay);
  const step = useStore((s) => s.step);
  const traceMode = useStore((s) => s.traceMode);
  const traceHeight = useStore((s) => s.traceHeight);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const [tab, setTab] = useState<Tab>("projection");

  useClockLoop();

  useEffect(() => {
    init();
  }, [init]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      }
      if (e.code === "ArrowLeft") step(-2);
      if (e.code === "ArrowRight") step(2);
      if (e.key === "f" || e.key === "F") toggleSidebar();   // more room for the scene
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, step, toggleSidebar]);

  return (
    <div className={`app ${sidebarOpen ? "" : "sidebar-collapsed"}`}>
      <header>
        <div className="brand">
          <h1>CardioVis</h1>
          <button
            className="disclaimer"
            onClick={() => setTab("limits")}
            title="What CardioVis can and cannot know - the full argument is in LIMITATIONS.md"
          >
            For education and research. Not a medical device. Not for diagnosis or clinical
            decision-making.
          </button>
        </div>
        <TeachingLibrary />
        {data && (
          <div className="case-meta">
            <span>{data.manifest.title}</span>
            <span className="dim">
              {data.manifest.subject.ageBand ?? "age n/a"} &middot;{" "}
              {data.manifest.subject.sex ?? "sex n/a"} &middot; {data.manifest.signal.durationS}s
              &middot; {data.manifest.signal.sampleRateHz} Hz &middot;{" "}
              {data.manifest.sourceFormat}
            </span>
          </div>
        )}
      </header>

      {error && (
        <div className="error">
          <b>Could not load this case.</b> {error}
          <div className="dim">
            Generate the data first: <code>python -m cardiovis library -o web/public/data</code>
          </div>
        </div>
      )}

      <main
        style={
          {
            "--trace-height": traceMode === "hidden" ? "0px" : `${Math.round(traceHeight)}px`,
          } as React.CSSProperties
        }
      >
        <section className="viewport">
          <div className="scene-wrap">
            {data ? <Scene /> : <div className="placeholder">{loading ? "loading…" : "no case"}</div>}
            <div className="scene-overlay-top">
              <div className="legend">
                <span className="swatch vector" /> heart vector d(t) <TierBadge tier={2} />
                <span className="swatch lead" /> lead axis
                <span className="swatch projection" /> projection onto the lead
              </div>
              <LeadPicker />
            </div>
            <ConductionBanner />
          </div>
          {traceMode === "hidden" ? (
            <div className="splitter collapsed">
              <TraceModePicker />
            </div>
          ) : (
            <>
              <Splitter />
              <LeadTracePanel />
            </>
          )}
          <Controls />
        </section>

        <button
          className="sidebar-toggle"
          onClick={toggleSidebar}
          title={sidebarOpen ? "Collapse the panel (f)" : "Show the panel (f)"}
        >
          {sidebarOpen ? "›" : "‹"}
        </button>

        <aside>
          <nav className="tabs">
            <button className={tab === "projection" ? "active" : ""} onClick={() => setTab("projection")}>
              Projection
            </button>
            <button className={tab === "measurements" ? "active" : ""} onClick={() => setTab("measurements")}>
              Measurements
            </button>
            <button className={tab === "limits" ? "active" : ""} onClick={() => setTab("limits")}>
              Limits
            </button>
            <button className={tab === "lab" ? "active" : ""} onClick={() => setTab("lab")}>
              Placement lab
            </button>
          </nav>
          <div className="panels">
            {tab === "projection" && (
              <>
                <ProjectionReadout />
                <TeachingNote />
              </>
            )}
            {tab === "measurements" && <MetricsPanel />}
            {tab === "limits" && (
              <>
                <WarningsPanel />
                <LimitsPanel />
              </>
            )}
            {tab === "lab" && <LeadPlacementLab />}
          </div>
        </aside>
      </main>
    </div>
  );
}

function LimitsPanel() {
  const data = useStore((s) => s.data);
  if (!data) return null;
  const conduction = data.manifest.conduction;

  return (
    <section className="panel">
      <h2>What CardioVis can and cannot know</h2>
      <p className="lede">
        A 12-lead ECG contains <b>8 independent signals</b> (I, II, V1-V6; the rest are
        linear combinations). A single equivalent dipole is <b>3 numbers per instant</b>. A
        spatial activation wavefront over a myocardial mesh has thousands of degrees of
        freedom. The inverse problem is massively underdetermined, so the wavefront cannot
        be recovered from these leads - by anyone, with any software.
      </p>
      <ul className="tier-list">
        <li>
          <TierBadge tier={1} /> the 12 waveforms, the sample rate, the device metadata.
        </li>
        <li>
          <TierBadge tier={2} /> d(t), the QRS axis, intervals, the QRS-T angle, loop shape -
          recovered by a published linear transform of the 8 independent leads.
        </li>
        <li>
          <TierBadge tier={3} /> the colour sweeping across the chambers. Textbook anatomy,
          this patient&rsquo;s timing. Not a reconstruction.
        </li>
      </ul>
      {conduction && (
        <>
          <h3>Where the model stands on this recording</h3>
          <p className="lede">{conduction.agreement?.verdict}</p>
          <ul className="caveats">
            {conduction.caveats.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </>
      )}
      <p className="footnote">
        The full argument, including what this implementation has and has not been
        validated against, is in <code>LIMITATIONS.md</code> and <code>METHODS.md</code> in
        the repository.
      </p>
      <p className="footnote">
        Genuine 3D reconstruction - ECGI - needs a 200-250 electrode body-surface vest plus
        patient-specific CT heart-torso geometry, and even then its spatial accuracy in
        human validation has been described as only moderate. CardioVis is not doing ECGI,
        and does not pretend to.
      </p>
    </section>
  );
}
