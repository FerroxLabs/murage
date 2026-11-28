// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// q1022-connparity (MAIN-RULING 2026-11-25T17:42:59Z CONNPARITY-1022, part 1). Owners: this file, the Test route in
// index.ts and the `chat` option of mcp-probe.ts = q1022-connparity (MurageMain desktop). The wrapper it serves
// (mcp-wipe-proxy.ts, mcp-bridge.ts, proxy-turn-release.ts) and the turn release door (turn-release-door.ts,
// consuming-turn-ingress.ts) = their existing owners (memv2 / cause22 lanes), unchanged here.
//
// Settings → Test for a COMMAND server starts the same wrapper process a chat mounts. That wrapper may hand on
// nothing until the release door admits each chunk it reads and issues a permit for each frame it writes. In a chat
// the door answers for the TURN (its consuming binding and budget). A Test has no turn, no engine and no memory
// context, so it cannot use a turn's authority and must never be able to borrow one. This is the Test's own, much
// smaller authority at the same door:
//   - one instance per Test, with a random token that exists only while that Test runs;
//   - the only reader of what it releases is the Test route in this process (tool names for the Settings panel);
//     nothing it permits can reach an engine: an engine's relay accepts only envelopes of its own turn's instance;
//   - a fixed byte allowance, far above what a Test may read (mcp-probe.ts caps server output at 1 MiB); past it the
//     door refuses and the Test fails. No turn is ever stopped by it (MAIN-RULING local-memory-budget: not a turn);
//   - it holds no binding, so it can never answer for, seal or spend a turn's instance: the two token tables are
//     disjoint and a token this table does not hold falls through to the turn door untouched.
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody } from "./read-body.ts";

/** Everything one Test's wrapper may reserve at the door: each chunk it reads, each verdict answer and each envelope. */
export const TEST_RELEASE_BUDGET_BYTES = 12 * 1024 * 1024;
const TEST_DESCRIPTOR = "proxy:wipeMcp:frame";
const MAX_DOOR_BODY = 2 * 1024 * 1024;
const MAX_PENDING_PERMITS = 4;

export interface TestRelease {
  /** The wrapper's MURAGE_RELEASE_* environment, exactly the three names an admitted chat mount carries. */
  readonly env: { MURAGE_RELEASE_INSTANCE: string; MURAGE_RELEASE_TOKEN: string; MURAGE_RELEASE_URL: string };
  /** One line of the wrapper's stdout: the frame it carries and the acknowledgement the wrapper waits for.
   * Throws (and closes this release) unless the line is an envelope this release issued, offered once, in order. */
  accept(line: string): { frame: string; ack: { type: "turn-release-ack"; instanceId: string; sequence: number } };
  dispose(): void;
}

interface Instance { instanceId: string; left: number; sealed: boolean; sequence: number; issued: Map<number, { permit: string; frame: string }> }

const bearer = (authorization: string | string[] | undefined): string =>
  typeof authorization === "string" && authorization.startsWith("Bearer ") ? authorization.slice(7) : "";

export function createTestReleaseAuthority() {
  const byToken = new Map<string, Instance>();
  const deny = (res: ServerResponse) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(409, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end("This connection test has ended.");
  };
  return Object.freeze({
    /** True only while a Test this table opened is running and `authorization` carries its token. */
    owns(authorization: string | string[] | undefined): boolean { return byToken.has(bearer(authorization)); },
    open(url: string): TestRelease {
      const token = `mtr_${randomBytes(32).toString("base64url")}`;
      const instance: Instance = { instanceId: randomBytes(24).toString("base64url"), left: TEST_RELEASE_BUDGET_BYTES, sealed: false, sequence: 0, issued: new Map() };
      byToken.set(token, instance);
      const dispose = () => { instance.sealed = true; instance.issued.clear(); byToken.delete(token); };
      return Object.freeze({
        env: Object.freeze({ MURAGE_RELEASE_INSTANCE: instance.instanceId, MURAGE_RELEASE_TOKEN: token, MURAGE_RELEASE_URL: url }),
        dispose,
        accept(line: string) {
          try {
            const value = JSON.parse(line) as { permit?: unknown; instanceId?: unknown; sequence?: unknown; frame?: unknown };
            const issued = typeof value?.sequence === "number" ? instance.issued.get(value.sequence) : undefined;
            if (instance.sealed || !issued || Object.keys(value).sort().join() !== "frame,instanceId,permit,sequence"
              || value.instanceId !== instance.instanceId || value.permit !== issued.permit || value.frame !== issued.frame
              || value.sequence !== instance.sequence + 1) throw new Error("TEST_RELEASE_REFUSED");
            instance.issued.delete(value.sequence as number);
            instance.sequence = value.sequence as number;
            return { frame: issued.frame, ack: { type: "turn-release-ack" as const, instanceId: instance.instanceId, sequence: instance.sequence } };
          } catch { dispose(); throw new Error("TEST_RELEASE_REFUSED"); }
        },
      });
    },
    /** The door for a Test's wrapper: the two operations the turn door has (turn-release-door.ts), answered for the Test. */
    async door(req: IncomingMessage, res: ServerResponse, json: (res: ServerResponse, status: number, body: unknown) => void): Promise<void> {
      const instance = byToken.get(bearer(req.headers.authorization));
      if (!instance || instance.sealed || req.method !== "POST") return deny(res);
      try {
        const body = await readBody(req, MAX_DOOR_BODY) as Record<string, unknown> | null;
        if (!body || typeof body !== "object" || Array.isArray(body) || body.instanceId !== instance.instanceId || instance.sealed) throw new Error("TEST_RELEASE_REFUSED");
        if (body.operation === "upstream") {
          if (Object.keys(body).sort().join() !== "bytes,instanceId,operation" || !Number.isSafeInteger(body.bytes) || (body.bytes as number) < 0
            || (body.bytes as number) > instance.left) throw new Error("TEST_RELEASE_REFUSED");
          instance.left -= body.bytes as number;
          return json(res, 200, { reserved: true });
        }
        if (Object.keys(body).sort().join() !== "bytes,descriptor,digest,frame,instanceId,requestId,sequence" || body.descriptor !== TEST_DESCRIPTOR
          || typeof body.frame !== "string" || /[\r\n]/.test(body.frame) || body.bytes !== Buffer.byteLength(body.frame)
          || body.digest !== createHash("sha256").update(body.frame, "utf8").digest("hex")
          || !Number.isSafeInteger(body.sequence) || (body.sequence as number) < 1 || instance.issued.has(body.sequence as number)
          // the wrapper offers one frame at a time; a permit is charged like any other byte this Test may read
          || instance.issued.size >= MAX_PENDING_PERMITS || (body.bytes as number) > instance.left) throw new Error("TEST_RELEASE_REFUSED");
        instance.left -= body.bytes as number;
        const rpc = JSON.parse(body.frame) as { jsonrpc?: unknown; id?: unknown } | null;
        if (!rpc || typeof rpc !== "object" || Array.isArray(rpc) || rpc.jsonrpc !== "2.0" || body.requestId !== (rpc.id ?? null)) throw new Error("TEST_RELEASE_REFUSED");
        const permit = randomBytes(32).toString("base64url");
        instance.issued.set(body.sequence as number, { permit, frame: body.frame });
        return json(res, 200, { permit, instanceId: instance.instanceId, sequence: body.sequence, frame: body.frame });
      } catch {
        // Fail closed: one refused request ends this Test's authority; the wrapper seals and the Test reports a failure.
        instance.sealed = true; instance.issued.clear();
        return deny(res);
      }
    },
  });
}
export type TestReleaseAuthority = ReturnType<typeof createTestReleaseAuthority>;
