"""Command line entry point.

    python -m cardiovis inspect  data/example_ecg.xml
    python -m cardiovis process  data/example_ecg.xml -o web/public/data --title "Normal sinus"
    python -m cardiovis plot     data/example_ecg.xml -o scratch/sanity.png
    python -m cardiovis index    web/public/data
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import deident
from .filters import FilterConfig
from .frames import write_index
from .pipeline import process, process_and_export


def _filter_config(args) -> FilterConfig:
    return FilterConfig(
        highpass_hz=args.highpass,
        lowpass_hz=args.lowpass,
        order=args.order,
        notch_hz=None if args.notch in (0, None) else float(args.notch),
        enabled=not args.no_filter,
    )


def _add_signal_args(p):
    p.add_argument("--highpass", type=float, default=0.5, help="high-pass corner, Hz")
    p.add_argument("--lowpass", type=float, default=40.0, help="low-pass corner, Hz")
    p.add_argument("--order", type=int, default=3, help="Butterworth order")
    p.add_argument("--notch", type=float, default=50.0,
                   help="mains notch in Hz: 50 India/EU, 60 US, 0 to disable")
    p.add_argument("--no-filter", action="store_true", help="skip filtering entirely")
    p.add_argument("--vcg", default="kors", choices=["kors", "inverse_dower", "naive_pinv"],
                   help="primary VCG transform")
    p.add_argument("--vcg-alt", default="inverse_dower",
                   choices=["kors", "inverse_dower", "naive_pinv"],
                   help="comparison VCG transform")
    p.add_argument("--keep-phi", action="store_true",
                   help="DANGEROUS: retain patient identifiers (local clinical use only; "
                        "disabled in shipping builds)")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="cardiovis",
        description="CardioVis - 3D ECG visualisation and teaching platform. "
                    "For education and research. Not a medical device. Not for "
                    "diagnosis or clinical decision-making.")
    sub = ap.add_subparsers(dest="command", required=True)

    p_inspect = sub.add_parser("inspect", help="parse and print a summary")
    p_inspect.add_argument("input")
    _add_signal_args(p_inspect)

    p_proc = sub.add_parser("process", help="full pipeline and export for the web app")
    p_proc.add_argument("input")
    p_proc.add_argument("-o", "--out", default="web/public/data",
                        help="output root directory")
    p_proc.add_argument("--title", default=None, help="case title for the library")
    p_proc.add_argument("--description", default=None, help="one-line case description")
    p_proc.add_argument("--no-conduction", action="store_true",
                        help="skip the Tier-3 model")
    _add_signal_args(p_proc)

    p_plot = sub.add_parser("plot", help="matplotlib sanity plots")
    p_plot.add_argument("input")
    p_plot.add_argument("-o", "--out", default="sanity.png")
    _add_signal_args(p_plot)

    p_lib = sub.add_parser("library", help="generate the synthetic teaching library")
    p_lib.add_argument("-o", "--out", default="web/public/data")
    p_lib.add_argument("--only", default=None,
                       help="comma-separated case names to regenerate")
    _add_signal_args(p_lib)

    p_scrub = sub.add_parser("scrub", help="write a de-identified copy of a source file")
    p_scrub.add_argument("input")
    p_scrub.add_argument("-o", "--out", required=True)

    p_index = sub.add_parser("index", help="rebuild the case index")
    p_index.add_argument("root", nargs="?", default="web/public/data")

    args = ap.parse_args(argv)

    if getattr(args, "keep_phi", False) and deident.SHIPPING_BUILD:
        print("ERROR: --keep-phi is disabled in shipping builds.", file=sys.stderr)
        return 2

    if args.command == "index":
        path = write_index(args.root)
        print("wrote %s" % path)
        return 0

    if args.command == "inspect":
        p = process(args.input, keep_phi=args.keep_phi,
                    filter_config=_filter_config(args), vcg_method=args.vcg,
                    vcg_alt_method=args.vcg_alt)
        print("\n".join(p.summary_lines()))
        return 0

    if args.command == "process":
        p, result = process_and_export(
            args.input, args.out, keep_phi=args.keep_phi,
            filter_config=_filter_config(args), vcg_method=args.vcg,
            vcg_alt_method=args.vcg_alt, skip_conduction=args.no_conduction,
            title=args.title, description=args.description)
        print("\n".join(p.summary_lines()))
        print("")
        print("exported to %s" % result.directory)
        for f in result.files:
            print("  %-16s %8.1f kB" % (f.name, f.stat().st_size / 1024))
        write_index(args.out)
        return 0

    if args.command == "scrub":
        from .ecg_parser.ge_sapphire import scrub_file
        report = scrub_file(Path(args.input), Path(args.out))
        print("wrote %s" % report["output"])
        print("removed: %s" % ", ".join(report["removed"]))
        return 0

    if args.command == "library":
        from . import synth
        from .pipeline import process_recording_and_export
        wanted = set(args.only.split(",")) if args.only else None
        built = 0
        for cfg in synth.library():
            if wanted and cfg.name not in wanted:
                continue
            recording, _true = synth.generate(cfg)
            p, result = process_recording_and_export(
                recording, args.out, filter_config=_filter_config(args),
                vcg_method=args.vcg, vcg_alt_method=args.vcg_alt,
                title=cfg.title, description=cfg.description,
                teaching={
                    "synthetic": True,
                    "point": cfg.teaching_point,
                    "generator": "cardiovis.synth",
                    "warning": ("Synthetic recording generated by CardioVis. Not a "
                                "recording of a person."),
                    "transformNote": (
                        "These leads were generated by projecting a known dipole onto "
                        "the Dower forward lead vectors, so the inverse Dower transform "
                        "recovers it almost exactly and Kors - a different published "
                        "regression - carries a small systematic offset. On a synthetic "
                        "case the projection-versus-recorded gap is that difference "
                        "between transforms, not physiology. Switch the VCG method to "
                        "inverse_dower to watch the gap close."),
                })
            ag = (p.conduction.agreement or {}).get("qrs", {}).get("r_overall")
            print("%-22s QRS %3.0f ms  axis %6.0f deg  model r %s  %s"
                  % (cfg.name,
                     p.metrics.intervals.get("qrsMs") or 0,
                     p.metrics.axes.get("frontalQrsAxisFromVcgDeg") or 0,
                     ("%.2f" % ag) if ag is not None else "  - ",
                     ",".join(w.code for w in p.delineation.warnings) or "clean"))
            built += 1
        write_index(args.out)
        print("\n%d case(s) written to %s" % (built, args.out))
        return 0

    if args.command == "plot":
        from .plotting import sanity_figure
        p = process(args.input, keep_phi=args.keep_phi,
                    filter_config=_filter_config(args), vcg_method=args.vcg,
                    vcg_alt_method=args.vcg_alt)
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        sanity_figure(p, out)
        print("wrote %s" % out)
        return 0

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
