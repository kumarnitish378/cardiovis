import { useEffect, useState } from "react";

/** Subscribe to a CSS media query. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/** Below this width the inspector stops being a side column and the traces
 *  and panels share one tabbed dock under the 3D view (tablet portrait, phone). */
export const COMPACT_QUERY = "(max-width: 1099px)";
