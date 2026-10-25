// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useWindowDrag } from "@/hooks/use-window-drag";

/** A thin handle across the top of a view that has no header row of its own. Nothing on a phone or off a Mac. */
export function WindowDragStrip() {
  const drag = useWindowDrag();
  if (!("data-window-drag" in drag)) return null;
  return <div aria-hidden="true" className="h-7 shrink-0" {...drag} />;
}
