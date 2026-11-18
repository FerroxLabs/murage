import { expect, it } from "vitest";
import { autoVerdict } from "./auto-approve.ts";
import { d, fixture } from "./decision/fixture.ts";
import { guardEngineRelease } from "./decision/provider-release.ts";

// Actual registration, decision and delivery; transport is an inert local fake.
// No destination is created or edited by this test.
for (const path of ["/tmp/murage-mcp-Ab12Cd/mcp.json", "/work/shell-snapshots/fixture.sh", "/tmp/murage-render-" + "a".repeat(16) + "/mcp.json"])
  for (const level of ["unlimited", "full"] as const) it(`X3 registered Write ${level}: ${path}`, async () => {
    const f = fixture(level);
    try {
      const input = { file_path: path, content: "rm -rf /" };
      const handle = f.open("write", input, { tool: "Write", toolKind: "edit", toolCall: { name: "Write", input } });
      // BASE stays protected in both cases; registry authority selects No limits.
      const bot = { autoApprove: true, fullAccess: true, noLimits: false };
      const outcome = d.decide(handle, () => autoVerdict(bot, "Write", path, {
        fullAccessOrigin: "owner", ownerStarted: true, stopLine: null, outsideRead: null,
        call: { engine: "claude", toolCall: { name: "Write", input } },
      }));
      expect(outcome.kind).toBe(level === "unlimited" ? "run" : "card");
      if (level === "unlimited") {
        await d.deliverRequest(handle);
        expect(f.respond).toHaveBeenCalledOnce();
        expect(f.respond.mock.calls[0]?.[1]).toMatchObject({ behavior: "allow" });
      } else expect(f.respond).not.toHaveBeenCalled();
    } finally { f.dispose(); }
  });

it("X3 registered No limits still holds an executable wipe", () => {
  const f = fixture("unlimited");
  try {
    const outcome = d.decide(f.open("wipe", { command: "rm -rf /" }), () => ({ approve: "BASE", source: "auto-mode" }));
    expect(outcome.kind).toBe("card");
    expect(f.respond).not.toHaveBeenCalled();
  } finally { f.dispose(); }
});

it("X3 final No limits release rechecks a late executable wipe", () => {
  const f = fixture("unlimited");
  try {
    const handle = f.open("late-wipe", { command: "printf fixture" });
    expect(d.decide(handle, () => ({ approve: "BASE", source: "auto-mode" })).kind).toBe("run");
    const identity = { threadId: "t", requestId: "late-wipe", turnId: "turn", providerInstanceId: "p" };
    expect(guardEngineRelease(identity, { command: "printf changed" })).toBe(true);
    expect(guardEngineRelease(identity, { command: "rm -rf /" })).toBe(false);
    expect(f.respond).not.toHaveBeenCalled();
  } finally { f.dispose(); }
});
