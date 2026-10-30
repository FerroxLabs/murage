// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SETTINGS-UX-1011 S1 (section 5): a Settings card or a bot settings section never renders nothing because a feature is
// off or unavailable. It renders a stub: the same title, one plain line that says why, and one action if there is one.
// The line is dimmed, the title is not; a stub is never an alert role and never the red error style (off is not an error).
import { t } from "@/lib/i18n";
import { useCopyFeedback } from "@/lib/copy-text";
import { botRole, type RoleBot } from "@/lib/bot-role";
import { SETTINGS_CARDS, cardLabel } from "@/lib/settings-card-registry";
import { cardForAnchor } from "@/lib/settings-cards";
import { settingsPageLabel } from "@/lib/settings-sections";
import { Card } from "./SettingsPrimitives";

/** The six states of section 5. */
export type SettingsStubState = "off" | "needs-account" | "not-yet" | "other-surface" | "needs-engine" | "coming";

/** Section 5's final copy, one line per state. Plain words, no em dashes, never blames the owner. */
export const SETTINGS_STUB_COPY = {
  off: (letsBots: string) => `Off. Turn it on to let bots ${letsBots}.`,
  needsAccount: (chief: string) => `Needs a Flux Router account with email on. Ask ${chief} to set it up, or open Flux Router.`,
  notYet: "Not on for your account yet. We are turning it on in stages.",
  otherSurface: (path: string) => `Set this on your computer. Open Murage on the desktop, then Settings > ${path}.`,
  needsEngine: (engine: string, chief: string) => `${engine} cannot do this yet. Pick an engine that can under Model, or ask ${chief}.`,
  coming: (version: string) => `Coming in ${version}.`,
  /** Not a gate: the moment before the server has answered. The card still has its title and a line. */
  checking: (feature: string) => `Checking if ${feature} is on for your account.`,
  /** Not a gate either: the read failed, so nothing is known yet. Says what to do, never blames. */
  couldNotCheck: (feature: string) => `Could not check ${feature} just now. Close Settings and open it again to try again.`,
  readingBot: (botName: string) => `Reading ${botName}'s email.`,
  couldNotRead: (botName: string) => `Could not read ${botName}'s email just now. Open another section and come back to try again.`,
  openModels: "Open Models & engines",
  copyPath: "Copy the path",
} as const;

/** The workspace Chief's name for "Ask {Chief}", or a plain fallback when there is none yet. */
export function chiefName(bots: readonly (RoleBot & { name?: string })[] | undefined): string {
  const chief = bots?.find(bot => botRole(bot) === "chief");
  return chief?.name?.trim() || "your Chief";
}

/** "General > Advanced > Start at login and run in the background" for a registered card anchor. */
export function settingsCardPath(anchor: string): { title: string; path: string } | null {
  const card = cardForAnchor(SETTINGS_CARDS, anchor);
  if (!card) return null;
  const title = cardLabel(card);
  return { title, path: [settingsPageLabel(card.section), ...(card.advanced ? ["Advanced"] : []), title].join(" > ") };
}

const actionButton = "min-h-9 rounded-lg bg-control px-3 text-[13px] font-medium text-ink hover:bg-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";

export function SettingsStub({ title, state, line, action, testId }: {
  title: string; state: SettingsStubState | "checking" | "could-not-check"; line: string; action?: { label: string; onClick: () => void }; testId?: string;
}) {
  return (
    <Card title={title}>
      <div data-settings-stub={state} data-testid={testId}>
        <p className="text-[13px] leading-relaxed text-ink-secondary opacity-80">{line}</p>
        {action && <button type="button" className={`${actionButton} mt-3`} onClick={action.onClick}>{action.label}</button>}
      </div>
    </Card>
  );
}

/** A card that needs this computer, in a window that is not this computer (the Cloud window): its title, where to set
 *  it, and a copy of that path. */
export function ComputerOnlyStub({ anchor }: { anchor: string }) {
  const { mark, copy } = useCopyFeedback();
  const found = settingsCardPath(anchor);
  const title = found?.title ?? "Settings";
  const path = found?.path ?? title;
  return <SettingsStub title={title} state="other-surface" line={SETTINGS_STUB_COPY.otherSurface(path)} testId={`settings-stub-${anchor}`}
    action={{ label: mark === "copied" ? t("copy.copied") : mark === "failed" ? t("copy.failed") : SETTINGS_STUB_COPY.copyPath, onClick: () => void copy(`Settings > ${path}`) }} />;
}
