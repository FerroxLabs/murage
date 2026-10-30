// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "On this screen": the screen's intro and at most three tips, from the
// screens index (src/lib/screens-index.ts). Read-only words, no actions.
import type { ScreenIndexEntry } from "@/lib/screens-index";
import { hx } from "./help-copy";

export function HelpTips({ entry, params }: { entry: ScreenIndexEntry | undefined; params: Record<string, string> }) {
  if (!entry) return null;
  return (
    <section aria-labelledby="help-on-this-screen" className="border-b border-hairline/40 px-5 py-4">
      <h3 id="help-on-this-screen" className="mb-2.5 text-[12px] font-semibold uppercase tracking-[0.05em] text-ink-secondary">
        {hx("ux.l4a.panel.onThisScreen")}
      </h3>
      <p className="mb-3 text-[14px] leading-5 text-ink-secondary">{hx(entry.intro, params)}</p>
      <ul className="flex flex-col gap-2">
        {entry.tips.slice(0, 3).map((tip) => (
          <li key={tip} className="flex gap-2.5 text-[14px] leading-5 text-ink">
            <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-accent" />
            <span>{hx(tip, params)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
