// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlMurage } from "../scripts/control-murage.ts";

it("the effort settings PATCH preserves a new bot's permission default in an isolated server", async () => {
  const fixture = await launchVerificationServer(process.env);
  console.log("new-bot defaults fixture", JSON.stringify(fixture.info));
  try {
    const doctor = await runControlMurage(["doctor", "--url", fixture.info.url]);
    console.log("new-bot defaults doctor", JSON.stringify(doctor));
    const { secret } = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    const headers = { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
    const patch = async (newBots: unknown) => {
      const response = await fetch(`${fixture.info.url}/api/config`, { method: "PATCH", headers, body: JSON.stringify({ newBots }) });
      expect(response.status).toBe(200);
      return await response.json();
    };
    await patch({ permissionLevel: "auto" });
    await patch({ effort: "high" });
    const read = async () => await (await fetch(`${fixture.info.url}/api/config`, { headers })).json() as { newBots: unknown };
    expect((await read()).newBots).toEqual({ permissionLevel: "auto", effort: "high" });
    await patch({ effort: null });
    expect((await read()).newBots).toEqual({ permissionLevel: "auto" });
    expect(JSON.parse(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8")).newBots).toEqual({ permissionLevel: "auto" });
  } finally { await fixture.close(); }
}, 90_000);
