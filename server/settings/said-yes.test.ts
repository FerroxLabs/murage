// Settings v10 G2 (owner: core): removing one said-yes entry makes its next use ask again. Real recipient file, real folder
// trust store, the real lane route through the Settings v10 router, and the real stop-line classifier.
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { FolderTrustStore } from "../folder-trust.ts";
import { classifyStopLine } from "../stop-line.ts";
import { knownRecipients, rememberRecipients } from "../stop-line-state.ts";
import { settingsV10Router } from "./v10-routes.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) removeTempDirSync(dir); });

function fixture() {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "said-yes-")));
  dirs.push(dataDir);
  const folderTrust = new FolderTrustStore(join(dataDir, "folder-trust.json"));
  const router = settingsV10Router({ dataDir, folderTrust });
  const bots = new Map([["bot-1", { id: "bot-1", name: "Ada" }]]);
  const store = { bot: (id: string) => bots.get(id) ?? null } as never;
  async function call(method: string, path: string, body?: unknown, surface: "desktop" | "remote" = "desktop") {
    let answer: { status: number; body: any } | undefined;
    const json = (_res: ServerResponse, status: number, out: unknown) => { answer = { status, body: out }; };
    const url = new URL(`http://local${path}`);
    const handled = await router.handle({ method, path: url.pathname, url, req: {} as never, res: {} as never, json, readBody: async () => body, store, cfg: {} as never, surface });
    expect(handled).toBe(true);
    return answer!;
  }
  return { dataDir, folderTrust, call };
}
const sendTo = (dataDir: string, to: string) => classifyStopLine("mcp__gmail__send_email", { to, subject: "x" }, "send", {
  roots: [], home: "/nonexistent-home", knownRecipients: knownRecipients(dataDir, "bot-1"), realpath: () => null,
});

describe("G2 said-yes lists", () => {
  it("lists a remembered recipient, and removing it makes the next message to it ask again", async () => {
    const { dataDir, call } = fixture();
    rememberRecipients(dataDir, "bot-1", ["boss@example.com", "team@example.com"]);
    expect(sendTo(dataDir, "boss@example.com")).toBeNull();
    expect((await call("GET", "/api/settings/said-yes?bot=bot-1")).body.recipients).toEqual(["boss@example.com", "team@example.com"]);

    expect(await call("DELETE", "/api/settings/said-yes/recipient", { bot: "bot-1", recipient: "Boss@Example.com" })).toEqual({ status: 200, body: { ok: true } });
    expect(sendTo(dataDir, "boss@example.com")).toMatchObject({ kind: "message" });
    expect(sendTo(dataDir, "team@example.com")).toBeNull();
    expect((await call("GET", "/api/settings/said-yes?bot=bot-1")).body.recipients).toEqual(["team@example.com"]);
    expect((await call("DELETE", "/api/settings/said-yes/recipient", { bot: "bot-1", recipient: "boss@example.com" })).status).toBe(404);
  });

  it("lists a trusted folder, and removing it by its key leaves the next use with no decision (the card asks)", async () => {
    const { dataDir, folderTrust, call } = fixture();
    const folder = join(dataDir, "project");
    mkdirSync(folder);
    folderTrust.remember(folder, "trust", "card");
    const listed = (await call("GET", "/api/settings/said-yes")).body.folders;
    expect(listed).toEqual([expect.objectContaining({ decision: "trust", source: "card" })]);
    expect(folderTrust.decision(folder)).toBe("trust");
    expect(folderTrust.forgetKey(listed[0].key)).toBe(true);
    expect(folderTrust.decision(folder)).toBeUndefined();
    expect((await call("GET", "/api/settings/said-yes")).body.folders).toEqual([]);
  });

  it("is changed on the desktop only, and names no recipient of an unknown bot", async () => {
    const { dataDir, call } = fixture();
    rememberRecipients(dataDir, "bot-1", ["boss@example.com"]);
    expect((await call("DELETE", "/api/settings/said-yes/recipient", { bot: "bot-1", recipient: "boss@example.com" }, "remote")).status).toBe(403);
    expect(sendTo(dataDir, "boss@example.com")).toBeNull();
    expect((await call("GET", "/api/settings/said-yes?bot=nobody")).status).toBe(404);
  });
});
