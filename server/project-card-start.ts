// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Monotonic boundary for a single provider start. Only matching run events
 * reach it; output, tools and approvals permanently forbid replay. */
export function createCardStartBoundary() {
  let worked = false;
  let failure: Error | undefined;
  return {
    worked: () => worked,
    failure: () => failure,
    observe(event: { type: string; message?: string; details?: string }) {
      if (["content.delta", "item.started", "item.updated", "item.completed", "plan.updated", "request.opened"].includes(event.type)) worked = true;
      if (event.type === "runtime.error") failure = new Error([event.message, event.details].filter(Boolean).join(" "));
    },
  };
}
