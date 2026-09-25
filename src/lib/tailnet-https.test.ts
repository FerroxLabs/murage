// A tailnet without HTTPS certificates.
//
// `tailscale serve` cannot give Murage a secure address until the tailnet's
// owner flips one switch in the Tailscale admin console, and the phone app
// only opens HTTPS addresses. So this is the one setup failure the owner can
// always fix in a minute, and the screen has to say exactly where and how.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { CompanionRemoteAccess } from "@/components/PhoneSetupFlow";
// @ts-expect-error untyped main-process module
import { TAILSCALE_DNS_ADMIN_URL as MAIN_PROCESS_URL } from "../../electron/companion-remote-access.mjs";
import { TAILSCALE_DNS_ADMIN_URL, tailnetHttpsHelp } from "./tailnet-https";

const remote = (over: Partial<CompanionRemoteAccess> = {}): CompanionRemoteAccess => ({
  on: false, desired: true, url: null, available: true, reason: null, problem: null, ...over,
});

describe("when the steps are shown", () => {
  it("shows them for a tailnet without certificates, and for nothing else", () => {
    expect(tailnetHttpsHelp(remote({ reason: "no-certificates" }))).not.toBeNull();
    for (const reason of [null, "missing", "logged-out", "conflict", "unsupported", "failed"] as const) {
      expect(tailnetHttpsHelp(remote({ reason })), String(reason)).toBeNull();
    }
    expect(tailnetHttpsHelp(null)).toBeNull();
  });

  it("stops showing them the moment the secure address is up", () => {
    expect(tailnetHttpsHelp(remote({ on: true, reason: "no-certificates" }))).toBeNull();
  });
});

describe("what the steps say", () => {
  const help = tailnetHttpsHelp(remote({ reason: "no-certificates" }))!;

  it("links the exact page, the same one the main process names", () => {
    expect(help.url).toBe("https://login.tailscale.com/admin/dns");
    expect(TAILSCALE_DNS_ADMIN_URL).toBe(MAIN_PROCESS_URL);
  });

  it("walks through the switch in the console's own words, then back here", () => {
    expect(help.steps.join(" ")).toContain("MagicDNS");
    expect(help.steps.join(" ")).toContain("Enable HTTPS");
    expect(help.steps.at(-1)).toMatch(/Allow remote access/);
  });

  it("says why it matters for the phone, and what still works meanwhile", () => {
    expect(help.after).toMatch(/phone app/);
    expect(help.after).toMatch(/browser/);
  });
});

describe("where the steps are shown", () => {
  const source = (file: string) => readFileSync(fileURLToPath(new URL(`../components/${file}`, import.meta.url)), "utf8");

  it("in phone setup, before the code is asked for", () => {
    const flow = source("PhoneSetupFlow.tsx");
    const start = flow.indexOf('c.phase === "intro"');
    expect(flow.slice(start, flow.indexOf('c.phase === "sign-in"', start))).toContain("<TailnetHttpsHelpCard");
  });

  it("in the phone panel, in place of the bare error", () => {
    expect(source("CompanionSection.tsx")).toContain("<TailnetHttpsHelpCard");
  });
});
