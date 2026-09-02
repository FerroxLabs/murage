import { useEffect, useState } from "react";

import { DEFAULT_SKIN, type SkinId } from "./skins";

/** Whatever `data-skin` currently says, which is where every path already
 *  agrees: an explicit choice, the migration of an old id, and the OS flip
 *  under Automatic all land there through `applySkin`. Reading the attribute
 *  rather than the stored preference is what makes Automatic work — the
 *  preference is "auto", and only the attribute knows which one that resolved
 *  to right now. */
function currentSkin(): SkinId {
  if (typeof document === "undefined") return DEFAULT_SKIN;
  const value = document.documentElement.dataset.skin;
  return value === "light" || value === "dark" ? value : DEFAULT_SKIN;
}

/** The active palette, live. Use it only where an asset genuinely has to
 *  change with the theme — a colour belongs in a CSS custom property, not in
 *  a re-render. */
export function useActiveSkin(): SkinId {
  const [skin, setSkin] = useState<SkinId>(currentSkin);
  useEffect(() => {
    // The attribute is set imperatively, including by a matchMedia handler
    // this component never sees, so observing it is the only way to stay
    // right when the OS flips mid-session under Automatic.
    const observer = new MutationObserver(() => setSkin(currentSkin()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-skin"] });
    setSkin(currentSkin());
    return () => observer.disconnect();
  }, []);
  return skin;
}
