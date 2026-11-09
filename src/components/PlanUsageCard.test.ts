import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setLocale } from "@/lib/i18n";
import type { PlanUsageReport } from "@/lib/plan-usage-view";

// Exercise the real card and useAction with a deterministic hook host. The resulting
// element tree is rendered by React's server renderer; no browser runtime is required.
const host = vi.hoisted(() => ({ active: false, index: 0, slots: [] as any[], effects: [] as (() => void)[], cleanups: [] as (() => void)[] }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react,
    useState: (initial: any) => {
      if (!host.active) return react.useState(initial);
      const i = host.index++;
      if (!(i in host.slots)) host.slots[i] = typeof initial === "function" ? initial() : initial;
      return [host.slots[i], (value: any) => { host.slots[i] = typeof value === "function" ? value(host.slots[i]) : value; }];
    },
    useRef: (initial: any) => {
      if (!host.active) return react.useRef(initial);
      const i = host.index++;
      return host.slots[i] ??= { current: initial };
    },
    useEffect: (effect: () => (() => void) | void, deps: unknown[]) => {
      if (!host.active) return react.useEffect(effect, deps);
      const i = host.index++;
      const old = host.slots[i];
      if (!old || deps.some((d, j) => d !== old[j])) {
        host.slots[i] = deps;
        host.effects.push(() => { host.cleanups[i]?.(); const cleanup = effect(); if (cleanup) host.cleanups[i] = cleanup; });
      }
    },
  };
});
vi.mock("@/state/store", () => ({ api: vi.fn() }));
import { api } from "@/state/store";
import { PlanUsageCard } from "./PlanUsageCard";
import { ActionButton } from "./ActionButton";

const NOW = Date.UTC(2026, 10, 6);
const report = (refreshing = false, cursor = 0): PlanUsageReport => ({ serverNow: NOW, omitted: cursor ? 0 : 1, nextCursor: cursor ? null : 32, cloud: false,
  accounts: [{ id: `a${cursor}`, engine: "Codex", bot: `Account ${cursor + 1}`, status: "current", checkedAt: NOW, freshUntil: NOW + 600_000, refreshing,
    windows: [{ label: "plan", usedPercent: 72, resetsAt: null, windowSeconds: null, limitReached: false }] }],
});
let tree: ReactElement | null;
function render() {
  host.index = 0; host.active = true;
  try { tree = PlanUsageCard(); } finally { host.active = false; }
  for (const effect of host.effects.splice(0)) effect();
  return tree ? renderToStaticMarkup(tree) : "";
}
function elements(node: ReactNode): ReactElement<any>[] {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(elements);
  const el = node as ReactElement<any>;
  return [el, ...elements(el.props?.children)];
}
const action = () => elements(tree).find((el) => el.type === ActionButton)!.props.action;
async function settle(ms = 0) { await vi.advanceTimersByTimeAsync(ms); return render(); }
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  vi.stubGlobal("window", { setInterval, clearInterval });
  host.slots = []; host.effects = []; host.cleanups = []; vi.mocked(api).mockReset();
});
afterEach(async () => { for (const cleanup of host.cleanups) cleanup?.(); vi.unstubAllGlobals(); vi.useRealTimers(); await setLocale("en"); });

describe("PlanUsageCard review regressions", () => {
  it("expires a loaded reading without another response", async () => {
    vi.mocked(api).mockResolvedValue(report()); render();
    expect(await settle()).toContain("bg-accent");
    const html = await settle(600_000);
    expect(html).toContain("Last reported: 72% used");
    expect(html).not.toContain("bg-accent");
    expect(api).toHaveBeenCalledTimes(1);
  });
  it("does not show Checked feedback for an HTTP-successful failed engine read", async () => {
    vi.mocked(api).mockResolvedValueOnce(report()).mockResolvedValueOnce({ ...report(), accounts: [{ ...report().accounts[0], status: "stale", reason: "timeout" }] });
    render(); await settle(); await action().run();
    const html = render();
    expect(html).toContain("data-action-error"); expect(html).not.toContain("data-action-success");
  });
  it.each(["rejection", "deadline"])("stops Checking and renders stale values after polling %s", async (failure) => {
    vi.mocked(api).mockResolvedValue(report(true));
    if (failure === "rejection") vi.mocked(api).mockResolvedValueOnce(report(true)).mockRejectedValueOnce(new Error("offline"));
    render(); expect(await settle()).toContain("Checking usage.");
    const html = await settle(failure === "deadline" ? 300_000 : 1_000);
    expect(html).not.toContain("Checking usage."); expect(html).not.toContain("bg-accent");
    expect(html).toContain("Last reported: 72% used");
  });
  it("views and refreshes account 33 and keeps its cursor throughout polling", async () => {
    vi.mocked(api).mockResolvedValueOnce(report()).mockResolvedValueOnce(report(false, 32)).mockResolvedValueOnce(report(true, 32)).mockResolvedValueOnce(report(false, 32)).mockResolvedValueOnce(report());
    render(); await settle();
    elements(tree).find((el) => el.type === "button" && el.props.children === "Next page")!.props.onClick();
    render(); expect(await settle()).toContain("Account 33");
    const work = action().run(); await settle(1_000); await work;
    expect(vi.mocked(api).mock.calls.map(([path, init]) => [path, init?.method])).toEqual([
      ["/api/plan-usage", "GET"], ["/api/plan-usage?cursor=32", "GET"],
      ["/api/plan-usage/refresh?cursor=32", "POST"], ["/api/plan-usage?cursor=32", "GET"],
    ]);
    render(); elements(tree).find((el) => el.type === "button" && el.props.children === "Previous page")!.props.onClick();
    render(); expect(await settle()).toContain("Account 1");
  });
  it.each([undefined, 500])("recovers from an initial transient error (%s) without remounting", async (status) => {
    vi.mocked(api).mockRejectedValueOnce(Object.assign(new Error("network failed"), { status })).mockResolvedValueOnce(report());
    render(); const html = await settle();
    expect(html).toContain('role="alert"'); expect(html).toContain(">Refresh<");
    await action().run(); expect(render()).toContain("Account 1");
  });
  it.each([401, 403, 404, 410])("hides a deliberately unavailable surface (%s)", async (status) => {
    vi.mocked(api).mockRejectedValue(Object.assign(new Error("Unavailable"), { status }));
    render(); expect(await settle()).toBe("");
  });
  it("localizes pending, timeout, and retry feedback in German", async () => {
    await setLocale("de");
    vi.mocked(api).mockResolvedValueOnce(report()).mockResolvedValue(report(true));
    render(); await settle(); const work = action().run();
    const pending = await settle(2_500);
    expect(pending).toContain("data-action-slow"); expect(pending).not.toContain("Still working");
    const failed = await settle(300_000); await work;
    expect(failed).toContain("data-action-error"); expect(failed).not.toContain(">Retry<");
    expect(failed).not.toContain("timed out"); expect(failed).toContain("Erneut");
  });
});

it("renders a response that expires in flight as stale immediately", async () => {
  const delayed = report();
  delayed.accounts[0].freshUntil = NOW + 30_000;
  vi.mocked(api).mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(delayed), 60_000)));
  render();
  const html = await settle(60_000);
  expect(html).toContain("Last reported: 72% used");
  expect(html).not.toContain("bg-accent");
  expect(html).not.toContain("Checked 0 minutes ago");
});
