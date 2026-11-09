// S5-DATADIR-PATHS r4.1 DR7 (D5e-gate, D5e confirm, D5f-back(4), D5k confirm): the owner confirm and the roots read.
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCloudIdentity } from "./cloud-request-identity.ts";
import { COMPANION_HEADER, desktopSurfaceSecret, SURFACE_HEADER, SURFACE_SECRET_HEADER } from "./sse-visibility.ts";
import { DataRoots } from "./data-roots.ts";
import { answerDataDirRoute, dataDirRequestAllowed, DATA_DIR_CONFIRM_ROUTE, DATA_DIR_ROOTS_ROUTE } from "./data-dir-routes.ts";
import { routePolicy } from "./route-policy.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

let base = "";
beforeEach(() => { base = realpathSync.native(mkdtempSync(join(tmpdir(), "s5-dr7-"))); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); removeTempDirSync(base); });

const desktop = () => ({ [SURFACE_HEADER]: "desktop", [SURFACE_SECRET_HEADER]: desktopSurfaceSecret() });
const cloud = (scope: string, extra: Record<string, unknown> = {}) => { const headers = {}; setCloudIdentity(headers, { id: "d1", account: "owner", scope, revoked: false, ...extra } as never); return headers; };
const confirm = (roots: DataRoots, name: unknown = "workspaces", allowed = true) =>
  answerDataDirRoute({ method: "POST", path: DATA_DIR_CONFIRM_ROUTE, allowed, contentType: "application/json", body: { name } }, () => roots);
const read = (roots: DataRoots, allowed = true) => answerDataDirRoute({ method: "GET", path: DATA_DIR_ROOTS_ROUTE, allowed }, () => roots);

function linkedChanged() {
  const data = join(base, "data"), A = join(base, "vol-a"), B = join(base, "vol-b");
  mkdirSync(data); mkdirSync(A); mkdirSync(B);
  symlinkSync(A, join(data, "workspaces"), "dir");
  const roots = new DataRoots(data, () => {}); roots.boot();
  expect(roots.rootFor("workspaces").state).toBe("ok"); // first sight records A
  rmSync(join(data, "workspaces")); symlinkSync(B, join(data, "workspaces"), "dir");
  return { data, A, B, roots };
}

describe("D5e-gate: only the owner's own computer reaches DR7", () => {
  it("the local desktop app with its secret is allowed; an unauthenticated local call, a wrong secret and a companion are not", () => {
    expect(dataDirRequestAllowed(desktop())).toBe(true);
    expect(dataDirRequestAllowed({})).toBe(false);
    expect(dataDirRequestAllowed({ [SURFACE_HEADER]: "desktop", [SURFACE_SECRET_HEADER]: "0".repeat(64) })).toBe(false);
    expect(dataDirRequestAllowed({ ...desktop(), [COMPANION_HEADER]: "1" })).toBe(false);
  });
  it("on a Cloud home every scope is refused: owner-desktop, owner-phone, a passkey browser and a door browser", () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
    for (const scope of ["owner-desktop", "owner-phone", "browser"]) expect(dataDirRequestAllowed(cloud(scope, { factor: "passkey" })), scope).toBe(false);
    expect(dataDirRequestAllowed(desktop())).toBe(false);
  });
  it("a denied caller gets 404 with no body on both routes, and nothing is recorded", () => {
    const f = linkedChanged();
    const before = readFileSync(join(f.data, ".murage-root.json"), "utf8");
    expect(read(f.roots, false)).toEqual({ status: 404 });
    expect(confirm(f.roots, "workspaces", false)).toEqual({ status: 404 });
    expect(readFileSync(join(f.data, ".murage-root.json"), "utf8")).toBe(before);
    expect(f.roots.status("workspaces")).toBe("changed");
  });
  it("both routes are desktop class in the route policy", () => {
    expect(routePolicy("GET", DATA_DIR_ROOTS_ROUTE)).toMatchObject({ class: "desktop" });
    expect(routePolicy("POST", DATA_DIR_CONFIRM_ROUTE)).toMatchObject({ class: "desktop" });
  });
});

describe("D5e: the confirm in state changed", () => {
  it("GET returns candidate only in changed; the confirm records the new link and the next turn runs (BUILD-FIX 1)", () => {
    const f = linkedChanged();
    expect(read(f.roots)).toEqual({ status: 200, body: [{ name: "workspaces", state: "changed", candidate: f.B }, { name: "providers", state: "absent" }] });
    expect(confirm(f.roots)).toEqual({ status: 200, body: { state: "ok" } });
    const record = JSON.parse(readFileSync(join(f.data, ".murage-root.json"), "utf8"));
    expect(record.linkedRoots.workspaces.target).toBe(f.B);
    expect(f.roots.rootFor("workspaces")).toMatchObject({ state: "ok", canonical: f.B });
    expect(read(f.roots).body).toEqual([{ name: "workspaces", state: "ok" }, { name: "providers", state: "absent" }]);
  });
  it("409 with nothing recorded in states ok, absent, unavailable and refused", () => {
    const data = join(base, "d2"); mkdirSync(data);
    const roots = new DataRoots(data, () => {}); roots.boot();
    expect(confirm(roots, "workspaces").status).toBe(409); // absent
    expect(confirm(roots, "providers").status).toBe(409);
    mkdirSync(join(data, "workspaces"));
    expect(roots.rootFor("workspaces", { create: true }).state).toBe("ok");
    expect(confirm(roots)).toMatchObject({ status: 409, body: { state: "ok" } });
    const gone = join(base, "d3"); mkdirSync(gone); symlinkSync(join(base, "not-mounted"), join(gone, "workspaces"), "dir");
    const r3 = new DataRoots(gone, () => {}); r3.boot();
    expect(confirm(r3)).toMatchObject({ status: 409, body: { state: "unavailable" } });
    const refused = join(base, "d4"); mkdirSync(refused); symlinkSync("/", join(refused, "workspaces"), "dir");
    const r4 = new DataRoots(refused, () => {}); r4.boot();
    expect(confirm(r4)).toMatchObject({ status: 409, body: { state: "refused" } });
    expect(lstatSync(join(refused, "workspaces")).isSymbolicLink()).toBe(true);
  });
  it("a bad body is 400 and a missing JSON content type is 415; nothing recorded", () => {
    const f = linkedChanged();
    expect(confirm(f.roots, "skills").status).toBe(400);
    expect(answerDataDirRoute({ method: "POST", path: DATA_DIR_CONFIRM_ROUTE, allowed: true, contentType: "application/json", body: { name: "workspaces", extra: 1 } }, () => f.roots).status).toBe(400);
    expect(answerDataDirRoute({ method: "POST", path: DATA_DIR_CONFIRM_ROUTE, allowed: true, contentType: "text/plain", body: { name: "workspaces" } }, () => f.roots).status).toBe(415);
    expect(f.roots.status("workspaces")).toBe("changed");
  });
});
