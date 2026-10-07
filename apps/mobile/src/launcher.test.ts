// The launcher's decisions, driven through a fake MurageShell and a fake
// draw: which screen follows each call, answer and close (P22 rulings).
import { afterEach, describe, expect, it, vi } from "vitest";

import { COPY } from "./invitation";
import { createLauncher, type Draft } from "./launcher";
import type { Action, Screen, View } from "./screens";
import type { Closed, MurageShellPlugin, SavedWorkspace, ShellState } from "./shell-types";

const MAC: SavedWorkspace = { origin: "https://mac.tailnet123.ts.net", name: "Sean's Mac", lastConnected: 1 };
const SECRET = "Zq9_credential-NEVER-SHOWN";
const LINK = `${MAC.origin}/enter#${SECRET}`;

/** A deferred answer, so a test decides when (and how) native replies. */
function later<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const fail = (code: string) => Object.assign(new Error(code), { code });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

type Answer<T> = T | Error | ReturnType<typeof later<T>>;

function fakeShell(start: Partial<ShellState> = {}) {
  const calls: string[] = [];
  const opens: { origin: string; credential?: string }[] = [];
  let state: ShellState = { workspaces: [], active: null, closed: null, platform: "ios", tailscale: { installed: null, connected: null }, ...start };
  let onClose: ((closed: Closed) => void) | null = null;
  let onNotice: ((notice: { code: string }) => void) | null = null;
  const queue: Record<string, Answer<unknown>[]> = { state: [], scan: [], open: [], remove: [], openTailscale: [] };
  const answer = async <T,>(name: string, fallback: () => T): Promise<T> => {
    const next = queue[name]!.shift();
    if (next === undefined) return fallback();
    if (next instanceof Error) throw next;
    if (next && typeof next === "object" && "promise" in next) return (next as ReturnType<typeof later<T>>).promise;
    return next as T;
  };
  const plugin: MurageShellPlugin = {
    state: () => (calls.push("state"), answer("state", () => state)),
    scan: () => (calls.push("scan"), answer("scan", () => ({ text: LINK }))),
    open: (options) => (calls.push("open"), opens.push(options), answer("open", () => ({ mode: "full" as const, hostCapability: 2 }))),
    remove: (options) => (calls.push(`remove ${options.origin}`), answer("remove", () => undefined)),
    openTailscale: () => (calls.push("openTailscale"), answer("openTailscale", () => undefined)),
    addListener: (async (event: string, listener: unknown) => {
      calls.push(`addListener ${event}`);
      if (event === "notice") onNotice = listener as (notice: { code: string }) => void;
      else onClose = listener as (closed: Closed) => void;
      return {
        remove: async () => {
          calls.push("removeListener");
          if (event === "notice") onNotice = null;
          else onClose = null;
        },
      };
    }) as MurageShellPlugin["addListener"],
  };
  return {
    plugin,
    calls,
    opens,
    queue,
    setState: (next: Partial<ShellState>) => (state = { ...state, ...next }),
    close: (closed: Closed) => onClose?.(closed),
    notice: (notice: { code: string }) => onNotice?.(notice),
    listening: () => onClose !== null,
  };
}

function harness(start: Partial<ShellState> = {}, visible: () => boolean = () => true) {
  const shell = fakeShell(start);
  const views: View[] = [];
  const screens: (Screen | null)[] = [];
  const drafts: (Draft | undefined)[] = [];
  const keeps: boolean[] = [];
  let act: ((action: Action, form?: { address: string; code: string }) => void) | null = null;
  let clock = 1_000_000;
  const launcher = createLauncher(shell.plugin, (view, onAct, draft, keep) => {
    views.push(view);
    drafts.push(draft);
    keeps.push(keep === true);
    screens.push(launcher.screen);
    act = onAct;
  }, () => clock, visible);
  const view = () => views[views.length - 1]!;
  const tap = async (label: string, form?: { address: string; code: string }) => {
    const v = view();
    const action = [...v.actions, ...v.rows.flatMap((r) => r.actions)].find((a) => a.label === label);
    if (!action) throw new Error(`no "${label}" on "${v.title}": ${v.actions.map((a) => a.label).join(", ")}`);
    act!(action, form);
    await tick();
  };
  return {
    shell,
    launcher,
    views,
    screens,
    drafts,
    keeps,
    view,
    tap,
    screen: (): Screen | null => launcher.screen,
    advance: (ms: number) => (clock += ms),
  };
}

describe("starting up", () => {
  it("listens for closes before it asks for the saved computers", async () => {
    const h = harness({ workspaces: [MAC] });
    await h.launcher.boot();
    expect(h.shell.calls.slice(0, 3)).toEqual(["addListener workspaceClosed", "addListener notice", "state"]);
    expect(h.screen()).toEqual({ kind: "list", managing: false });
  });

  it("asks to unlock when the saved computers can't be read, never a welcome", async () => {
    const h = harness();
    h.shell.queue.state!.push(fail("unreadable"));
    await h.launcher.boot();
    expect(h.screen()).toEqual({ kind: "unreadable" });
    expect(h.views.map((v) => v.title)).not.toContain("Murage on your phone");
  });

  it("offers Try again when state() fails any other way, and Try again asks again", async () => {
    const h = harness({ workspaces: [MAC] });
    h.shell.queue.state!.push(new Error("no code at all"));
    await h.launcher.boot();
    expect(h.screen()).toEqual({ kind: "startFailed" });
    await h.tap("Try again");
    expect(h.shell.calls.filter((c) => c === "state")).toHaveLength(2);
    expect(h.screen()).toEqual({ kind: "list", managing: false });
  });

  it("Try again on the unlock screen shows a close that came while the list was locked", async () => {
    const h = harness({ workspaces: [MAC] });
    await h.launcher.boot();
    h.shell.queue.state!.push(fail("unreadable"));
    h.shell.close({ origin: MAC.origin, reason: "signedOut" });
    await tick();
    expect(h.screen()).toEqual({ kind: "unreadable" });
    await h.tap("Try again");
    expect(h.screen()).toEqual({ kind: "repair", origin: MAC.origin });
  });

  it("a close that arrives during start-up is not painted over by the start screen", async () => {
    const h = harness({ workspaces: [MAC] });
    const slow = later<ShellState>();
    h.shell.queue.state!.push(slow);
    const booting = h.launcher.boot();
    await tick();
    // Native hands the retained close to the new listener; state() no longer carries it.
    h.shell.close({ origin: MAC.origin, reason: "unreachable" });
    await tick();
    slow.resolve({ workspaces: [MAC], active: null, closed: null, platform: "ios", tailscale: { installed: null, connected: null } });
    await booting;
    await tick();
    expect(h.screen()).toEqual({ kind: "unreachable", origin: MAC.origin });
  });

  it("shows the close state() hands over", async () => {
    const h = harness({ workspaces: [MAC], closed: { origin: MAC.origin, reason: "insecure" } });
    await h.launcher.boot();
    expect(h.screen()).toEqual({ kind: "insecure", origin: MAC.origin });
  });
});

describe("a workspace closing", () => {
  it("maps each close with screenForClose, and stops listening when the page goes", async () => {
    const h = harness({ workspaces: [MAC] });
    await h.launcher.boot();
    h.shell.close({ origin: MAC.origin, reason: "signedOut" });
    await tick();
    expect(h.screen()).toEqual({ kind: "repair", origin: MAC.origin });
    h.shell.close({ origin: MAC.origin, reason: "launcher" });
    await tick();
    expect(h.screen()).toEqual({ kind: "list", managing: false });
    await h.launcher.dispose();
    expect(h.shell.calls).toContain("removeListener");
    expect(h.shell.listening()).toBe(false);
  });
});

describe("pairing and opening", () => {
  it("scans, opens with the credential, and lands on the list", async () => {
    const h = harness();
    await h.launcher.boot();
    await h.tap("Yes, let's connect");
    await h.tap("I see the code, scan it");
    expect(h.shell.opens).toEqual([{ origin: MAC.origin, credential: SECRET }]);
    h.shell.setState({ workspaces: [MAC] });
    expect(h.views.some((v) => v.busy)).toBe(true);
  });

  it("Try again after a failed pairing reuses the credential, held in memory only", async () => {
    const h = harness();
    await h.launcher.boot();
    h.shell.queue.open!.push(fail("unreachable"));
    await h.tap("Yes, let's connect");
    await h.tap("I see the code, scan it");
    // Tailscale unknown: the diagnosis words itself as can't-reach.
    expect(h.screen()).toEqual({ kind: "pairUnreachable", origin: MAC.origin });
    h.shell.queue.open!.push(fail("unreachable"));
    await h.tap("Try again");
    await h.tap("Open Tailscale"); // staying on the screen keeps it
    await h.tap("Try again");
    expect(h.shell.opens).toEqual([
      { origin: MAC.origin, credential: SECRET },
      { origin: MAC.origin, credential: SECRET },
      { origin: MAC.origin, credential: SECRET },
    ]);
    const shown = JSON.stringify([h.views, h.drafts]);
    expect(shown).not.toContain(SECRET);
  });

  it("forgets the credential once the pairing succeeds", async () => {
    const h = harness();
    await h.launcher.boot();
    await h.tap("Yes, let's connect");
    await h.tap("I see the code, scan it");
    h.shell.setState({ workspaces: [MAC] });
    h.shell.close({ origin: MAC.origin, reason: "unreachable" });
    await tick();
    await h.tap("Try again");
    expect(h.shell.opens[1]).toEqual({ origin: MAC.origin });
  });

  it("forgets the credential when the person leaves the flow", async () => {
    const h = harness({ workspaces: [MAC] });
    await h.launcher.boot();
    await h.tap("Add another computer");
    h.shell.queue.open!.push(fail("insecure"));
    await h.tap("Scan the code");
    expect(h.screen()).toEqual({ kind: "insecure", origin: MAC.origin });
    const retry = h.view().actions.find((a) => a.id === "retry")!;
    await h.tap("Back");
    // A Try again that lands after Back (a quick double tap) no longer pairs.
    await h.launcher.act(retry);
    await tick();
    expect(h.shell.opens[1]).toEqual({ origin: MAC.origin });
  });

  it("types an address and code, and keeps the typed address when it is wrong (never the code)", async () => {
    const h = harness();
    await h.launcher.boot();
    h.shell.queue.scan!.push(fail("cancelled"));
    await h.tap("Yes, let's connect");
    await h.tap("I see the code, scan it");
    await h.tap("Type the code instead");
    await h.tap("Connect", { address: "https//mac", code: "123456" });
    expect(h.screen()).toEqual({ kind: "type", error: COPY.badAddress });
    expect(h.drafts[h.drafts.length - 1]).toEqual({ address: "https//mac" });
    await h.tap("Connect", { address: "mac.tailnet123.ts.net", code: "123 456" });
    expect(h.shell.opens).toEqual([{ origin: MAC.origin, credential: "123456" }]);
    expect(JSON.stringify(h.drafts)).not.toContain("123");
  });

  it("a pasted pairing link comes back without its secret (fix round 1)", async () => {
    const h = harness();
    await h.launcher.boot();
    h.shell.queue.scan!.push(fail("cancelled"));
    await h.tap("Yes, let's connect");
    await h.tap("I see the code, scan it");
    await h.tap("Type the code instead");
    await h.tap("Connect", { address: LINK, code: "12" });
    expect(h.view().error).toBe(COPY.badCode);
    expect(h.drafts[h.drafts.length - 1]).toEqual({ address: `${MAC.origin}/enter` });
    expect(JSON.stringify([h.views, h.drafts])).not.toContain(SECRET);
  });

  it("keeps the open error when refreshing afterwards fails too", async () => {
    const h = harness({ workspaces: [MAC] });
    await h.launcher.boot();
    h.shell.queue.open!.push(fail("unreachable"));
    h.shell.queue.state!.push(fail("unavailable"));
    await h.tap(`Open ${MAC.name}`);
    expect(h.screen()).toEqual({ kind: "unreachable", origin: MAC.origin });
  });

  it("busy changes nothing: the screen the tap came from comes back", async () => {
    const h = harness({ workspaces: [MAC] });
    await h.launcher.boot();
    h.shell.queue.open!.push(fail("busy"));
    await h.tap(`Open ${MAC.name}`);
    expect(h.screen()).toEqual({ kind: "list", managing: false });
  });

  it("goes through screenForStateError when refreshing after an open fails", async () => {
    const h = harness({ workspaces: [MAC] });
    await h.launcher.boot();
    h.shell.queue.state!.push(fail("unreadable"));
    await h.tap(`Open ${MAC.name}`);
    expect(h.screen()).toEqual({ kind: "unreadable" });
  });

  it("ignores Open, Retry, Connect and Scan while an open or a scan is on its way", async () => {
    const h = harness({ workspaces: [MAC] });
    await h.launcher.boot();
    const open = later<{ mode: "full"; hostCapability: number }>();
    h.shell.queue.open!.push(open);
    const list = h.view();
    const openAction = list.rows[0]!.actions[0]!;
    await h.tap(`Open ${MAC.name}`);
    // A second tap from the list painted before, as a fast double tap would land.
    h.launcher.act(openAction);
    h.launcher.act({ id: "scan", label: "Scan the code" });
    await tick();
    expect(h.shell.calls.filter((c) => c === "open" || c === "scan")).toEqual(["open"]);
    open.resolve({ mode: "full", hostCapability: 2 });
    await tick();

    const scan = later<{ text: string }>();
    h.shell.queue.scan!.push(scan);
    await h.tap("Add another computer");
    await h.tap("Scan the code");
    h.launcher.act({ id: "scan", label: "Scan the code" });
    h.launcher.act(openAction);
    await tick();
    expect(h.shell.calls.filter((c) => c === "open" || c === "scan")).toEqual(["open", "scan"]);
    scan.reject(fail("cancelled"));
    await tick();
    expect(h.screen()).toEqual({ kind: "welcome" });
  });
});

describe("scanning", () => {
  it("cancelled leaves the screen alone", async () => {
    const h = harness({ workspaces: [MAC] });
    await h.launcher.boot();
    await h.tap("Add another computer");
    const before = h.views.length;
    h.shell.queue.scan!.push(fail("cancelled"));
    await h.tap("Scan the code");
    expect(h.views).toHaveLength(before);
    expect(h.screen()).toEqual({ kind: "welcome" });
  });

  it("on Android, unavailable twice in a row stops promising (the current screen goes in)", async () => {
    const h = harness({ platform: "android" });
    await h.launcher.boot();
    h.shell.queue.scan!.push(fail("unavailable"), fail("unavailable"));
    await h.tap("Yes, let's connect");
    await h.tap("I see the code, scan it");
    expect(h.screen()).toEqual({ kind: "scanner", problem: "gettingReady" });
    await h.tap("Try again");
    expect(h.screen()).toEqual({ kind: "scanner", problem: "notAvailable" });
  });

  it("keeps the re-pair computer through the scanner's screens", async () => {
    const h = harness({ workspaces: [MAC], closed: { origin: MAC.origin, reason: "signedOut" } });
    await h.launcher.boot();
    h.shell.queue.scan!.push(fail("camera_denied"));
    await h.tap("Scan the code");
    expect(h.screen()).toEqual({ kind: "scanner", problem: "cameraDenied", origin: MAC.origin });
    await h.tap("Type the address instead");
    expect(h.screen()).toEqual({ kind: "type", origin: MAC.origin });
  });

  it("says 'not a pairing code' on the screen the scan came from, never the welcome", async () => {
    const h = harness({ workspaces: [MAC], closed: { origin: MAC.origin, reason: "signedOut" } });
    await h.launcher.boot();
    h.shell.queue.scan!.push({ text: "https://example.com/" });
    await h.tap("Scan the code");
    expect(h.screen()).toEqual({ kind: "repair", origin: MAC.origin, error: COPY.notACode });
    expect(h.shell.opens).toEqual([]);

    const a = harness({ platform: "android" });
    await a.launcher.boot();
    a.shell.queue.scan!.push(fail("unavailable"), { text: "not a link" });
    await a.tap("Yes, let's connect");
    await a.tap("I see the code, scan it");
    await a.tap("Try again");
    expect(a.screen()).toEqual({ kind: "scanner", problem: "gettingReady", error: COPY.notACode });
    expect(a.view().error).toBe(COPY.notACode);
  });
});

describe("removing and Tailscale", () => {
  it("removes, then shows what is left", async () => {
    const h = harness({ workspaces: [MAC] });
    await h.launcher.boot();
    await h.tap("Edit");
    h.shell.setState({ workspaces: [] });
    await h.tap("Remove");
    expect(h.shell.calls).toContain(`remove ${MAC.origin}`);
    expect(h.screen()).toEqual({ kind: "welcome" });
  });

  it("maps a failed remove with screenForRemoveError", async () => {
    const h = harness({ workspaces: [MAC] });
    await h.launcher.boot();
    await h.tap("Edit");
    h.shell.queue.remove!.push(fail("unreadable"));
    await h.tap("Remove");
    expect(h.screen()).toEqual({ kind: "unreadable" });
  });

  it("a failed remove still asks to unlock when the list then can't be read (fix round 1)", async () => {
    const h = harness({ workspaces: [MAC] });
    await h.launcher.boot();
    await h.tap("Edit");
    h.shell.queue.remove!.push(fail("unavailable"));
    h.shell.queue.state!.push(fail("unreadable"));
    await h.tap("Remove");
    expect(h.screen()).toEqual({ kind: "unreadable" });
  });

  it("stays on can't-reach, with a sentence, when Tailscale won't open", async () => {
    const h = harness({ workspaces: [MAC], closed: { origin: MAC.origin, reason: "unreachable" } });
    await h.launcher.boot();
    h.shell.queue.openTailscale!.push(fail("unavailable"));
    await h.tap("Open Tailscale");
    expect(h.screen()).toMatchObject({ kind: "unreachable", origin: MAC.origin });
    expect(h.view().error).toMatch(/couldn't open Tailscale/);
  });
});

describe("Tailscale on this phone", () => {
  it("can't reach with Tailscale off: says so, and Open Tailscale opens it", async () => {
    const h = harness({ workspaces: [MAC], tailscale: { installed: true, connected: false } });
    await h.launcher.boot();
    h.shell.queue.open!.push(fail("unreachable"));
    await h.tap(`Open ${MAC.name}`);
    expect(h.screen()).toEqual({ kind: "unreachable", origin: MAC.origin });
    expect(h.view().lines[0]).toBe("Tailscale is off on this phone. Turn it on, then try again.");
    expect(h.view().actions.find((a) => a.primary)?.label).toBe("Open Tailscale");
    await h.tap("Open Tailscale");
    expect(h.shell.calls.at(-1)).toBe("openTailscale");
  });

  it("reads Tailscale fresh after a failed open, not from start-up", async () => {
    const h = harness({ workspaces: [MAC], tailscale: { installed: true, connected: true } });
    await h.launcher.boot();
    h.shell.setState({ tailscale: { installed: true, connected: false } });
    h.shell.queue.open!.push(fail("unreachable"));
    await h.tap(`Open ${MAC.name}`);
    expect(h.view().lines[0]).toBe("Tailscale is off on this phone. Turn it on, then try again.");
  });

  it("adding a computer waits for its origin before suggesting Tailscale", async () => {
    const h = harness({ platform: "android", workspaces: [MAC], tailscale: { installed: false, connected: false } });
    await h.launcher.boot();
    await h.tap("Add another computer");
    expect(h.screen()).toEqual({ kind: "welcome" });
    expect(JSON.stringify(h.view())).not.toMatch(/tailscale/i);
  });

  it("a native answer without Tailscale fields keeps the general wording", async () => {
    const h = harness({ workspaces: [MAC], closed: { origin: MAC.origin, reason: "unreachable" } });
    h.shell.setState({ tailscale: undefined as never });
    await h.launcher.boot();
    expect(h.view().lines[0]).toBe("Check that Tailscale is on and signed in to the same account on your phone and computer.");
  });

  it("coming back retries and refreshes the diagnosis if the host is still unreachable", async () => {
    const h = harness({ workspaces: [MAC], closed: { origin: MAC.origin, reason: "unreachable" }, tailscale: { installed: true, connected: false } });
    await h.launcher.boot();
    h.shell.setState({ closed: null, tailscale: { installed: true, connected: true } });
    h.shell.queue.open!.push(fail("unreachable"));
    await h.launcher.resume();
    expect(h.screen()).toEqual({ kind: "unreachable", origin: MAC.origin });
    expect(h.view().lines[0]).toBe("Check that Tailscale is on and signed in to the same account on your phone and computer.");
  });

  it("coming back while an open is on its way, or when state() fails, changes nothing", async () => {
    const h = harness({ workspaces: [MAC] });
    await h.launcher.boot();
    const open = later<{ mode: "full"; hostCapability: number }>();
    h.shell.queue.open!.push(open);
    await h.tap(`Open ${MAC.name}`);
    const painted = h.views.length;
    const reads = h.shell.calls.filter((c) => c === "state").length;
    await h.launcher.resume();
    expect(h.views.length).toBe(painted);
    expect(h.shell.calls.filter((c) => c === "state").length).toBe(reads);
    open.resolve({ mode: "full", hostCapability: 2 });
    await tick();
    const after = h.views.length;
    h.shell.queue.state!.push(fail("unreadable"));
    await h.launcher.resume();
    expect(h.views.length).toBe(after);
    expect(h.screen()).toEqual({ kind: "list", managing: false });
  });

  it("coming back with nothing changed draws nothing (focus and scroll stay put)", async () => {
    for (const start of [{ workspaces: [MAC] }, {}]) {
      const h = harness(start);
      await h.launcher.boot();
      h.shell.setState({ closed: null });
      const painted = h.views.length;
      const before = h.screen();
      await h.launcher.resume();
      await h.launcher.resume();
      expect(h.views.length).toBe(painted);
      expect(h.screen()).toEqual(before);
    }
  });

  it("coming back to the same screen with something new redraws it in place, keeping focus and scroll", async () => {
    // The list's "Last connected" moves on with the clock: same screen, redrawn in place.
    const l = harness({ workspaces: [MAC] });
    await l.launcher.boot();
    l.advance(10 * 60_000);
    await l.launcher.resume();
    expect(l.views.length).toBe(2);
    expect(l.keeps.at(-1)).toBe(true);
  });

  it("a recovery attempt replaces stale Tailscale launch errors with its connection result", async () => {
    const h = harness({ workspaces: [MAC], closed: { origin: MAC.origin, reason: "unreachable" }, tailscale: { installed: true, connected: false } });
    await h.launcher.boot();
    h.shell.queue.openTailscale!.push(fail("unavailable"));
    await h.tap("Open Tailscale");
    const error = h.view().error;
    expect(error).toMatch(/couldn't open Tailscale/);
    h.shell.setState({ closed: null, tailscale: { installed: null, connected: null } });
    h.shell.queue.open!.push(fail("unreachable"));
    await h.launcher.resume();
    expect(h.view().error).toBeUndefined();
    expect(h.screen()).toEqual({ kind: "unreachable", origin: MAC.origin });
  });

  it("a tap while coming back still goes through (its own flag, not the open's)", async () => {
    const h = harness({ workspaces: [MAC] });
    await h.launcher.boot();
    const slow = later<ShellState>();
    h.shell.queue.state!.push(slow);
    const resuming = h.launcher.resume();
    await tick();
    await h.tap(`Open ${MAC.name}`);
    expect(h.shell.calls).toContain("open");
    slow.resolve({ workspaces: [MAC], active: null, closed: null, platform: "ios", tailscale: { installed: null, connected: null } });
    await resuming;
  });

  it("a close handed over while something newer painted is kept, and shown on the next start", async () => {
    const h = harness({ workspaces: [MAC] });
    await h.launcher.boot();
    const slow = later<ShellState>();
    h.shell.queue.state!.push(slow);
    const resuming = h.launcher.resume();
    await tick();
    await h.tap("Edit"); // paints meanwhile
    slow.resolve({ workspaces: [MAC], active: null, closed: { origin: MAC.origin, reason: "signedOut" }, platform: "ios", tailscale: { installed: null, connected: null } });
    await resuming;
    expect(h.screen()).toEqual({ kind: "list", managing: true });
    await h.launcher.boot();
    expect(h.screen()).toEqual({ kind: "repair", origin: MAC.origin });
  });

  it("coming back shows a close state() hands over", async () => {
    const h = harness({ workspaces: [MAC] });
    await h.launcher.boot();
    h.shell.setState({ closed: { origin: MAC.origin, reason: "signedOut" } });
    await h.launcher.resume();
    expect(h.screen()).toEqual({ kind: "repair", origin: MAC.origin });
  });
});

const OFF = { installed: true, connected: false };
const ON = { installed: true, connected: true };
const MISSING = { installed: false, connected: false };
const IOS_OFF = { installed: null, connected: false };

describe("first run (2026-09-27 first-run spec)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  /** Only the interval is faked: the harness's tick() still needs a real setTimeout. */
  const fakeInterval = () => vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

  /** Boots with no saved computers, scans, and the open fails unreachable with this Tailscale. */
  async function failedPairing(tailscale: ShellState["tailscale"], platform: ShellState["platform"] = "ios") {
    const h = harness({ platform, tailscale });
    await h.launcher.boot();
    h.shell.queue.open!.push(fail("unreachable"));
    await h.tap("Yes, let's connect");
    await h.tap("I see the code, scan it");
    return h;
  }

  it("welcomes a new person; Yes, let's connect gets the code ready first, asking native nothing", async () => {
    const h = harness();
    await h.launcher.boot();
    expect(h.screen()).toEqual({ kind: "welcome" });
    expect(h.view().title).toBe("Murage on your phone");
    const before = h.shell.calls.length;
    await h.tap("Yes, let's connect");
    // Android's scanner covers the whole screen, so where the code is gets said before it opens.
    expect(h.screen()).toEqual({ kind: "getCode" });
    expect(h.view()).toMatchObject({ title: "Get your code ready", step: 2 });
    expect(h.shell.calls.slice(before)).toEqual([]);
  });

  it("I see the code, scan it opens the camera, with the hint behind it", async () => {
    const h = harness();
    await h.launcher.boot();
    const scan = later<{ text: string }>();
    h.shell.queue.scan!.push(scan);
    await h.tap("Yes, let's connect");
    const before = h.shell.calls.length;
    await h.tap("I see the code, scan it");
    expect(h.shell.calls.slice(before)).toEqual(["scan"]);
    // Behind the camera: the hint, and typing instead.
    expect(h.screen()).toEqual({ kind: "scan" });
    expect(h.view().actions.map((a) => a.label)).toContain("Type the code instead");
    scan.resolve({ text: LINK });
    await tick();
    expect(h.shell.opens).toEqual([{ origin: MAC.origin, credential: SECRET }]);
  });

  it("closing the camera leaves the hint, with Scan the code and Type the code instead", async () => {
    const h = harness();
    await h.launcher.boot();
    h.shell.queue.scan!.push(fail("cancelled"), fail("cancelled"));
    await h.tap("Yes, let's connect");
    await h.tap("I see the code, scan it");
    expect(h.screen()).toEqual({ kind: "scan" });
    await h.tap("Scan the code");
    expect(h.screen()).toEqual({ kind: "scan" });
    expect(h.shell.calls.filter((c) => c === "scan")).toHaveLength(2);
    await h.tap("Type the code instead");
    expect(h.screen()).toEqual({ kind: "type" });
    await h.tap("Back");
    expect(h.screen()).toEqual({ kind: "welcome" });
  });

  it("Type the code instead on Get your code ready goes straight to typing, without the camera", async () => {
    const h = harness();
    await h.launcher.boot();
    await h.tap("Yes, let's connect");
    await h.tap("Type the code instead");
    expect(h.screen()).toEqual({ kind: "type" });
    expect(h.shell.calls).not.toContain("scan");
    await h.tap("Back");
    expect(h.screen()).toEqual({ kind: "welcome" });
  });

  it("Not yet, then It's running now, comes back to the welcome, asking native nothing", async () => {
    const h = harness();
    await h.launcher.boot();
    const calls = h.shell.calls.length;
    await h.tap("Not yet");
    expect(h.screen()).toEqual({ kind: "notYet" });
    expect(h.view().title).toBe("Set up Murage on your computer first");
    await h.tap("It's running now");
    expect(h.screen()).toEqual({ kind: "welcome" });
    await h.tap("Not yet");
    await h.tap("It's running now");
    expect(h.screen()).toEqual({ kind: "welcome" });
    expect(h.shell.calls.length).toBe(calls);
  });

  it("says Connecting to your computer while the scanned computer is probed", async () => {
    const h = harness();
    await h.launcher.boot();
    const open = later<{ mode: "full"; hostCapability: number }>();
    h.shell.queue.open!.push(open);
    await h.tap("Yes, let's connect");
    await h.tap("I see the code, scan it");
    expect(h.view()).toMatchObject({ title: "Connecting to your computer…", busy: true });
    open.resolve({ mode: "full", hostCapability: 2 });
    await tick();
  });

  it("unreachable with Tailscale off: Turn on Tailscale, and Open Tailscale opens it", async () => {
    const h = await failedPairing(OFF, "android");
    expect(h.screen()).toEqual({ kind: "pairUnreachable", origin: MAC.origin });
    expect(h.view().title).toBe("Turn on Tailscale");
    expect(h.view().actions.map((a) => a.label)).toEqual(["Open Tailscale", "Scan again"]);
    await h.tap("Open Tailscale");
    expect(h.shell.calls.at(-1)).toBe("openTailscale");
  });

  it("on iPhone, Turn on Tailscale also offers I don't have Tailscale yet, which goes to the App Store", async () => {
    const h = await failedPairing(IOS_OFF);
    expect(h.view().title).toBe("Turn on Tailscale");
    await h.tap("I don't have Tailscale yet");
    expect(h.shell.calls.at(-1)).toBe("openTailscale");
    expect(h.screen()).toEqual({ kind: "pairUnreachable", origin: MAC.origin });
  });

  it("on Android without Tailscale: Get Tailscale, which goes to the store", async () => {
    const h = await failedPairing(MISSING, "android");
    expect(h.view().title).toBe("Get Tailscale");
    h.shell.queue.openTailscale!.push(fail("unavailable"));
    await h.tap("Get Tailscale");
    expect(h.shell.calls.at(-1)).toBe("openTailscale");
    expect(h.view().error).toBe("Murage couldn't open Google Play. Get Tailscale there, then try again.");
  });

  it("unreachable with Tailscale on: can't see your computer; Try again keeps the credential, Scan again scans", async () => {
    const h = await failedPairing(ON);
    expect(h.view().title).toBe("Your phone can't see your computer");
    h.shell.queue.open!.push(fail("unreachable"));
    await h.tap("Try again");
    expect(h.shell.opens).toEqual([
      { origin: MAC.origin, credential: SECRET },
      { origin: MAC.origin, credential: SECRET },
    ]);
    expect(h.view().title).toBe("Your phone can't see your computer");
    const scan = later<{ text: string }>();
    h.shell.queue.scan!.push(scan);
    await h.tap("Scan again");
    expect(h.shell.calls.at(-1)).toBe("scan");
    expect(h.screen()).toEqual({ kind: "scan" });
    scan.reject(fail("cancelled"));
    await tick();
  });

  it("a typed pairing that can't reach its computer gets the same diagnosis", async () => {
    const h = harness({ tailscale: OFF, platform: "android" });
    await h.launcher.boot();
    h.shell.queue.scan!.push(fail("cancelled"));
    await h.tap("Yes, let's connect");
    await h.tap("I see the code, scan it");
    await h.tap("Type the code instead");
    h.shell.queue.open!.push(fail("unreachable"));
    await h.tap("Connect", { address: "mac.tailnet123.ts.net", code: "123456" });
    expect(h.screen()).toEqual({ kind: "pairUnreachable", origin: MAC.origin });
    expect(h.view().title).toBe("Turn on Tailscale");
  });

  it("a saved computer that can't be reached keeps the can't-reach screen, and nothing is watched", async () => {
    fakeInterval();
    const h = harness({ workspaces: [MAC], tailscale: OFF });
    await h.launcher.boot();
    h.shell.queue.open!.push(fail("unreachable"));
    await h.tap(`Open ${MAC.name}`);
    expect(h.screen()).toEqual({ kind: "unreachable", origin: MAC.origin });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("every 2 s it reads Tailscale, and when it comes on, pairs again by itself with the held credential", async () => {
    fakeInterval();
    const h = await failedPairing(OFF, "android");
    expect(vi.getTimerCount()).toBe(1);
    const reads = () => h.shell.calls.filter((c) => c === "state").length;
    const before = reads();
    vi.advanceTimersByTime(2000);
    await tick();
    expect(reads()).toBe(before + 1);
    expect(h.shell.opens).toHaveLength(1); // still off: nothing retried
    h.shell.setState({ tailscale: ON });
    vi.advanceTimersByTime(2000);
    await tick();
    expect(h.shell.opens).toEqual([
      { origin: MAC.origin, credential: SECRET },
      { origin: MAC.origin, credential: SECRET },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the watch also runs on resume: Get Tailscale, installed and on, pairs by itself", async () => {
    fakeInterval();
    const h = await failedPairing(MISSING, "android");
    h.shell.setState({ tailscale: ON });
    await h.launcher.resume();
    await tick();
    expect(h.shell.opens).toHaveLength(2);
    expect(h.shell.opens[1]).toEqual({ origin: MAC.origin, credential: SECRET });
  });

  it("installed but still off on resume: the screen becomes Turn on Tailscale, in place, and keeps watching", async () => {
    fakeInterval();
    const h = await failedPairing(MISSING, "android");
    h.shell.setState({ tailscale: OFF });
    await h.launcher.resume();
    expect(h.view().title).toBe("Turn on Tailscale");
    expect(h.keeps.at(-1)).toBe(true);
    expect(h.shell.opens).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("the interval is cleared when the screen changes, and when the page goes", async () => {
    fakeInterval();
    const h = await failedPairing(OFF, "android");
    expect(vi.getTimerCount()).toBe(1);
    h.shell.close({ origin: MAC.origin, reason: "launcher" });
    await tick();
    expect(h.screen()).toEqual({ kind: "welcome" });
    expect(vi.getTimerCount()).toBe(0);
    const reads = h.shell.calls.filter((c) => c === "state").length;
    vi.advanceTimersByTime(10_000);
    await tick();
    expect(h.shell.calls.filter((c) => c === "state").length).toBe(reads);

    const g = await failedPairing(OFF, "android");
    expect(vi.getTimerCount()).toBe(1);
    await g.launcher.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the retry never runs twice: a resume and a tick together, and ticks while it is on its way", async () => {
    fakeInterval();
    const h = await failedPairing(OFF, "android");
    h.shell.setState({ tailscale: ON });
    const slow = later<ShellState>();
    h.shell.queue.state!.push(slow);
    const resuming = h.launcher.resume();
    vi.advanceTimersByTime(2000); // lands while the resume's read is on its way
    await h.launcher.resume();
    slow.resolve({ workspaces: [], active: null, closed: null, platform: "android", tailscale: ON });
    await resuming;
    await tick();
    expect(h.shell.opens).toHaveLength(2);
    // The retry is on its way (slow open): more ticks and resumes do nothing.
    const g = await failedPairing(OFF, "android");
    const open = later<{ mode: "full"; hostCapability: number }>();
    g.shell.queue.open!.push(open);
    g.shell.setState({ tailscale: ON });
    vi.advanceTimersByTime(2000);
    await tick();
    expect(g.shell.opens).toHaveLength(2);
    await g.launcher.resume();
    vi.advanceTimersByTime(6000);
    await tick();
    expect(g.shell.opens).toHaveLength(2);
    open.resolve({ mode: "full", hostCapability: 2 });
    await tick();
  });

  it("no retry by itself once Tailscale was already on (can't see your computer)", async () => {
    fakeInterval();
    const h = await failedPairing(ON);
    expect(vi.getTimerCount()).toBe(0);
    await h.launcher.resume();
    await tick();
    expect(h.shell.opens).toHaveLength(1);
  });

  it("no watch without a held credential: Tailscale's screen after the person left the flow", async () => {
    fakeInterval();
    const h = await failedPairing(OFF, "android");
    // A close hands a new screen over and forgets the credential.
    h.shell.close({ origin: MAC.origin, reason: "unreachable" });
    await tick();
    expect(vi.getTimerCount()).toBe(0);
    h.shell.setState({ tailscale: ON });
    await h.launcher.resume();
    await tick();
    expect(h.shell.opens).toHaveLength(1);
  });

  it("while the app is in the background the interval reads nothing (resume does, when it is back)", async () => {
    fakeInterval();
    let shown = false;
    const h = harness({ platform: "android", tailscale: OFF }, () => shown);
    await h.launcher.boot();
    h.shell.queue.open!.push(fail("unreachable"));
    await h.tap("Yes, let's connect");
    await h.tap("I see the code, scan it");
    const reads = h.shell.calls.filter((c) => c === "state").length;
    h.shell.setState({ tailscale: ON });
    vi.advanceTimersByTime(6000);
    await tick();
    expect(h.shell.calls.filter((c) => c === "state").length).toBe(reads);
    shown = true;
    vi.advanceTimersByTime(2000);
    await tick();
    expect(h.shell.opens).toHaveLength(2);
  });

  it("Scan again on Turn on Tailscale leaves the flow: the watch ends, and Tailscale coming on opens nothing", async () => {
    fakeInterval();
    const h = await failedPairing(IOS_OFF);
    expect(h.view().actions.at(-1)).toEqual({ id: "scan", label: "Scan again" });
    h.shell.queue.scan!.push(fail("cancelled"));
    await h.tap("Scan again");
    expect(h.screen()).toEqual({ kind: "scan" });
    expect(vi.getTimerCount()).toBe(0);
    h.shell.setState({ tailscale: { installed: null, connected: true } });
    vi.advanceTimersByTime(10_000);
    await h.launcher.resume();
    await tick();
    expect(h.shell.opens).toHaveLength(1);
  });

  it("Scan again on Get Tailscale scans (Android)", async () => {
    fakeInterval();
    const h = await failedPairing(MISSING, "android");
    h.shell.queue.scan!.push(later<{ text: string }>());
    await h.tap("Scan again");
    expect(h.shell.calls.at(-1)).toBe("scan");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries from what was drawn: an Open Tailscale error painted over a read that saw it on still retries (A2)", async () => {
    fakeInterval();
    const h = await failedPairing(OFF, "android");
    const slow = later<ShellState>();
    h.shell.queue.state!.push(slow);
    const resuming = h.launcher.resume();
    h.shell.queue.openTailscale!.push(fail("unavailable"));
    await h.tap("Open Tailscale"); // paints the error: the resume stands down
    slow.resolve({ workspaces: [], active: null, closed: null, platform: "android", tailscale: ON });
    await resuming;
    expect(h.view().title).toBe("Turn on Tailscale");
    h.shell.setState({ tailscale: ON });
    vi.advanceTimersByTime(2000);
    await tick();
    expect(h.shell.opens).toHaveLength(2);
    expect(h.views.map((v) => v.title)).not.toContain("Your phone can't see your computer");
  });

  it("a retry answered busy stays on Turn on Tailscale and keeps watching, never can't see (A2)", async () => {
    fakeInterval();
    const h = await failedPairing(OFF, "android");
    h.shell.setState({ tailscale: ON });
    h.shell.queue.open!.push(fail("busy"));
    vi.advanceTimersByTime(2000);
    await tick();
    expect(h.shell.opens).toHaveLength(2);
    expect(h.view().title).toBe("Turn on Tailscale");
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(2000);
    await tick();
    expect(h.shell.opens).toHaveLength(3);
  });

  it("a failed I don't have Tailscale yet names the App Store (A5)", async () => {
    const h = await failedPairing(IOS_OFF);
    h.shell.queue.openTailscale!.push(fail("unavailable"));
    await h.tap("I don't have Tailscale yet");
    expect(h.shell.calls.at(-1)).toBe("openTailscale");
    expect(h.view().error).toBe("Murage couldn't open the App Store. Get Tailscale there, then try again.");
  });

  it("the credential is in no screen and no view, through the whole flow", async () => {
    fakeInterval();
    const h = await failedPairing(IOS_OFF);
    await h.tap("Open Tailscale");
    h.shell.setState({ tailscale: { installed: null, connected: true } });
    h.shell.queue.open!.push(fail("unreachable"));
    vi.advanceTimersByTime(2000);
    await tick();
    expect(h.view().title).toBe("Your phone can't see your computer");
    await h.tap("Try again");
    expect(h.shell.opens.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify([h.views, h.screens, h.drafts, h.launcher.screen])).not.toContain(SECRET);
  });
});


describe("minimum host capability", () => {
  it.each([undefined, null, "1", 1.5, NaN, 0])("blocks host capability %s at the update screen", async (hostCapability) => {
    const h = harness({ workspaces: [MAC] });
    await h.launcher.boot();
    h.shell.queue.open!.push({ mode: "full", hostCapability });
    const before = h.shell.calls.length;
    await h.launcher.act({ id: "open", label: "Open", origin: MAC.origin });
    expect(h.screen()).toEqual({ kind: "updateRequired", origin: MAC.origin });
    expect(h.view()).toEqual({
      title: "Update Murage on your computer",
      lines: ["Update Murage on your computer to use the phone app. On your computer, open Murage and choose Murage > Check for updates."],
      actions: [{ id: "retry", label: "Try again", primary: true, origin: MAC.origin }],
      rows: [],
    });
    // Native has returned without loading; the launcher must stop its success flow here.
    expect(h.shell.calls.slice(before)).toEqual(["open"]);
    await h.launcher.resume();
    expect(h.shell.calls.slice(before)).toEqual(["open"]);
    await h.launcher.dispose();
  });

  it("Try again re-probes with the held credential and continues at capability 1", async () => {
    const h = harness();
    await h.launcher.boot();
    h.shell.queue.open!.push({ mode: "full", hostCapability: 0 });
    await h.launcher.act({ id: "scan", label: "Scan" });
    expect(h.screen()?.kind).toBe("updateRequired");
    expect(JSON.stringify(h.views)).not.toContain(SECRET);
    h.shell.queue.open!.push({ mode: "full", hostCapability: 1 });
    h.shell.setState({ workspaces: [MAC] });
    await h.tap("Try again");
    expect(h.shell.opens).toEqual([
      { origin: MAC.origin, credential: SECRET },
      { origin: MAC.origin, credential: SECRET },
    ]);
    expect(h.screen()).toEqual({ kind: "list", managing: false });
    await h.launcher.dispose();
  });

  it.each([1, 2])("continues directly for capability %s", async (hostCapability) => {
    const h = harness({ workspaces: [MAC] });
    await h.launcher.boot();
    h.shell.queue.open!.push({ mode: "full", hostCapability });
    await h.launcher.act({ id: "open", label: "Open", origin: MAC.origin });
    expect(h.screen()).toEqual({ kind: "list", managing: false });
    expect(h.screens.some((s) => s?.kind === "updateRequired")).toBe(false);
    expect(h.shell.opens).toHaveLength(1);
    await h.launcher.dispose();
  });

  it("shows the same update screen when a startup probe closes the workspace", async () => {
    const h = harness({ workspaces: [MAC], closed: { origin: MAC.origin, reason: "updateRequired" } });
    await h.launcher.boot();
    expect(h.screen()).toEqual({ kind: "updateRequired", origin: MAC.origin });
    await h.tap("Try again");
    expect(h.shell.opens).toEqual([{ origin: MAC.origin }]);
    expect(h.screen()?.kind).toBe("list");
    await h.launcher.dispose();
  });

  it("does not start a timer or re-probe on resume while the update screen shows", async () => {
    vi.useFakeTimers();
    const h = harness({ workspaces: [MAC] });
    try {
      await h.launcher.boot();
      h.shell.queue.open!.push({ mode: "full", hostCapability: 0 });
      await h.launcher.act({ id: "open", label: "Open", origin: MAC.origin });
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
      await h.launcher.resume();
      expect(h.shell.opens).toHaveLength(1);
      expect(h.screen()?.kind).toBe("updateRequired");
    } finally {
      await h.launcher.dispose();
      vi.useRealTimers();
    }
  });
});

describe("RES-010: saved workspace recovery", () => {
  it("retries the saved origin once per recovery event and keeps manual retry after another failure", async () => {
    const h = harness({ workspaces: [MAC], closed: { origin: MAC.origin, reason: "unreachable" } });
    await h.launcher.boot();
    h.shell.setState({ closed: null });
    h.shell.queue.open!.push(fail("unreachable"));
    await h.launcher.resume();
    expect(h.shell.opens).toEqual([{ origin: MAC.origin }]);
    expect(h.screen()?.kind).toBe("unreachable");
    await tick();
    expect(h.shell.opens).toHaveLength(1);
    await h.tap("Try again");
    expect(h.shell.opens).toHaveLength(2);
  });
  it("retries a saved workspace once when Murage was not answering (hosterror) and the phone is back", async () => {
    const h = harness({ workspaces: [MAC], closed: { origin: MAC.origin, reason: "hosterror" } });
    await h.launcher.boot();
    expect(h.screen()?.kind).toBe("hosterror");
    h.shell.setState({ closed: null });
    h.shell.queue.open!.push(fail("hosterror"));
    await h.launcher.resume();
    expect(h.shell.opens).toEqual([{ origin: MAC.origin }]);
    await tick();
    expect(h.shell.opens).toHaveLength(1);
  });
  it("coalesces recovery events during the state read and open, and cancels a read after navigation", async () => {
    const h = harness({ workspaces: [MAC], closed: { origin: MAC.origin, reason: "unreachable" } });
    await h.launcher.boot();
    h.shell.setState({ closed: null });
    const opened = later<{ mode: "full"; hostCapability: number }>();
    h.shell.queue.open!.push(opened);
    const first = h.launcher.resume();
    await tick();
    await h.launcher.resume();
    expect(h.shell.opens).toHaveLength(1);
    opened.reject(fail("unreachable"));
    await first;
    const read = later<ShellState>();
    h.shell.queue.state!.push(read);
    const stale = h.launcher.resume();
    await h.launcher.act({ id: "choose", label: "Your computers" });
    read.resolve({ workspaces: [MAC], active: null, closed: null, platform: "ios", tailscale: { installed: null, connected: null } });
    await stale;
    expect(h.shell.opens).toHaveLength(1);
    expect(h.screen()?.kind).toBe("list");
  });
  it("never retries while hidden, disposed, or on a certificate failure", async () => {
    let visible = false;
    const h = harness({ workspaces: [MAC], closed: { origin: MAC.origin, reason: "unreachable" } }, () => visible);
    await h.launcher.boot();
    h.shell.setState({ closed: null });
    await h.launcher.resume();
    expect(h.shell.opens).toHaveLength(0);
    visible = true;
    await h.launcher.dispose();
    await h.launcher.resume();
    expect(h.shell.opens).toHaveLength(0);
    const cert = harness({ workspaces: [MAC], closed: { origin: MAC.origin, reason: "insecure" } });
    await cert.launcher.boot();
    cert.shell.setState({ closed: null });
    await cert.launcher.resume();
    expect(cert.shell.opens).toHaveLength(0);
  });
});
