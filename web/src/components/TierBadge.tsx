import { useState } from "react";
import { TIER_COLOURS } from "../lib/geometry";
import { useStore } from "../lib/store";
import type { TierNumber } from "../types";

const SHORT: Record<TierNumber, string> = {
  1: "Tier 1 - measured",
  2: "Tier 2 - derived",
  3: "Tier 3 - illustrative",
};

export function TierBadge({ tier, detail }: { tier: TierNumber; detail?: string }) {
  return (
    <span className="tier-badge" style={{ borderColor: TIER_COLOURS[tier], color: TIER_COLOURS[tier] }}>
      <span className="tier-dot" style={{ background: TIER_COLOURS[tier] }} />
      {SHORT[tier]}
      {detail ? <em>{detail}</em> : null}
    </span>
  );
}

/**
 * The Tier-3 banner. It has no close button, on purpose: the moment a user can
 * dismiss it, the animation starts looking like a measurement of this patient.
 * It is only hidden when the conduction model itself is switched off.
 */
export function ConductionBanner() {
  const data = useStore((s) => s.data);
  const showConduction = useStore((s) => s.showConduction);
  const conduction = data?.manifest.conduction;
  if (!showConduction || !conduction) return null;

  const r = conduction.agreement?.qrs?.r_overall;
  const applicable = conduction.applicable;

  return <BannerBody badge={conduction.badge} r={r} applicable={applicable}
                     verdict={conduction.agreement?.verdict} />;
}

function BannerBody({
  badge,
  r,
  applicable,
  verdict,
}: {
  badge: string;
  r: number | null | undefined;
  applicable: boolean;
  verdict?: string;
}) {
  // Collapsed by default: the banner must always be present and can never be
  // dismissed, but it should not cover the thing it is annotating.
  const [open, setOpen] = useState(false);

  return (
    <div className={`conduction-banner ${applicable ? "" : "not-applicable"} ${open ? "open" : ""}`}>
      <button
        className="banner-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={badge}
      >
        <span className="tier-dot" />
        <strong>Tier 3 &middot; illustrative colour</strong>
        {typeof r === "number" && (
          <span className="agreement" title="Correlation between the model's implied dipole and the measured one, over the QRS">
            model vs measured <b>r = {r.toFixed(2)}</b>
          </span>
        )}
        {!applicable && <span className="agreement warn">assumptions broken</span>}
        <span className="why">{open ? "less" : "why?"}</span>
      </button>
      {open && (
        <div className="banner-body">
          <strong>{badge}</strong>
          <span>
            The colour sweeping across the chambers is textbook physiology timed by this
            recording&rsquo;s own P, QRS and T fiducials. It is not a reconstruction of
            where current actually flowed in this heart, and cannot be: 8 independent
            leads cannot determine a wavefront.
          </span>
          {verdict && <span className="agreement">{verdict}</span>}
          {!applicable && (
            <span className="agreement warn">
              This recording breaks the model&rsquo;s assumptions - see the Limits tab. The
              animation is shown so you can watch it fail, not because it applies here.
            </span>
          )}
        </div>
      )}
    </div>
  );
}
