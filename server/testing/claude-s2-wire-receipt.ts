// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixture identity owner: sc-safety. Production admission owner: Claude driver.
import type { ProviderAdapter } from "../contracts.ts";
import { fixtureBotFolder } from "./bot-folder-fixture.ts";

export { withClaudeWireReceipt } from "./claude-s2-fixture-receipt.ts";

/** Older wire cases predate the required bot cwd. Supply only an absent cwd;
 * explicit paths (including intentional refusal inputs) keep their meaning. */
export function withClaudeFixtureCwd(adapter: Pick<ProviderAdapter, "sendTurn">): void {
  const send = adapter.sendTurn.bind(adapter);
  adapter.sendTurn = turn => {
    const input = turn.cwd === undefined ? { ...turn, cwd: fixtureBotFolder() } : turn;
    // A real boundary's preparation scope checks the same hook without
    // releasing a prompt. Carry it through the fixture's memory fence too.
    return send(input.prepareSubmit && input.beforeSubmit && !input.beforePrepare
      ? { ...input, beforePrepare: () => input.prepareSubmit!(input.beforeSubmit!.bind(input)) } : input);
  };
}
