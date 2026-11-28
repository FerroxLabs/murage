// SPDX-License-Identifier: AGPL-3.0-or-later
// One phone, one hand, across processes. A direct turn and a room turn each mount their own phone proxy, so the proxy's own queue
// cannot keep a clear-and-type pair whole when the other proxy sends a key between its steps. Every tool call holds this machine-wide
// lock for its whole run. The lock is a loopback listening port: only one process can hold it, the system frees it the moment the
// holder exits or is killed, and nothing is left on disk to go stale, so there is no takeover to race. A caller that cannot get it
// within the wait gets a retryable PhoneBusyError and does nothing to the phone: input is never sent without the lock.
import { createServer, type Server } from "node:net";

const DEFAULT_PORT = 48_573;
const POLL_MS = 40;
const WAIT_MS = 120_000;

export class PhoneBusyError extends Error {
  constructor() { super("The phone is busy with another turn's call"); this.name = "PhoneBusyError"; }
}

// MURAGE_PHONE_HAND_PORT names another port and MURAGE_PHONE_HAND_WAIT_MS another wait (tests give each case its own).
export const phoneHandWaitMs = (): number => {
  const named = Number(process.env.MURAGE_PHONE_HAND_WAIT_MS);
  return Number.isInteger(named) && named > 0 ? named : WAIT_MS;
};

export const phoneHandPort = (): number => {
  const named = Number(process.env.MURAGE_PHONE_HAND_PORT);
  return Number.isInteger(named) && named > 0 && named < 65_536 ? named : DEFAULT_PORT;
};

function tryHold(port: number): Promise<Server | null> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(null));
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
      server.removeAllListeners("error");
      server.on("error", () => {});
      server.unref();
      resolve(server);
    });
  });
}

export async function withPhoneHand<T>(run: () => Promise<T>, port: number = phoneHandPort(), waitMs: number = phoneHandWaitMs()): Promise<T> {
  const deadline = Date.now() + waitMs;
  let held = await tryHold(port);
  while (!held && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    held = await tryHold(port);
  }
  if (!held) throw new PhoneBusyError();
  try { return await run(); } finally { held.close(); }
}
