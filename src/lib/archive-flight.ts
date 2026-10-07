// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// G4: an archived bot used to vanish from the sidebar with nothing to show
// where it went. Its row now flies into the + button, which holds Archived
// bots, and the button gives one small pulse as it lands. Reduced motion
// skips the flight; the note beside it says the same thing in words.

type Box = { left: number; top: number; width: number; height: number };

/** From the row's box to the centre of the + button, shrinking as it goes. */
export function archiveFlightKeyframes(from: Box, to: Box): Keyframe[] {
  const dx = Math.round(to.left + to.width / 2 - (from.left + from.width / 2));
  const dy = Math.round(to.top + to.height / 2 - (from.top + from.height / 2));
  return [
    { transform: "translate(0px, 0px) scale(1)", opacity: 1 },
    { transform: `translate(${dx}px, ${dy}px) scale(0.2)`, opacity: 0 },
  ];
}

const reducedMotion = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** Measure and copy the row NOW, while it is still on screen; `launch` flies
 * the copy once the archive has succeeded (the row is gone by then). A
 * failed archive never launches, so nothing flies anywhere. */
export function prepareArchiveFlight(row: Element | null, target: HTMLElement | null): { launch: () => void } {
  const idle = { launch: () => {} };
  if (!(row instanceof HTMLElement) || !target || reducedMotion() || typeof row.animate !== "function") return idle;
  const from = row.getBoundingClientRect();
  if (!from.width || !from.height) return idle;
  const ghost = row.cloneNode(true) as HTMLElement;
  ghost.removeAttribute("data-sidebar-bot-row");
  ghost.setAttribute("aria-hidden", "true");
  ghost.inert = true;
  Object.assign(ghost.style, {
    position: "fixed", left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px`,
    margin: "0", pointerEvents: "none", zIndex: "70", transformOrigin: "center",
  });
  return {
    launch: () => {
      const to = target.getBoundingClientRect();
      if (!to.width || !to.height) return;
      document.body.appendChild(ghost);
      const flight = ghost.animate(archiveFlightKeyframes(from, to), { duration: 420, easing: "cubic-bezier(0.4, 0, 0.2, 1)" });
      const land = () => {
        ghost.remove();
        target.animate([{ transform: "scale(1)" }, { transform: "scale(1.18)" }, { transform: "scale(1)" }], { duration: 260, easing: "ease-out" });
      };
      flight.onfinish = land;
      flight.oncancel = () => ghost.remove();
    },
  };
}
