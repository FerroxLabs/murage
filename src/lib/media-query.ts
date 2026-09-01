import { useEffect, useState } from "react";

/** Everything below Tailwind's `md` (48rem / 768px), i.e. exactly the range the
 * `max-md:` variant covers. Kept as one constant so a component that has to
 * branch in JS — an inline `style` width beats every class, so `max-md:w-full`
 * cannot reach it — stays in step with the CSS that does the rest. */
export const NARROW_MEDIA_QUERY = "(max-width: 767.98px)";

/** True while the viewport is in `max-md:` territory. Reactive: a desktop
 * window dragged narrow has to drop its fixed-px panel width too, so a one-shot
 * `matchMedia(...).matches` at first render would be a resize bug. */
export function useNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState(
    () => globalThis.matchMedia?.(NARROW_MEDIA_QUERY).matches ?? false,
  );
  useEffect(() => {
    const mql = globalThis.matchMedia?.(NARROW_MEDIA_QUERY);
    if (!mql) return;
    const apply = () => setNarrow(mql.matches);
    apply();
    mql.addEventListener("change", apply);
    return () => mql.removeEventListener("change", apply);
  }, []);
  return narrow;
}
