import { useEffect, useState } from "react";
import {
  Controls,
  LeadPicker,
  SceneOptions,
  Splitter,
  StageReadout,
  TraceModePicker,
  TraceZoomControls,
  ViewPresets,
} from "./components/Controls";
import { BrandMark, Icon } from "./components/Icon";
import { ResizeHandle, usePersistentSize } from "./components/ResizeHandle";
import { LeadTracePanel } from "./components/LeadTracePanel";
import { Scene } from "./components/scene/Scene";
import { MetricsPanel, ProjectionReadout, TeachingNote, WarningsPanel } from "./components/SidePanels";
import { LeadPlacementLab, TeachingLibrary } from "./components/TeachingLibrary";
import { ConductionBanner, TierBadge } from "./components/TierBadge";
import { useClockLoop } from "./lib/clock";
import { useStore } from "./lib/store";
import { COMPACT_QUERY, useMediaQuery } from "./lib/useMediaQuery";

type Tab = "traces" | "explain" | "measure" | "limits" | "lab";

const TAB_LABELS: Record<Tab, string> = {
  traces: "Traces",
  explain: "Explain",
  measure: "Measure",
  limits: "Limits",
  lab: "Lab",
};

/**
 * Layout
 *
 *   wide (>= 1100 px)                      compact (< 1100 px: tablet portrait, phone)
 *   +-----------------------------+----+   +----------------------+
 *   | top bar                          |   | top bar              |
 *   +----+------------------------+----+   +----------------------+
 *   |lead|  3D stage              |insp|   | 3D stage             |
 *   |rail|                        |ector|  +----------------------+
 *   +----+------------------------+    |   | lead strip           |
 *   | transport                   |    |   | transport            |
 *   | traces                      |    |   | tabs: Traces Explain |
 *   +-----------------------------+----+   | dock                 |
 *                                          +----------------------+
 */
const inspectorMax = () => Math.min(640, Math.round(window.innerWidth * 0.45));
const dockMax = () => Math.round(window.innerHeight * 0.75);
const defaultDock = () => Math.round(Math.min(480, window.innerHeight * 0.4));

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
  const compact = useMediaQuery(COMPACT_QUERY);
  const [tab, setTab] = useState<Tab>("explain");

  // Resizable panes: the inspector's width (wide) and the dock's height (compact).
  const [inspectorW, setInspectorW] = usePersistentSize("cardiovis.inspectorW", 320, 260, inspectorMax);
  const [dockH, setDockH] = usePersistentSize("cardiovis.dockH", defaultDock(), 160, dockMax);

  useClockLoop();

  useEffect(() => {
    init();
  }, [init]);

  // "Traces" is a tab only in the compact layout; leaving it, fall back.
  useEffect(() => {
    if (!compact && tab === "traces") setTab("explain");
  }, [compact, tab]);
  useEffect(() => {
    if (compact) setTab("traces");
  }, [compact]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      }
      if (e.code === "ArrowLeft") step(-2);
      if (e.code === "ArrowRight") step(2);
      if (e.key === "f" || e.key === "F") toggleSidebar();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, step, toggleSidebar]);

  const openLimits = () => {
    setTab("limits");
    if (!compact && !sidebarOpen) toggleSidebar();
  };

  const tabs: Tab[] = compact
    ? ["traces", "explain", "measure", "limits", "lab"]
    : ["explain", "measure", "limits", "lab"];

  const panels = (
    <>
      {tab === "explain" && (
        <>
          <ProjectionReadout />
          <TeachingNote />
        </>
      )}
      {tab === "measure" && <MetricsPanel />}
      {tab === "limits" && (
        <>
          <WarningsPanel />
          <LimitsPanel />
        </>
      )}
      {tab === "lab" && <LeadPlacementLab />}
    </>
  );

  const tabBar = (
    <nav className="tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t}
          role="tab"
          aria-selected={tab === t}
          className={tab === t ? "active" : ""}
          onClick={() => setTab(t)}
        >
          {TAB_LABELS[t]}
        </button>
      ))}
    </nav>
  );

  const m = data?.manifest;

  return (
    <div
      className={`app ${compact ? "is-compact" : "is-wide"} ${sidebarOpen ? "" : "sidebar-collapsed"}`}
      style={
        {
          "--trace-height": traceMode === "hidden" ? "0px" : `${Math.round(traceHeight)}px`,
          "--inspector-w": `${inspectorW}px`,
          "--dock-h": `${dockH}px`,
        } as React.CSSProperties
      }
    >
      <header className="topbar">
        <div className="brand">
          <BrandMark />
          <span className="wordmark">CardioVis</span>
        </div>
        <span className="topbar-divider" aria-hidden />
        <TeachingLibrary />
        {m && (
          <div className="case-meta" aria-label="Recording details">
            <span>
              {m.subject.ageBand ?? "age n/a"} · {m.subject.sex ?? "sex n/a"}
            </span>
            <span>{m.signal.durationS} s</span>
            {m.teaching?.synthetic && <span className="synthetic">synthetic</span>}
          </div>
        )}
        <div className="topbar-end">
          <button
            className="disclaimer"
            onClick={openLimits}
            title="For education and research. Not a medical device. Not for diagnosis or clinical decision-making."
            aria-label="Not a medical device - for education and research only"
          >
            <Icon name="info" size={16} />
            <span className="long">Not a medical device</span>
          </button>
          {!compact && (
            <button
              className={`icon-btn sidebar-toggle ${sidebarOpen ? "on" : ""}`}
              onClick={toggleSidebar}
              aria-label={sidebarOpen ? "Hide panel" : "Show panel"}
              title={sidebarOpen ? "Hide panel (f)" : "Show panel (f)"}
            >
              <Icon name="panel" />
            </button>
          )}
        </div>
      </header>

      {error && (
        <div className="error">
          <b>Could not load this case.</b> {error}
          <div className="dim">
            Generate the data first: <code>python -m cardiovis library -o web/public/data</code>
          </div>
        </div>
      )}

      <main className="workspace">
        <section className="stage-column">
          <div className="stage">
            {!compact && <LeadPicker />}
            <div className="scene-wrap">
              {data ? <Scene /> : <div className="placeholder">{loading ? "Loading…" : "No case"}</div>}
              <div className="stage-top">
                <StageReadout />
                <div className="stage-tools">
                  <ViewPresets />
                  <SceneOptions />
                </div>
              </div>
              <div className="stage-bottom">
                <ConductionBanner onExplain={openLimits} />
              </div>
            </div>
          </div>

          {compact && <LeadPicker />}
          <Controls />

          {!compact &&
            (traceMode === "hidden" ? (
              <div className="splitter collapsed">
                <TraceModePicker />
              </div>
            ) : (
              <>
                <Splitter />
                <LeadTracePanel />
              </>
            ))}

          {compact && (
            <div className="dock">
              <ResizeHandle
                axis="y"
                invert
                value={dockH}
                onChange={setDockH}
                onReset={() => setDockH(defaultDock())}
                label="Resize panel"
                className="dock-handle"
              />
              {tabBar}
              {tab === "traces" ? (
                <div className="dock-traces">
                  <div className="trace-toolbar">
                    <TraceZoomControls />
                    <TraceModePicker />
                  </div>
                  <LeadTracePanel />
                </div>
              ) : (
                <div className="panels">{panels}</div>
              )}
            </div>
          )}
        </section>

        {!compact && sidebarOpen && (
          <ResizeHandle
            axis="x"
            invert
            value={inspectorW}
            onChange={setInspectorW}
            onReset={() => setInspectorW(320)}
            label="Resize side panel"
          />
        )}
        {!compact && (
          <aside className="inspector">
            {tabBar}
            <div className="panels">{panels}</div>
          </aside>
        )}
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
      <h2>What the app can know</h2>
      <ul className="tier-list">
        <li>
          <TierBadge tier={1} /> The 12 waveforms and device data.
        </li>
        <li>
          <TierBadge tier={2} /> The heart vector, axis, intervals and loop - computed from the leads.
        </li>
        <li>
          <TierBadge tier={3} /> The colour, contraction and blood flow - textbook physiology timed by this recording&rsquo;s beats, not measured in this patient.
        </li>
      </ul>
      {conduction?.agreement?.verdict && <p className="footnote">{conduction.agreement.verdict}</p>}
      <details className="more">
        <summary>Why the wavefront can&rsquo;t be recovered</summary>
        <p>
          A 12-lead ECG has 8 independent signals; one dipole is 3 numbers per instant. A
          wavefront over a heart has thousands of degrees of freedom, so it cannot be
          recovered from these leads - by any software. True 3D reconstruction (ECGI) needs
          a 200+ electrode vest and CT geometry.
        </p>
        {conduction && conduction.caveats.length > 0 && (
          <ul className="caveats">
            {conduction.caveats.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        )}
        <p>
          Full argument: <code>LIMITATIONS.md</code> and <code>METHODS.md</code>.
        </p>
      </details>
    </section>
  );
}
