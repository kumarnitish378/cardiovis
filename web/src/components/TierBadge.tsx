import { TIER_COLOURS } from "../lib/geometry";
import { useStore } from "../lib/store";
import type { TierNumber } from "../types";
import { Icon } from "./Icon";

const SHORT: Record<TierNumber, string> = {
  1: "Measured",
  2: "Derived",
  3: "Illustrative",
};

const LONG: Record<TierNumber, string> = {
  1: "Tier 1 - measured directly in the file",
  2: "Tier 2 - derived from the leads by published maths",
  3: "Tier 3 - illustrative textbook model, timed by this recording",
};

export function TierBadge({ tier, detail }: { tier: TierNumber; detail?: string }) {
  return (
    <span className="tier-badge" style={{ color: TIER_COLOURS[tier] }} title={LONG[tier]}>
      <span className="tier-dot" style={{ background: TIER_COLOURS[tier] }} />
      T{tier} · {SHORT[tier]}
      {detail ? <em>{detail}</em> : null}
    </span>
  );
}

/**
 * The Tier-3 notice. It has no close button, on purpose: the moment a user can
 * dismiss it, the animation starts looking like a measurement of this patient.
 * It is only hidden when the conduction model itself is switched off.
 * "Why?" opens the Limits panel, where the full argument lives.
 */
export function ConductionBanner({ onExplain }: { onExplain?: () => void }) {
  const data = useStore((s) => s.data);
  const showConduction = useStore((s) => s.showConduction);
  const conduction = data?.manifest.conduction;
  if (!showConduction || !conduction) return null;

  const r = conduction.agreement?.qrs?.r_overall;
  const applicable = conduction.applicable;

  return (
    <button
      className={`conduction-banner ${applicable ? "" : "not-applicable"}`}
      onClick={onExplain}
      title={`${conduction.badge}. Model vs measured dipole, QRS: r = ${typeof r === "number" ? r.toFixed(2) : "n/a"}.${applicable ? "" : " This recording breaks the model's assumptions."} ${conduction.agreement?.verdict ?? ""}`}
      aria-label="Illustrative colour - what this means"
    >
      <span className="tier-dot" />
      <span className="banner-text">
        <b>Illustrative colour</b>
        {typeof r === "number" && <span className="banner-detail">r {r.toFixed(2)}</span>}
      </span>
      <Icon name="info" size={16} />
    </button>
  );
}
