// The browser door's identity answer, and the installer's check of it.
//
// `murage setup` adopts and fronts a listener on the door port only when it
// proves it holds the nonce `murage start` recorded. The two halves live in
// different lanes and languages, so they are checked against each other on a
// real socket rather than trusted as two copies of one formula.
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  DOOR_CHALLENGE_HEADER,
  DOOR_PROOF_HEADER,
  DOOR_VERSION_HEADER,
  answerDoorChallenge,
  doorProof,
  takeDoorIdentity,
  type DoorIdentity,
} from "../src/door-identity.ts";

type Probe = {
  answered: boolean;
  status?: number;
  identity: "match" | "mismatch" | "unknown";
  ready: boolean;
  doorVersion: string | null;
  reason?: string;
};
type InstallerDoor = {
  doorProof: (nonce: string, challenge: string, version: string) => string;
  probeDoor: (opts: { port: number; nonce: string | null; version: string }) => Promise<Probe>;
};

const INSTALLER_DOOR = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "installer", "lib", "door-identity.mjs"),
).href;
const installer = (): Promise<InstallerDoor> => import(INSTALLER_DOOR);

const NONCE = randomBytes(32).toString("hex");
const IDENTITY: DoorIdentity = { nonce: NONCE, version: "0.1.52" };
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

/** A door whose own handler answers the way one branch of the real browser handler does. */
async function door(identity: DoorIdentity | null, respond: (req: IncomingMessage, res: ServerResponse) => void): Promise<number> {
  const server = createServer((req, res) => {
    answerDoorChallenge(req, res, identity);
    respond(req, res);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return (server.address() as { port: number }).port;
}

const page = (_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
  res.end("<!doctype html><title>enter</title>");
};
const signIn = (_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(401, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "sign in", signIn: "/enter" }));
};
const missing = (_req: IncomingMessage, res: ServerResponse) => {
  res.statusCode = 404;
  res.end();
};
const broken = (_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(503);
  res.end();
};

describe("door identity", () => {
  it("takes the nonce out of the environment, usable or not, so no child inherits it", () => {
    const env: NodeJS.ProcessEnv = { MURAGE_DOOR_NONCE: NONCE, MURAGE_DOOR_VERSION: "0.1.52", OTHER: "kept" };
    expect(takeDoorIdentity(env)).toEqual({ nonce: NONCE, version: "0.1.52" });
    expect(env).toEqual({ OTHER: "kept" });

    const malformed: NodeJS.ProcessEnv = { MURAGE_DOOR_NONCE: "not-hex", MURAGE_DOOR_VERSION: "0.1.52" };
    expect(takeDoorIdentity(malformed)).toBeNull();
    expect(malformed).toEqual({});

    expect(takeDoorIdentity({ MURAGE_DOOR_NONCE: NONCE, MURAGE_DOOR_VERSION: "0.1.52\nX-Injected: 1" })).toEqual({ nonce: NONCE, version: "unknown" });
    expect(takeDoorIdentity({})).toBeNull();
  });

  it("answers a challenge on a page, a sign-in refusal and a 404 alike, and never sends the nonce", async () => {
    for (const [respond, status] of [[page, 200], [signIn, 401], [missing, 404]] as const) {
      const port = await door(IDENTITY, respond);
      const challenge = randomBytes(32).toString("hex");
      const res = await fetch(`http://127.0.0.1:${port}/enter`, { headers: { [DOOR_CHALLENGE_HEADER]: challenge } });
      const body = await res.text();
      expect(res.status).toBe(status);
      expect(res.headers.get(DOOR_VERSION_HEADER)).toBe("0.1.52");
      expect(res.headers.get(DOOR_PROOF_HEADER)).toBe(doorProof(NONCE, challenge, "0.1.52"));
      expect([...res.headers.values()].join("\n") + body).not.toContain(NONCE);
    }
  });

  it("adds nothing without a well-formed challenge, or without an identity", async () => {
    const port = await door(IDENTITY, page);
    for (const headers of [{}, { [DOOR_CHALLENGE_HEADER]: "short" }, { [DOOR_CHALLENGE_HEADER]: "Z".repeat(64) }]) {
      const res = await fetch(`http://127.0.0.1:${port}/enter`, { headers });
      await res.text();
      expect(res.headers.get(DOOR_PROOF_HEADER)).toBeNull();
      expect(res.headers.get(DOOR_VERSION_HEADER)).toBeNull();
    }
    const desktop = await door(null, page);
    const res = await fetch(`http://127.0.0.1:${desktop}/enter`, { headers: { [DOOR_CHALLENGE_HEADER]: randomBytes(32).toString("hex") } });
    await res.text();
    expect(res.headers.get(DOOR_PROOF_HEADER)).toBeNull();
  });

  it("computes exactly the proof the installer computes", async () => {
    const { doorProof: installerProof } = await installer();
    for (let i = 0; i < 5; i += 1) {
      const nonce = randomBytes(32).toString("hex");
      const challenge = randomBytes(32).toString("hex");
      expect(installerProof(nonce, challenge, "0.1.52")).toBe(doorProof(nonce, challenge, "0.1.52"));
    }
  });

  it("is accepted by the installer's probe only with the right nonce and version, and ready only below 500", async () => {
    const { probeDoor } = await installer();
    const ours = await door(IDENTITY, page);
    expect(await probeDoor({ port: ours, nonce: NONCE, version: "0.1.52" })).toMatchObject({ identity: "match", ready: true, status: 200, doorVersion: "0.1.52" });

    const otherNonce = await probeDoor({ port: ours, nonce: randomBytes(32).toString("hex"), version: "0.1.52" });
    expect(otherNonce).toMatchObject({ answered: true, identity: "mismatch", ready: false });
    expect(otherNonce.reason).toMatch(/does not match/);

    const otherVersion = await probeDoor({ port: ours, nonce: NONCE, version: "0.1.53" });
    expect(otherVersion).toMatchObject({ identity: "mismatch", ready: false });
    expect(otherVersion.reason).toMatch(/installer 0\.1\.52.*this installer is 0\.1\.53/);

    const foreign = await door(null, page);
    expect(await probeDoor({ port: foreign, nonce: NONCE, version: "0.1.52" })).toMatchObject({ answered: true, status: 200, identity: "mismatch" });

    const notReady = await door(IDENTITY, broken);
    expect(await probeDoor({ port: notReady, nonce: NONCE, version: "0.1.52" })).toMatchObject({ identity: "match", ready: false, status: 503 });
  });
});
