// Droid: the host `computer` MCP tools run without droid's own card (Murage asks per action);
// shell, edits and every other server keep asking. Frames and mechanism measured on droid 0.245.0
// (gate box): at mode "normal" an MCP tool raised session/request_permission kind "other" with options
// proceed_once / proceed_always / proceed_always_tools / proceed_always_server / cancel. After choosing
// proceed_always_server droid wrote <home>/.factory/mcp.json persistentPermissions.servers.computer
// {approvedAt, impactLevel:"high", serverIdentity:"8fdfd288ba33387819223cdf297c98de"} for
// command /usr/bin/node args ["/home/muragegate/gate/dp/zz-computer-mcp.mjs"]; with that file present at
// spawn the computer click ran unasked while shell (execute), write (edit) and a second server asked.
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureDirs } from "../../config.ts";
import { removeTempDirSync } from "../../testing/cleanup.ts";
import { scopeDroidHome, applyDroidHostComputerGrant, droidServerIdentity, droidSupport } from "./droid.ts";

const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) removeTempDirSync(h); });

function scoped(botId: string): string {
  ensureDirs();
  const home = mkdtempSync(join(tmpdir(), "murage-droid-grant-"));
  homes.push(home);
  mkdirSync(join(home, ".factory"), { recursive: true });
  writeFileSync(join(home, ".factory", "auth.v2.file"), "LOGIN");
  const env: Record<string, string | undefined> = { HOME: home };
  scopeDroidHome(env, "droid 0.245.0", botId);
  return env.FACTORY_HOME_OVERRIDE!;
}
const mcpPath = (root: string) => join(root, ".factory", "mcp.json");
const local = { command: "/usr/bin/node", args: ["/home/muragegate/gate/dp/zz-computer-mcp.mjs"], platform: "linux", scope: "local-computer" } as never;

describe("droid host computer grant", () => {
  it("declares that Murage asks for the host computer", () => {
    expect(droidSupport.hostComputerAskedByMurage).toBe(true);
  });

  it("identity matches the value droid 0.245.0 wrote for the same command and args", () => {
    expect(droidServerIdentity("/usr/bin/node", ["/home/muragegate/gate/dp/zz-computer-mcp.mjs"])).toBe("8fdfd288ba33387819223cdf297c98de");
  });

  it("a host-computer turn grants only the computer server, bound to its command and args", () => {
    const root = scoped("grant-bot");
    droidSupport.spawnArgs({} as never, { integrations: { localComputer: local } } as never, { env: { FACTORY_HOME_OVERRIDE: root } });
    const doc = JSON.parse(readFileSync(mcpPath(root), "utf8"));
    expect(Object.keys(doc.persistentPermissions.servers)).toEqual(["computer"]);
    expect(doc.persistentPermissions.servers.computer.serverIdentity).toBe("8fdfd288ba33387819223cdf297c98de");
    expect(doc.persistentPermissions.tools).toBeUndefined();
    expect(doc.mcpServers).toEqual({});
  });

  it("keeps the engine's other entries, and a turn without the host computer (or a VM computer) removes the grant", () => {
    const root = scoped("revoke-bot");
    mkdirSync(join(root, ".factory"), { recursive: true });
    writeFileSync(mcpPath(root), JSON.stringify({ mcpServers: {}, persistentPermissions: { servers: { other: { approvedAt: "x", impactLevel: "low", serverIdentity: "y" } } } }));
    applyDroidHostComputerGrant({ integrations: { localComputer: local } }, { FACTORY_HOME_OVERRIDE: root });
    expect(Object.keys(JSON.parse(readFileSync(mcpPath(root), "utf8")).persistentPermissions.servers).sort()).toEqual(["computer", "other"]);
    applyDroidHostComputerGrant({ integrations: { computer: { } as never } }, { FACTORY_HOME_OVERRIDE: root });
    expect(Object.keys(JSON.parse(readFileSync(mcpPath(root), "utf8")).persistentPermissions.servers)).toEqual(["other"]);
  });

  it("never writes outside a Murage-owned scoped home, and writes nothing when there is nothing to remove", () => {
    const plain = mkdtempSync(join(tmpdir(), "murage-droid-plain-"));
    homes.push(plain);
    applyDroidHostComputerGrant({ integrations: { localComputer: local } }, { FACTORY_HOME_OVERRIDE: plain });
    applyDroidHostComputerGrant({ integrations: { localComputer: local } }, {});
    expect(existsSync(join(plain, ".factory", "mcp.json"))).toBe(false);
    const root = scoped("empty-bot");
    applyDroidHostComputerGrant({ integrations: {} }, { FACTORY_HOME_OVERRIDE: root });
    expect(existsSync(mcpPath(root))).toBe(false);
  });
});
