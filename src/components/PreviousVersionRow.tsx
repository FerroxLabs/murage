// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// About & updates, Help: step back to the previous version. The app asks before
// it does anything, so this only starts the ask. Hidden where the desktop
// bridge (or an older one) does not offer it.
import { useAction } from "@/lib/use-action";
import { ActionButton } from "./ActionButton";
import { Card } from "./SettingsPrimitives";

const button = "min-h-11 rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

export function PreviousVersionRow() {
  const available = typeof window !== "undefined" && typeof window.muragebox?.updater?.preparePreviousVersion === "function";
  const action = useAction(async () => { await window.muragebox?.updater?.preparePreviousVersion?.(); }, {
    idle: "Prepare",
    pending: "Preparing...",
    success: "Murage is asking you to confirm.",
    failure: "Could not start this right now. Try again in a moment.",
  });
  if (!available) return null;
  return (
    <Card title="Go back to the previous version, chats and memories kept">
      <ActionButton action={action} className={button} />
    </Card>
  );
}
