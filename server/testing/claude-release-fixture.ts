import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ClaudeDriver } from "../drivers/claude.ts";
import { fixtureBotFolder } from "./bot-folder-fixture.ts";
import type { SendTurnInput } from "../contracts.ts";
/** Runs the shipped adapter against the isolated fake CLI, including its real
 * stdin enqueue. Refusal and native settlement are observed by the caller. */
export async function writeClaudePrompt(input: SendTurnInput): Promise<void> {
  const cli = fileURLToPath(new URL("fake-claude-cli.ts", import.meta.url));
  chmodSync(cli, 0o755);
  const instance = await ClaudeDriver.create({ instanceId: "receipt-release", displayName: "Claude", environment: {}, enabled: true, config: { cli, permissionMode: "acceptEdits" } });
  try { await instance.adapter.sendTurn({ ...input, draftOnly: true, integrations: undefined, cwd: fixtureBotFolder() }); }
  finally { await instance.dispose(); }
}
