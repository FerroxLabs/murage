import { generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { CloudSessions } from "./cloud-sessions.ts";
import { createCloudRequestAuth } from "./cloud-request-auth.ts";
import { browserOwnerTier } from "./browser-owner-policy.ts";
import { artifactRelativePathParts } from "./artifacts.ts";

it("A5: an isolated Cloud auth fixture refuses setup, file and notebook writes from non-owners", async () => {
  vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
  const db = new DatabaseSync(":memory:");
  const sessions = new CloudSessions(db);
  const id = randomUUID();
  const key = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
  db.prepare("INSERT OR IGNORE INTO cloud_meta VALUES ('account','owner')").run();
  db.prepare("INSERT INTO cloud_devices (id,account,scope,publicKey,assertionKey,revoked,addedAt,lastSeenAt) VALUES (?,?,?,?,?,0,0,0)").run(id, "owner", "browser", key, key);
  const token = sessions.issue(id).accessToken;
  const auth = createCloudRequestAuth({ sessions, publicOrigin: "https://home.example", bootstrapSecret: () => "fixture-bootstrap-key-32-characters" });
  let reached = 0;
  const server = createServer(async (req, res) => {
    if (await auth(req, res, new URL(req.url!, "https://home.example"))) return;
    reached++;
    res.end("reached");
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const cookie of ["", `__Host-murage=${token}`]) {
      for (const [method, path] of [
        ["POST", "/api/workspace-files/write"], ["POST", "/api/workspace-files/save-version"], ["POST", "/api/artifacts"],
        ["PUT", "/api/bots/b1/general-notes"], ["PUT", "/api/bots/b1/memory"],
        ["POST", "/api/setup/answer"], ["POST", "/api/setup/skip"], ["POST", "/api/setup/reopen"],
        ["POST", "/api/setup/hire"], ["POST", "/api/setup/routine"], ["POST", "/api/setup/card"], ["POST", "/api/setup/backup"],
        ["PUT", "/api/%62ots/b1/memory"], ["POST", "/api//setup/hire"], ["POST", "/api/setup/hire/"],
      ]) {
        const answer = await fetch(url + path, { method, headers: { host: "home.example", origin: "https://home.example", cookie, "content-type": "application/json" }, body: "{}" });
        expect(answer.status, `${cookie ? "chat-only" : "unproven"} ${method} ${path}`).toBe(403);
        expect(await answer.text()).not.toContain("reached");
      }
    }
    expect(reached).toBe(0);
    // Control: this device is valid for chat reads; the refusals are write authority.
    expect((await fetch(url + "/api/inbox", { headers: { host: "home.example", origin: "https://home.example", cookie: `__Host-murage=${token}` } })).status).toBe(200);
    expect(reached).toBe(1);
  } finally {
    const closed = once(server, "close"); server.close(); server.closeAllConnections(); await closed;
    db.close(); vi.unstubAllEnvs();
  }
});

it("A5: private skill, instruction, hook and MCP paths cannot pass workspace validation", () => {
  for (const path of ["skills/x.md", "AGENTS.md", "CLAUDE.md", "memory/x.md", ".claude/settings.json", ".claude/hooks/x.md", ".mcp.json", "../instructions/x.md"]) {
    expect(() => artifactRelativePathParts(path), path).toThrow();
  }
  expect(artifactRelativePathParts("reports/notes.md")).toEqual(["reports", "notes.md"]);
  for (const path of ["/api/%62ots/b1/memory", "/api//setup/hire", "/api/setup/hire/"]) {
    if (path.includes("%") || path.includes("//")) expect(browserOwnerTier("PUT", path).tier).toBe("refused");
  }
});
