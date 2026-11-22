"""Evidence tiers.

Every quantity CardioVis shows must declare where it came from. This is not
decoration: the UI reads the tier off the payload and renders the badge from it.

"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class Tier(Enum):
    MEASURED = 1      # Directly present in the file
    DERIVED = 2       # Mathematically reconstructed, patient-specific, defensible
    ILLUSTRATIVE = 3  # Textbook physiology, timed by patient data, NOT patient-specific


TIER_LABELS = {
    Tier.MEASURED: "Measured in this recording",
    Tier.DERIVED: "Derived from this recording",
    Tier.ILLUSTRATIVE: "Conduction model — illustrative, not patient-specific reconstruction",
}

#: Tier 3 badges may never be dismissed by the user. Enforced in the frontend,
#: asserted here so the flag travels with the data.
TIER_DISMISSIBLE = {Tier.MEASURED: True, Tier.DERIVED: True, Tier.ILLUSTRATIVE: False}


@dataclass
class Tagged:
    """A value plus its evidence tier and provenance sentence."""

    value: Any
    tier: Tier
    units: str | None = None
    source: str | None = None
    detail: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        return {
            "value": self.value,
            "tier": self.tier.value,
            "tierLabel": TIER_LABELS[self.tier],
            "dismissible": TIER_DISMISSIBLE[self.tier],
            "units": self.units,
            "source": self.source,
            **({"detail": self.detail} if self.detail else {}),
        }


def measured(value, units=None, source=None, **detail) -> Tagged:
    return Tagged(value, Tier.MEASURED, units, source, detail)


def derived(value, units=None, source=None, **detail) -> Tagged:
    return Tagged(value, Tier.DERIVED, units, source, detail)


def illustrative(value, units=None, source=None, **detail) -> Tagged:
    return Tagged(value, Tier.ILLUSTRATIVE, units, source, detail)
