"""De-identification. Runs *inside* the parser, before data reaches any other
module. See PRIVACY.md.

What is removed: patient name, medical record number / any identifier, site
name, site address, full acquisition timestamp, device serial number.
What is kept: a 10-year age band and sex (both physiologically relevant to
interpretation), the acquisition year, device vendor/model, and a deterministic
pseudonymous ID.

The pseudonymous ID is HMAC-SHA256 over the original identifiers with a local
salt, so the same recording maps to the same ID across sessions on the same
machine, and the ID cannot be reversed or matched across installations.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
import warnings
from fnmatch import fnmatch
from pathlib import Path
from typing import Any

SALT_ENV = "CARDIOVIS_DEIDENT_SALT"
SALT_FILE = Path(os.path.expanduser("~")) / ".cardiovis" / "deident_salt"

#: Set true in packaged/deployed builds. `--keep-phi` then raises instead of
#: warning. See PRIVACY.md and the check in cli.py.
SHIPPING_BUILD = os.environ.get("CARDIOVIS_SHIPPING_BUILD", "").lower() in {"1", "true", "yes"}


def _salt() -> bytes:
    env = os.environ.get(SALT_ENV)
    if env:
        return env.encode("utf-8")
    if SALT_FILE.exists():
        return SALT_FILE.read_bytes()
    SALT_FILE.parent.mkdir(parents=True, exist_ok=True)
    salt = secrets.token_bytes(32)
    SALT_FILE.write_bytes(salt)
    try:
        os.chmod(SALT_FILE, 0o600)
    except OSError:  # pragma: no cover - Windows ACLs
        pass
    return salt


def pseudonymise(*parts: Any, prefix: str = "cv", length: int = 12) -> str:
    """Deterministic, salted, non-reversible ID for a recording."""
    payload = "|".join("" if p is None else str(p) for p in parts).encode("utf-8")
    digest = hmac.new(_salt(), payload, hashlib.sha256).hexdigest()
    return f"{prefix}_{digest[:length]}"


def age_band(age_years: float | int | None, width: int = 10) -> str | None:
    """Coarsen age. Ages >= 90 collapse to '90+' (HIPAA Safe Harbor)."""
    if age_years is None:
        return None
    try:
        age = int(float(age_years))
    except (TypeError, ValueError):
        return None
    if age >= 90:
        return "90+"
    if age < 0:
        return None
    lo = (age // width) * width
    return f"{lo}-{lo + width - 1}"


def normalise_sex(value: str | None) -> str | None:
    if not value:
        return None
    v = str(value).strip().upper()
    return {"M": "M", "MALE": "M", "F": "F", "FEMALE": "F"}.get(v, "other/unknown")


def acquisition_year(timestamp: str | None) -> int | None:
    """Keep the year only — a full acquisition date/time is an identifier."""
    if not timestamp:
        return None
    try:
        return int(str(timestamp)[:4])
    except ValueError:
        return None


def warn_phi_retained(context: str = "") -> None:
    msg = (
        "PHI RETENTION ENABLED (--keep-phi). Patient identifiers are being kept in "
        "memory and may be written to disk. This is for local clinical use only. "
        "Do not export, share, or deploy the output. " + context
    )
    if SHIPPING_BUILD:
        raise RuntimeError("--keep-phi is disabled in shipping builds. " + msg)
    warnings.warn(msg, stacklevel=2)
    print("\n" + "!" * 78 + f"\n!! {msg}\n" + "!" * 78 + "\n", flush=True)


#: Keys that must never appear in frames.json, logs, error traces or telemetry.
FORBIDDEN_KEYS = {
    "name", "given", "family", "patientname", "mrn", "id", "identifier",
    "authority", "site", "siteaddress", "streetaddressline", "city", "address",
    "serialid", "serialnumber", "acquisitiondatetime", "dob", "birthdate",
    "patientage", "phi",
}


def assert_phi_free(obj: Any, path: str = "$", allow: tuple[str, ...] = ()) -> None:
    """Belt-and-braces check run before any export. Raises on a forbidden key.

    `allow` holds fnmatch patterns for paths where a forbidden-looking key is
    known to be harmless (a tier's `name`, say). Keep that list short and
    explicit: every entry is a place the guard has been switched off. Write list
    indices as `[]` in a pattern - fnmatch reads `[0]` as a character class, so
    patterns are matched against an index-stripped copy of the path as well.
    """
    if isinstance(obj, dict):
        for k, v in obj.items():
            child = f"{path}.{k}"
            generic = re.sub(r"\[\d+\]", "[]", child)
            if (str(k).lower().replace("_", "") in FORBIDDEN_KEYS
                    and not any(fnmatch(child, pat) or generic == pat for pat in allow)):
                raise ValueError(f"Refusing to export: PHI-shaped key {child}")
            assert_phi_free(v, child, allow)
    elif isinstance(obj, (list, tuple)):
        for i, v in enumerate(obj):
            assert_phi_free(v, f"{path}[{i}]", allow)
