// Turning the off-machine listener on and off.
//
// The property under test is not "enable binds" — it is that overlapping
// calls cannot leave a socket bound with nothing holding a reference to it.
// That failure is invisible from inside the process: state() says disabled,
// the port says otherwise, and only a restart clears it.
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { RemoteListener } from "../src/listener.ts";

const ok = (_req: unknown, res: { end: (b: string) => void }) => res.end("ok");

/** A port nothing is using, released before it is handed back. */
const freePort = async (): Promise<number> => {
  const probe = createServer();
  const port = await new Promise<number>((resolve) =>
    probe.listen(0, "127.0.0.1", () => resolve((probe.address() as { port: number }).port)),
  );
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
};

/** Can this port be bound? The question "was anything left behind?" in the
 * only form that does not trust the object under test to answer honestly. */
const bindable = async (port: number): Promise<boolean> => {
  const probe = createServer();
  const result = await new Promise<boolean>((resolve) => {
    probe.once("error", () => resolve(false));
    probe.listen(port, "0.0.0.0", () => resolve(true));
  });
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return result;
};

let listeners: RemoteListener[] = [];
const track = (l: RemoteListener) => (listeners.push(l), l);

afterEach(async () => {
  for (const l of listeners) await l.disable();
  listeners = [];
});

describe("RemoteListener lifecycle", () => {
  it("leaves nothing bound when enable is called concurrently", async () => {
    const port = await freePort();
    const listener = track(new RemoteListener(ok as never, port));

    // Both calls see `this.server === null` and proceed to bind, unless the
    // transitions are serialised. The loser used to be left listening with
    // no reference to it anywhere.
    const states = await Promise.all([listener.enable(), listener.enable(), listener.enable()]);
    expect(states.every((s) => s.enabled)).toBe(true);
    expect(await bindable(port)).toBe(false);

    await listener.disable();
    expect(listener.running).toBe(false);
    // The real assertion. An orphaned server would still hold this.
    expect(await bindable(port)).toBe(true);
  });

  it("survives a disable racing an enable", async () => {
    const port = await freePort();
    const listener = track(new RemoteListener(ok as never, port));

    const [, off] = await Promise.all([listener.enable(), listener.disable()]);
    // Whichever order they settle in, the port must agree with the state.
    expect(await bindable(port)).toBe(!listener.running);
    expect(off.port).toBe(port);
  });

  it("reports a taken port instead of throwing", async () => {
    const port = await freePort();
    const squatter = createServer();
    await new Promise<void>((resolve) => squatter.listen(port, "0.0.0.0", resolve));
    try {
      const listener = track(new RemoteListener(ok as never, port));
      const state = await listener.enable();
      expect(state.enabled).toBe(false);
      expect(state.error).toContain("already in use");
      // and the failed attempt did not leave the object wedged
      expect(listener.running).toBe(false);
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  });

  it("is idempotent in both directions", async () => {
    const port = await freePort();
    const listener = track(new RemoteListener(ok as never, port));
    await listener.enable();
    await listener.enable();
    expect(listener.running).toBe(true);
    await listener.disable();
    await listener.disable();
    expect(listener.running).toBe(false);
    expect(await bindable(port)).toBe(true);
  });
});
