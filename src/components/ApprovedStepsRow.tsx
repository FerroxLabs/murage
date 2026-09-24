// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { ChevronRight } from "lucide-react";
import { CHIP, CHIP_NAME } from "@/lib/transcript-chrome";
import type { Message } from "@/state/store";

/** Is this activity message a collapsed run of Full access approvals? */
export function isApprovedStepsLine(message: Message): boolean {
  return message.kind === "activity" && Array.isArray(message.tool?.steps);
}

/** Full access answers almost every step a bot takes, so its approvals
 * fold into one quiet line ("Approved 12 steps (Full access)") that counts
 * up as the run goes and opens to list the steps. Not a tool run: it stays
 * visible with Tool calls off, the same family as the stopped rows. The
 * decision log still holds one row per step. */
export function ApprovedStepsRow({ message }: { message: Message }) {
  const tool = message.tool;
  if (!tool?.steps) return null;
  const hidden = (tool.stepCount ?? tool.steps.length) - tool.steps.length;
  return (
    <div className="flex justify-start">
      <details data-testid="approved-steps-row" className="group min-w-0 max-w-[min(42rem,78%)] max-md:max-w-full">
        <summary className={`${CHIP} cursor-pointer list-none text-ink-secondary hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus`}>
          <ChevronRight size={13} aria-hidden="true" className="shrink-0 transition-transform group-open:rotate-90" />
          <span className={CHIP_NAME}>{tool.name}</span>
        </summary>
        <ol className="mt-1 max-h-64 overflow-y-auto px-3 text-[12px] leading-relaxed text-ink-secondary">
          {hidden > 0 && <li className="list-none">{hidden} earlier {hidden === 1 ? "step" : "steps"} not listed</li>}
          {tool.steps.map((step, index) => (
            <li key={index} className="list-none break-words font-mono">{step}</li>
          ))}
        </ol>
      </details>
    </div>
  );
}
