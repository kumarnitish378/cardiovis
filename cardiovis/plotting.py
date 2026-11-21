"""Matplotlib sanity plots - the Phase-0 acceptance check.

Not part of the product. This exists so that a human can look at one PNG and
see whether the parse, the filter, the fiducials and the VCG loop are sane
before any of it reaches a 3D scene where mistakes look beautiful.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np


def sanity_figure(processed, out_path: str | Path) -> Path:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    p = processed
    fs = p.filtered.sample_rate_hz
    n = p.filtered.filtered.n_samples
    t = np.arange(n) / fs

    fig = plt.figure(figsize=(16, 11), constrained_layout=True)
    gs = fig.add_gridspec(4, 3)

    # ---- lead II raw vs filtered with fiducials --------------------------- #
    ax = fig.add_subplot(gs[0, :])
    ax.plot(t, p.filtered.raw.signals["II"], lw=0.6, alpha=0.45, label="II raw")
    ax.plot(t, p.filtered.filtered.signals["II"], lw=0.9, label="II filtered")
    for b in p.delineation.beats:
        for key, colour in (("p_on", "tab:green"), ("qrs_on", "tab:red"),
                            ("qrs_off", "tab:red"), ("t_off", "tab:purple")):
            v = getattr(b, key)
            if v is not None:
                ax.axvline(v / fs, color=colour, lw=0.5, alpha=0.6)
        ax.plot(b.r / fs, p.filtered.filtered.signals["II"][b.r], "k.", ms=4)
    ax.set_title("Lead II - raw vs filtered, with detected fiducials "
                 "(green P onset, red QRS, purple T offset)")
    ax.set_xlabel("s")
    ax.set_ylabel("mV")
    ax.legend(loc="upper right", fontsize=8)

    # ---- all 12 leads ------------------------------------------------------ #
    ax = fig.add_subplot(gs[1, :])
    offset = 0.0
    for lead in ["I", "II", "III", "aVR", "aVL", "aVF",
                 "V1", "V2", "V3", "V4", "V5", "V6"]:
        x = p.filtered.filtered.signals[lead]
        ax.plot(t, x + offset, lw=0.6)
        ax.text(-0.15, offset, lead, va="center", ha="right", fontsize=8)
        offset -= 2.0
    ax.set_xlim(-0.3, t[-1])
    ax.set_yticks([])
    ax.set_title("All 12 leads, filtered (%s)" % p.filtered.config.describe())
    ax.set_xlabel("s")

    # ---- VCG loops, representative beat ------------------------------------ #
    from .metrics import representative_beat
    rep = representative_beat(p.delineation)
    if rep is not None and rep.qrs_on is not None and rep.t_off is not None:
        lo = rep.p_on if rep.p_on is not None else rep.qrs_on
        hi = rep.t_off
        loop = p.vcg.xyz[:, lo:hi]
        qrs = p.vcg.xyz[:, rep.qrs_on:rep.qrs_off]
        alt = p.vcg_alt.xyz[:, lo:hi]
        planes = [("Frontal (x-y)", 0, 1, "left", "inferior"),
                  ("Horizontal (x-z)", 0, 2, "left", "posterior"),
                  ("Sagittal (z-y)", 2, 1, "posterior", "inferior")]
        for i, (title, a, b_, xlabel, ylabel) in enumerate(planes):
            ax = fig.add_subplot(gs[2, i])
            ax.plot(alt[a], alt[b_], lw=0.8, color="tab:orange", alpha=0.7,
                    label=p.vcg_alt.method)
            ax.plot(loop[a], loop[b_], lw=1.0, color="tab:blue", label=p.vcg.method)
            ax.plot(qrs[a], qrs[b_], lw=2.0, color="tab:red", label="QRS")
            ax.plot(0, 0, "k+", ms=8)
            ax.set_title(title, fontsize=9)
            ax.set_xlabel(xlabel, fontsize=8)
            ax.set_ylabel(ylabel, fontsize=8)
            ax.set_aspect("equal", adjustable="datalim")
            ax.invert_yaxis()
            if i == 0:
                ax.legend(fontsize=7)

    # ---- measured vs modelled dipole --------------------------------------- #
    if p.conduction.model_dipole is not None:
        ax = fig.add_subplot(gs[3, :])
        meas = p.vcg.xyz
        model = p.conduction.model_dipole
        scale = (np.max(np.abs(meas)) / (np.max(np.abs(model)) + 1e-12))
        for i, axis in enumerate("xyz"):
            ax.plot(t, meas[i] + 2 * i, lw=0.8, color="tab:blue")
            ax.plot(t, model[i] * scale + 2 * i, lw=0.8, color="tab:red", alpha=0.75)
            ax.text(-0.15, 2 * i, axis, va="center", ha="right", fontsize=9)
        ag = p.conduction.agreement.get("qrs", {})
        r = ag.get("r_overall")
        ax.set_title("Measured dipole (blue, Tier 2) vs modelled dipole "
                     "(red, Tier 3, scaled)%s"
                     % ("  -  QRS correlation r = %.3f" % r if r is not None else ""))
        ax.set_xlim(-0.3, t[-1])
        ax.set_yticks([])
        ax.set_xlabel("s")

    fig.suptitle("CardioVis sanity check - %s   |   %s"
                 % (p.recording.record_id,
                    "For education and research. Not for diagnosis."), fontsize=10)
    out_path = Path(out_path)
    fig.savefig(out_path, dpi=110)
    plt.close(fig)
    return out_path
