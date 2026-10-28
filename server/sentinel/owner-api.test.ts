// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Sentinel owner reads (GAP-SENTINEL-109 sections 6.3, 7 and 8.1; SENTINEL-PRIVACY-AUTH, route side): who may read,
// the fixed filters and limits, the pagination cursor's revision, the stripped rows, locating the output root, and the
// Cloud public health body staying exactly as small as it was.
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HEALTH_LIMITS } from "../../shared/health-protocol.mjs";
import { sentinelInstallationId } from "../../shared/sentinel-installation.mjs";
import { publicHealthBody } from "../cloud-home/health.ts";
import { cloudRouteDecision, routeAdmits, routeClass, routePolicy } from "../route-policy.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { HEALTH_COPY, healthStateLine } from "../../shared/sentinel-view.ts";
import { HOST_STATUS_FILE, HOST_STATUS_MAX_BYTES, handleSentinelRead, locateSentinel, parseIssuesQuery, readHostStatus, sentinelOwner, type SentinelLocation } from "./owner-api.ts";
import { publishView, viewFromStore } from "./publication.ts";
import { DESCRIPTOR_FILE, defaultOutputRoot, ensureOutputRoot, sourcePaths, writeDescriptor } from "./paths.ts";
import { INST, T0, cleanupFixtures, issueRecord, makeInstall } from "./scan-fixtures.ts";
import { SentinelStore } from "./store.ts";

const temps: string[] = [];
afterEach(() => { cleanupFixtures(); for (const dir of temps.splice(0)) removeTempDirSync(dir); });
const posixOnly = process.platform === "win32" ? it.skip : it;

function seeded(count: number, overrides: Parameters<typeof issueRecord>[1] = {}) {
  const fx = makeInstall();
  const opened = SentinelStore.open(fx.descriptor.outputRoot, { installationId: INST });
  if (opened.status !== "ok") throw new Error(opened.status);
  const store = opened.store;
  for (let start = 0; start < count; start += 30) {
    store.commit({ issues: Array.from({ length: Math.min(30, count - start) }, (_, i) => issueRecord(start + i + 1, { severity: "high", evidence: [{ sourceRole: "server", epoch: 1, seq: 1, observedAt: T0 } as never], relatedFingerprints: ["e".repeat(64)], ...overrides })) });
  }
  const location: SentinelLocation = { installationId: INST, outputRoot: fx.descriptor.outputRoot };
  return { fx, store, location };
}

const owner = (location: SentinelLocation) => ({ owner: true, locate: () => ({ ok: true as const, value: location }) });
const read = (path: string, query: string, ctx: ReturnType<typeof owner> | { owner: boolean; locate: () => never }, method = "GET") => handleSentinelRead(method, path, new URLSearchParams(query), ctx as never);

describe("who may read Health", () => {
  const p256 = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ type: "spki", format: "pem" }).toString();
  const device = (scope: string, extra: Record<string, unknown> = {}) => ({ id: "d", account: "a", scope, publicKey: "x", assertionKey: "y", revoked: 0, factor: false, ...extra }) as never;

  it("the desktop renderer's proof is the owner; every other local caller is not", () => {
    expect(sentinelOwner({ cloudHome: false, surface: "desktop" })).toBe(true);
    expect(sentinelOwner({ cloudHome: false, surface: "remote" })).toBe(false);
    // A script grant, a bot's capability, a paired extension or the companion all reach the server as `remote`.
    expect(sentinelOwner({ cloudHome: false, surface: "desktop", grant: true })).toBe(false);
  });

  it("on a Cloud home only owner sessions read it", () => {
    expect(sentinelOwner({ cloudHome: true, surface: "desktop", cloudIdentity: device("owner-desktop") })).toBe(true);
    expect(sentinelOwner({ cloudHome: true, surface: "desktop", cloudIdentity: device("owner-phone") })).toBe(true);
    const passkey = device("browser", { factor: "passkey", publicKey: p256(), assertionKey: p256() });
    expect(sentinelOwner({ cloudHome: true, surface: "desktop", cloudIdentity: passkey })).toBe(true);
    const remembered = device("browser", { factor: "remembered-owner", publicKey: p256(), assertionKey: p256() });
    for (const identity of [undefined, remembered, device("browser"), device("service"), device("owner-desktop", { revoked: 1 })]) {
      expect(sentinelOwner({ cloudHome: true, surface: "desktop", cloudIdentity: identity })).toBe(false);
    }
  });

  it("both routes are the desktop owner class, never the public health class", () => {
    for (const path of ["/api/sentinel/summary", "/api/sentinel/issues"]) {
      expect(routeClass("GET", path)).toBe("desktop");
      expect(routePolicy("GET", path)?.class).not.toBe("health");
      expect(routeAdmits("desktop", { desktop: false, companion: true, door: true, bot: true })).toBe(false);
    }
    expect(routeClass("GET", "/api/sentinel/other")).toBe("desktop");
  });

  it("Cloud admits owner sessions and refuses every other scope and every write", () => {
    for (const path of ["/api/sentinel/summary", "/api/sentinel/issues"]) {
      for (const scope of ["owner-desktop", "owner-phone", "owner-browser"] as const) expect(cloudRouteDecision("GET", path, scope, {})).toBe("allow");
      for (const scope of ["remembered-owner", "browser", "service", "anonymous"] as const) expect(cloudRouteDecision("GET", path, scope, {})).toBe("deny");
      for (const method of ["POST", "PUT", "DELETE"]) expect(cloudRouteDecision(method, path, "owner-desktop", {}, true)).toBe("deny");
    }
  });

  it("a caller that is not the owner hears the unknown route, and nothing is located", () => {
    let located = false;
    const ctx = { owner: false, locate: () => { located = true; throw new Error("never"); } };
    expect(read("/api/sentinel/summary", "", ctx as never)).toEqual({ status: 404, body: { error: "no such route" } });
    expect(read("/api/sentinel/issues", "state=open", ctx as never)?.status).toBe(404);
    expect(located).toBe(false);
    expect(read("/api/other", "", ctx as never)).toBeNull();
  });
});

describe("the fixed issue filters", () => {
  it("defaults the limit to 25 and allows 1 to 50", () => {
    expect(parseIssuesQuery(new URLSearchParams("state=open"))).toEqual({ state: "open", after: null, limit: HEALTH_LIMITS.apiLimitDefault });
    expect(HEALTH_LIMITS.apiLimitDefault).toBe(25);
    expect(parseIssuesQuery(new URLSearchParams("state=resolved&limit=1"))?.limit).toBe(1);
    expect(parseIssuesQuery(new URLSearchParams("state=open&limit=50"))?.limit).toBe(50);
  });
  it("refuses anything else", () => {
    for (const q of ["", "state=all", "state=open&limit=0", "state=open&limit=51", "state=open&limit=2.5", "state=open&limit=-1", "state=open&state=resolved",
      "state=open&q=text", "state=open&fingerprint=x", "state=open&after=", `state=open&after=${"a".repeat(513)}`]) {
      expect(parseIssuesQuery(new URLSearchParams(q))).toBeNull();
    }
  });
  it("answers 400 for a bad filter and 404 for any method but GET", () => {
    const { location, store } = seeded(1);
    expect(read("/api/sentinel/issues", "state=open&limit=99", owner(location))?.status).toBe(400);
    expect(read("/api/sentinel/summary", "x=1", owner(location))?.status).toBe(400);
    expect(read("/api/sentinel/issues", "state=open", owner(location), "POST")?.status).toBe(404);
    store.close();
  });
});

describe("reading the committed issues", () => {
  it("pages with a cursor, and asks for a refresh when the store revision moved", () => {
    const { location, store } = seeded(30);
    const first = read("/api/sentinel/issues", "state=open&limit=10", owner(location));
    expect(first?.status).toBe(200);
    const body = first!.body as { ok: true; items: unknown[]; next: string };
    expect(body.items).toHaveLength(10);
    expect(body.next).toBeTruthy();
    const second = read("/api/sentinel/issues", `state=open&limit=10&after=${body.next}`, owner(location));
    expect((second!.body as { items: unknown[] }).items).toHaveLength(10);
    store.commit({ issues: [issueRecord(99)] });
    const moved = read("/api/sentinel/issues", `state=open&limit=10&after=${body.next}`, owner(location));
    expect(moved).toEqual({ status: 409, body: { ok: false, reason: "refresh" } });
    expect(read("/api/sentinel/issues", "state=open&after=!!", owner(location))?.status).toBe(400);
    store.close();
  });

  it("returns no raw evidence: evidence, source tokens and related fingerprints are removed", () => {
    const { location, store } = seeded(2);
    const page = read("/api/sentinel/issues", "state=open", owner(location))!.body as { items: Record<string, unknown>[] };
    expect(page.items).toHaveLength(2);
    for (const item of page.items) {
      expect(item).not.toHaveProperty("evidence");
      expect(item).not.toHaveProperty("sourceKey");
      expect(item).not.toHaveProperty("relatedFingerprints");
      expect(item).not.toHaveProperty("installationId");
      expect(item).toHaveProperty("nextAction");
    }
    store.close();
  });

  it("stays within 64 KiB at the 50-row limit", () => {
    const { location, store } = seeded(60, { titleKey: `k${"x".repeat(1500)}` });
    const answer = read("/api/sentinel/issues", "state=open&limit=50", owner(location));
    expect(Buffer.byteLength(JSON.stringify(answer!.body))).toBeLessThanOrEqual(HEALTH_LIMITS.apiResponseBytes);
    expect((answer!.body as { next: string | null }).next).toBeTruthy();
    store.close();
  });

  it("summary answers the last published view, waiting before the first, and never starts a scan", () => {
    const { location, store } = seeded(3);
    expect(read("/api/sentinel/summary", "", owner(location))!.body).toEqual({ status: "waiting", view: null });
    publishView(location.outputRoot, viewFromStore(store, T0, "running", "complete", T0, T0));
    const body = read("/api/sentinel/summary", "", owner(location))!.body as { status: string; view: { summary: { openCount: number } } };
    expect(body.status).toBe("ready");
    expect(body.view.summary.openCount).toBe(3);
    store.close();
  });

  it("a store of another installation is unavailable, never read", () => {
    const { fx, store } = seeded(2);
    const foreign = { installationId: "f".repeat(32), outputRoot: fx.descriptor.outputRoot };
    expect(read("/api/sentinel/issues", "state=open", owner(foreign))).toEqual({ status: 503, body: { ok: false, reason: "unavailable" } });
    store.close();
  });

  it("an unlocated root reads as waiting (not set up) or unavailable (refused)", () => {
    const ctx = (reason: string) => ({ owner: true, locate: () => ({ ok: false as const, reason }) });
    expect(read("/api/sentinel/summary", "", ctx("descriptor-missing") as never)!.body).toEqual({ status: "waiting", view: null });
    expect(read("/api/sentinel/summary", "", ctx("descriptor-link") as never)!.body).toEqual({ status: "unavailable", view: null });
    expect(read("/api/sentinel/issues", "state=open", ctx("foreign") as never)?.status).toBe(503);
  });
});

describe("locating the scanner output root", () => {
  function install() {
    const base = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-sentinel-locate-")));
    temps.push(base);
    const dataDir = join(base, "data");
    mkdirSync(join(dataDir, "health"), { recursive: true, mode: 0o700 });
    const env = { XDG_STATE_HOME: join(base, "xdg"), LOCALAPPDATA: join(base, "local") };
    const id = sentinelInstallationId(dataDir)!;
    const outputRoot = defaultOutputRoot(id, { env, home: base })!;
    mkdirSync(dirname(dirname(outputRoot)), { recursive: true, mode: 0o700 });
    expect(ensureOutputRoot(outputRoot).ok).toBe(true);
    mkdirSync(join(base, "bin"), { mode: 0o700 });
    const descriptor = { version: 1 as const, installationId: id, installationRoot: dataDir, inputRoot: join(dataDir, "health"), outputRoot,
      sources: sourcePaths(join(dataDir, "health")), executable: { path: process.execPath, entry: join(base, "bin", "cli.js"), sha256: null }, scheduleRevision: 1 };
    return { base, dataDir, env, id, outputRoot, descriptor };
  }

  posixOnly("finds this installation's root through its descriptor", () => {
    const fx = install();
    expect(locateSentinel(fx.dataDir, { env: fx.env, home: fx.base })).toEqual({ ok: false, reason: "descriptor-missing" });
    expect(writeDescriptor(fx.descriptor).ok).toBe(true);
    expect(locateSentinel(fx.dataDir, { env: fx.env, home: fx.base })).toEqual({ ok: true, value: { installationId: fx.id, outputRoot: fx.outputRoot } });
    expect(fx.id).toMatch(/^[0-9a-f]{32}$/);
  });

  posixOnly("a moved installation is a new namespace, and a missing data dir is refused", () => {
    const fx = install();
    expect(writeDescriptor(fx.descriptor).ok).toBe(true);
    const moved = join(fx.base, "moved");
    mkdirSync(moved, { mode: 0o700 });
    expect(sentinelInstallationId(moved)).not.toBe(fx.id);
    expect(locateSentinel(moved, { env: fx.env, home: fx.base }).ok).toBe(false);
    expect(locateSentinel(join(fx.base, "absent"), { env: fx.env, home: fx.base })).toEqual({ ok: false, reason: "data-dir" });
    expect(join(fx.outputRoot, DESCRIPTOR_FILE)).toContain(fx.id);
  });
});

describe("the Cloud public health body", () => {
  it("is unchanged: no issue count, backup time, extractor or diagnostic state", () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "");
    expect(publicHealthBody()).toEqual({ app: "murage", door: "v2", ownerFactor: 1 });
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    const home = publicHealthBody() as Record<string, unknown>;
    vi.unstubAllEnvs();
    expect(Object.keys(home).sort()).toEqual(["app", "door", "instance", "ownerFactor", "ui", "uiAt"]);
    expect(JSON.stringify(home)).not.toMatch(/sentinel|issue|backup|openCount|coverage/i);
  });
});

describe("the desktop host's status in the owner summary", () => {
  const hostStatus = (overrides: Record<string, unknown> = {}) => ({ version: 1, installationId: INST, at: T0 + 60_000, registration: "proven", mechanism: "systemd", heartbeat: "fresh", heartbeatAt: T0, rootState: "ready", ...overrides });
  const writeHost = (outputRoot: string, value: unknown) => writeFileSync(join(outputRoot, HOST_STATUS_FILE), typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
  const summaryOf = (location: SentinelLocation) => (read("/api/sentinel/summary", "", owner(location))!.body as { status: "ready"; view: { summary: Parameters<typeof healthStateLine>[1] & object } });
  const setup = () => {
    const { location, store } = seeded(0);
    publishView(location.outputRoot, viewFromStore(store, T0, "running", "complete", T0, T0));
    store.close();
    return location;
  };

  posixOnly("a fresh heartbeat or no host file keeps complete coverage and No issues found", () => {
    const location = setup();
    expect(summaryOf(location).view.summary!.coverage).toBe("complete");
    writeHost(location.outputRoot, hostStatus());
    const body = summaryOf(location);
    expect(body.view.summary!.coverage).toBe("complete");
    expect(healthStateLine("ready", body.view.summary, T0 + 120_000).sentence).toBe(HEALTH_COPY.noIssues);
  });

  posixOnly("a stale heartbeat reads as waiting coverage, never No issues found or a Checked time", () => {
    const location = setup();
    writeHost(location.outputRoot, hostStatus({ heartbeat: "stale" }));
    const body = summaryOf(location);
    expect(body.view.summary!.coverage).toBe("partial");
    const line = healthStateLine("ready", body.view.summary, T0 + 120_000);
    expect(line.sentence).toBe(HEALTH_COPY.waiting);
    expect(line.time).not.toMatch(/^Checked/);
  });

  posixOnly("a scan committed after the host's stale note is fresher than the note", () => {
    const location = setup();
    writeHost(location.outputRoot, hostStatus({ heartbeat: "stale", at: T0 - 1 }));
    expect(summaryOf(location).view.summary!.coverage).toBe("complete");
    writeHost(location.outputRoot, hostStatus({ heartbeat: "stale", at: T0 }));
    expect(summaryOf(location).view.summary!.coverage).toBe("partial");
  });

  posixOnly("registration-needed reads as waiting coverage until a fresh heartbeat shows the fallback scanner running", () => {
    const location = setup();
    writeHost(location.outputRoot, hostStatus({ registration: "registration-needed", mechanism: "supervisor", heartbeat: "waiting" }));
    expect(summaryOf(location).view.summary!.coverage).toBe("partial");
    writeHost(location.outputRoot, hostStatus({ registration: "registration-needed", mechanism: "supervisor", heartbeat: "fresh", heartbeatAt: T0 }));
    expect(summaryOf(location).view.summary!.coverage).toBe("complete");
  });

  posixOnly("an invalid, foreign, oversized or linked host file is ignored", () => {
    const location = setup();
    const bad = [
      hostStatus({ heartbeat: "stale", installationId: "f".repeat(32) }),
      hostStatus({ heartbeat: "stale", extra: "x" }),
      hostStatus({ heartbeat: "late" }),
      hostStatus({ heartbeat: "stale", mechanism: "cron" }),
      hostStatus({ heartbeat: "stale", version: 2 }),
      hostStatus({ heartbeat: "stale", at: -1 }),
      "{not json",
    ];
    for (const value of bad) {
      writeHost(location.outputRoot, value);
      expect(readHostStatus(location.outputRoot, INST)).toBeNull();
      expect(summaryOf(location).view.summary!.coverage).toBe("complete");
    }
    writeHost(location.outputRoot, JSON.stringify(hostStatus({ heartbeat: "stale" })).padEnd(HOST_STATUS_MAX_BYTES + 1, " "));
    expect(readHostStatus(location.outputRoot, INST)).toBeNull();
    writeHost(location.outputRoot, JSON.stringify(hostStatus({ heartbeat: "stale" })).padEnd(HOST_STATUS_MAX_BYTES, " "));
    expect(readHostStatus(location.outputRoot, INST)?.heartbeat).toBe("stale");
    const elsewhere = mkdtempSync(join(tmpdir(), "murage-host-status-"));
    temps.push(elsewhere);
    writeFileSync(join(elsewhere, "real.json"), JSON.stringify(hostStatus({ heartbeat: "stale" })), { mode: 0o600 });
    const target = join(location.outputRoot, HOST_STATUS_FILE);
    rmSync(target);
    symlinkSync(join(elsewhere, "real.json"), target);
    expect(readHostStatus(location.outputRoot, INST)).toBeNull();
  });
});
