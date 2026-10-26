// SPDX-License-Identifier: AGPL-3.0-or-later
// Health means the Murage app answers (Astra SELFSERVICE1 #9): murage-control probes the app through the home's own front door and
// reports appResponding on the heartbeat; a live daemon with a hung or wrong app is not healthy.
import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { healthSchema } from "../../cloudflare/control-plane/src/ops-monitor";
import { classifyDataDirEntry } from "../data-dir-inventory.ts";
import { HEALTH_PROBE_DIR_NAME, prepareHealthProbeDir } from "./home-volume-spec.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const control = fileURLToPath(new URL("../../deploy/cloud-home/murage-control", import.meta.url));
/** The heartbeat body schema of the control plane at 56a15e901 (the staging deploy whose homes run the oldest daemons in the field),
 *  replicated exactly from cloudflare/control-plane/src/ops-monitor.ts and b3-control.ts at that commit (Astra AUTOCANARY-11 P1-3). */
const HOME_EVENT_TYPES_56a15e901 = ["abuse.mining_suspected"] as const;
const health56a15e901 = z.object({
  diskUsedPercent: z.number().int().min(0).max(100).optional(),
  lastBackupAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  appResponding: z.boolean().optional(),
  bootId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/).optional(),
  events: z.array(z.object({
    type: z.enum(HOME_EVENT_TYPES_56a15e901), at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }).strict()).max(5).optional(),
}).strict();
const heartbeat56a15e901 = z.object({ generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  health: health56a15e901.optional() }).strict();
const script = String.raw`
import http.server, importlib.machinery, importlib.util, json, sys, threading, time
loader = importlib.machinery.SourceFileLoader("murage_control", sys.argv[1])
spec = importlib.util.spec_from_loader("murage_control", loader)
control = importlib.util.module_from_spec(spec)
loader.exec_module(control)
mode = {"value": "ok"}
seen = []
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_a):
        pass
    def do_GET(self):
        seen.append({"path": self.path, "host": self.headers.get("Host")})
        if mode["value"] == "hang":
            time.sleep(3)
        status, body = {"ok": (200, b'{"app":"murage"}'), "error": (500, b'{"app":"murage"}'), "other": (200, b'{"app":"nginx"}'),
                        "hang": (200, b'{"app":"murage"}'), "html": (200, b"<html>"), "uiOk": (200, b'{"app":"murage","ui":"ok"}'),
                        "uiFailed": (200, b'{"app":"murage","ui":"failed"}'), "uiPending": (200, b'{"app":"murage","ui":"pending"}'),
                        "uiNumber": (200, b'{"app":"murage","ui":1}'), "uiForeign": (200, b'{"app":"nginx","ui":"ok"}'),
                        "uiError": (500, b'{"app":"murage","ui":"ok"}'),
                        "uiFull": (200, b'{"app":"murage","ui":"ok","uiAt":1760000000000,"instance":"AbCdEfGhIjKlMnOpQrSt_-"}'),
                        "uiPendingNull": (200, b'{"app":"murage","ui":"pending","uiAt":null,"instance":"AbCdEfGhIjKlMnOpQrSt_-"}'),
                        "uiMalformed": (200, b'{"app":"murage","ui":"ok","uiAt":"1760000000000","instance":"short"}'),
                        "uiFloat": (200, b'{"app":"murage","ui":"ok","uiAt":1.5,"instance":12345678901234567890}'),
                        "uiBool": (200, b'{"app":"murage","ui":"ok","uiAt":true,"instance":"has spaces in it, not base64url"}'),
                        "uiNegative": (200, b'{"app":"murage","ui":"ok","uiAt":-1,"instance":null}'),
                        "doorV2": (200, b'{"app":"murage","door":"v2","ui":"ok"}'), "doorV1": (200, b'{"app":"murage","door":"v1"}'),
                        "doorErr": (500, b'{"app":"murage","door":"v2"}'), "doorForeign": (200, b'{"app":"nginx","door":"v2"}')}[mode["value"]]
        try:
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(body)
        except Exception:
            pass
server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
control.APP_PROBE_URL = "http://127.0.0.1:%d/api/health" % server.server_address[1]
out = {}
for name in ("ok", "error", "other", "hang", "html"):
    mode["value"] = name
    out[name] = control.app_responding("https://home-1.murage.test", timeout=1)
out["reports"] = {}
plain = lambda r: {**r, "uiAt": "MISSING" if r["uiAt"] is control.MISSING else r["uiAt"]}
for name in ("ok", "uiOk", "uiFailed", "uiPending", "uiNumber", "uiForeign", "uiError", "uiFull", "uiPendingNull", "uiMalformed",
             "uiFloat", "uiBool", "uiNegative", "doorV2", "doorV1", "doorErr", "doorForeign"):
    mode["value"] = name
    out["reports"][name] = plain(control.app_report("https://home-1.murage.test", timeout=1))
server.shutdown()
out["closed"] = control.app_responding("https://home-1.murage.test", timeout=1)
out["seen"] = seen[0]
out["health"] = control.collect_health(data_mount="/nonexistent", backup_last="/nonexistent", events="/nonexistent", app=False)[0]
out["unprobed"] = control.collect_health(data_mount="/nonexistent", backup_last="/nonexistent", events="/nonexistent")[0]
import tempfile, os
with tempfile.NamedTemporaryFile("w", delete=False) as f:
    f.write("1b4e28ba-2fa1-41d2-883f-0016d3cca427\n")
out["boot"] = control.read_boot_id(f.name)
with open(f.name, "w") as g:
    g.write("not a boot id")
out["badBoot"] = control.read_boot_id(f.name)
os.unlink(f.name)
out["missingBoot"] = control.read_boot_id("/nonexistent/boot_id")
out["withBoot"] = control.collect_health(data_mount="/nonexistent", backup_last="/nonexistent", events="/nonexistent", app=True, boot_id=out["boot"])[0]
# checks.uiRenders rides with the other checks, from the app's own render answer; omitted when the app reported none.
mount = tempfile.mkdtemp()
renders = lambda app, ui: (control.collect_health(data_mount=mount, backup_last="/nonexistent", events="/nonexistent", app=app, ui_renders=ui)[0] or {}).get("checks")
out["renders"] = {"true": renders(True, True), "false": renders(True, False), "missing": renders(True, None), "appDown": renders(False, True)}
# checks.uiAt / checks.uiInstance ride with uiRenders from the same answer (Astra AUTOCANARY-5 P1); missing or malformed: omitted.
stamp = lambda ui, at, inst: (control.collect_health(data_mount=mount, backup_last="/nonexistent", events="/nonexistent", app=True, ui_renders=ui,
                                                    ui_at=at, ui_instance=inst)[0] or {}).get("checks")
out["stamps"] = {"present": stamp(True, 1760000000000, "AbCdEfGhIjKlMnOpQrSt_-"), "pending": stamp(False, None, "AbCdEfGhIjKlMnOpQrSt_-"),
                 "missing": stamp(True, control.MISSING, None), "noRender": stamp(None, 1760000000000, "AbCdEfGhIjKlMnOpQrSt_-")}
# A render time ahead of this home's own wall clock (Astra AUTOCANARY-6 P1): more than two minutes ahead is refused at the source.
wall = {"wallMs": 1760000000000, "bootMs": 5000.7, "monoMs": 4000.2, "bootId": "1b4e28ba-2fa1-41d2-883f-0016d3cca427", "ntpSynced": True}
rejected = tempfile.mkdtemp() + "/ui-render-rejected.json"
ahead = lambda at, clock=wall: control.collect_health(data_mount=mount, backup_last="/nonexistent", events="/nonexistent", app=True,
                                                     ui_renders=True, ui_at=at, ui_instance="AbCdEfGhIjKlMnOpQrSt_-", boot_id=wall["bootId"],
                                                     clock=clock, rejected_path=rejected)[0]
out["ahead"] = {"over": ahead(1760000120001), "edge": ahead(1760000120000), "now": ahead(1760000000000)}
# The refusal is durable at the source (Astra AUTOCANARY-7 P1): a render at T dated T+30m is refused; once the clock is corrected and
# reaches T+29m the same cached pair is still refused (persisted, independent of the clock), also by a fresh daemon (no in-memory state);
# a new render after the correction is judged on its own.
T = 1760000000000
at = lambda t: {**wall, "wallMs": t}
out["durable"] = {"recorded": None, "first": ahead(T + 1800000, at(T))["checks"], "later": ahead(T + 1800000, at(T + 29 * 60000))["checks"],
                  "past": ahead(T + 1800000, at(T + 31 * 60000))["checks"]}
out["durable"]["recorded"] = control.load_ui_rejection(rejected)
out["durable"]["fresh"] = ahead(T + 32 * 60000, at(T + 32 * 60000 + 5000))["checks"]
out["durable"]["noFile"] = control.load_ui_rejection(rejected + ".absent")
os.unlink(rejected)
os.rmdir(os.path.dirname(rejected))
os.rmdir(mount)
print(json.dumps(out))
`;

describe("app health probe", () => {
  it("true only when the app itself answers through Caddy with the public host; hung, failing, foreign or closed is false", () => {
    const out = JSON.parse(execFileSync("python3", ["-I", "-c", script, control], { encoding: "utf8", timeout: 60_000 }));
    expect(out).toMatchObject({ ok: true, error: false, other: false, hang: false, html: false, closed: false });
    expect(out.seen).toEqual({ path: "/api/health", host: "home-1.murage.test" });
    expect(out.health).toEqual({ appResponding: false });
    expect(out.unprobed).toBeNull();
    expect(healthSchema.parse(out.health)).toEqual({ appResponding: false }); // exactly what the Worker accepts on the heartbeat
  });
  it("uiRenders is the app's own render answer on /api/health: \"ok\" true, any other value false, absent omitted (Astra AUTOCANARY-4 P1)", () => {
    const out = JSON.parse(execFileSync("python3", ["-I", "-c", script, control], { encoding: "utf8", timeout: 60_000 }));
    const bare = { uiAt: "MISSING", instance: null, door: null, ownerFactor: false };
    expect(out.reports).toEqual({ ok: { ok: true, ui: null, ...bare }, uiOk: { ok: true, ui: true, ...bare }, uiFailed: { ok: true, ui: false, ...bare },
      uiPending: { ok: true, ui: false, ...bare }, uiNumber: { ok: true, ui: false, ...bare }, uiForeign: { ok: false, ui: null, ...bare },
      uiError: { ok: false, ui: null, ...bare },
      uiFull: { ok: true, ui: true, uiAt: 1760000000000, instance: "AbCdEfGhIjKlMnOpQrSt_-", door: null, ownerFactor: false },
      uiPendingNull: { ok: true, ui: false, uiAt: null, instance: "AbCdEfGhIjKlMnOpQrSt_-", door: null, ownerFactor: false },
      uiMalformed: { ok: true, ui: true, ...bare }, uiFloat: { ok: true, ui: true, ...bare }, uiBool: { ok: true, ui: true, ...bare },
      uiNegative: { ok: true, ui: true, ...bare },
      // Door v2: only a 200 murage body saying door "v2" reports it; every failure shape and any other value is None.
      doorV2: { ok: true, ui: true, ...bare, door: "v2" }, doorV1: { ok: true, ui: null, ...bare }, doorErr: { ok: false, ui: null, ...bare },
      doorForeign: { ok: false, ui: null, ...bare } });
    expect(out.renders.true).toMatchObject({ uiRenders: true });
    expect(out.renders.false).toMatchObject({ uiRenders: false });
    expect(out.renders.missing).not.toHaveProperty("uiRenders");
    expect(out.renders.appDown).not.toHaveProperty("uiRenders"); // only with an answering app
    for (const checks of [out.renders.true, out.renders.false, out.renders.missing]) {
      expect(healthSchema.parse({ appResponding: true, checks })).toEqual({ appResponding: true, checks }); // what the Worker accepts
    }
    // The heartbeat takes the render answer from the same probe as appResponding; an injected bare bool or None still works.
    const src = readFileSync(control, "utf8");
    expect(src).toContain('answer = context.get("appProbe", app_report)(binding.get("publicOrigin", ""))');
    expect(src).toContain("app, ui, ui_at, ui_instance = answer.get(\"ok\") is True, answer.get(\"ui\"), answer.get(\"uiAt\", MISSING), answer.get(\"instance\")");
    expect(src).toContain("collect_health(app=app, boot_id=boot_id, ui_renders=ui, ui_at=ui_at,");
  });
  it("uiAt and instance ride with uiRenders from the same answer; missing or malformed are omitted (Astra AUTOCANARY-5 P1)", () => {
    const out = JSON.parse(execFileSync("python3", ["-I", "-c", script, control], { encoding: "utf8", timeout: 60_000 }));
    expect(out.stamps.present).toMatchObject({ uiRenders: true, uiAt: 1760000000000, uiInstance: "AbCdEfGhIjKlMnOpQrSt_-" });
    expect(out.stamps.pending).toMatchObject({ uiRenders: false, uiAt: null, uiInstance: "AbCdEfGhIjKlMnOpQrSt_-" });
    expect(out.stamps.missing).toMatchObject({ uiRenders: true });
    expect(out.stamps.missing).not.toHaveProperty("uiAt");
    expect(out.stamps.missing).not.toHaveProperty("uiInstance");
    // Without a render answer neither rides alone.
    expect(out.stamps.noRender).not.toHaveProperty("uiRenders");
    expect(out.stamps.noRender).not.toHaveProperty("uiAt");
    expect(out.stamps.noRender).not.toHaveProperty("uiInstance");
    for (const checks of [out.stamps.present, out.stamps.pending, out.stamps.missing]) {
      expect(healthSchema.parse({ appResponding: true, checks })).toEqual({ appResponding: true, checks }); // what the Worker accepts
    }
    expect(healthSchema.safeParse({ appResponding: true, checks: { ...out.stamps.present, uiInstance: "short" } }).success).toBe(false);
    expect(healthSchema.safeParse({ appResponding: true, checks: { ...out.stamps.present, uiAt: 1.5 } }).success).toBe(false);
  });
  it("a render dated more than two minutes ahead of the home's wall clock is reported failed with a reason; the clock sample rides (Astra AUTOCANARY-6 P1)", () => {
    const out = JSON.parse(execFileSync("python3", ["-I", "-c", script, control], { encoding: "utf8", timeout: 60_000 }));
    expect(out.ahead.over.checks).toMatchObject({ uiRenders: false, uiReason: "clock_ahead", uiAt: 1760000120001, uiInstance: "AbCdEfGhIjKlMnOpQrSt_-" });
    for (const name of ["edge", "now"]) {
      expect(out.ahead[name].checks, name).toMatchObject({ uiRenders: true });
      expect(out.ahead[name].checks, name).not.toHaveProperty("uiReason");
    }
    // The home's own ordering: integer boot time and wall clock of the sample taken before the app was asked, with the boot id.
    expect(out.ahead.over).toMatchObject({ bootId: "1b4e28ba-2fa1-41d2-883f-0016d3cca427", clock: { bootMs: 5000, wallMs: 1760000000000 } });
    for (const health of Object.values(out.ahead)) {
      expect(healthSchema.parse(health)).toEqual(health); // what the Worker accepts, the reason included
    }
    expect(out.ahead.over.checks.uiAgeMs).toBe(-120001);
    expect(out.ahead.now.checks.uiAgeMs).toBe(0);
    const src = readFileSync(control, "utf8");
    expect(src).toContain("ui_instance=ui_instance, clock=after)");
    expect(src).not.toContain("boot_sequence");
  });
  it("a clock_ahead refusal is persisted in the runtime's state and repeated for that render until the app reports a new uiAt (Astra AUTOCANARY-7 P1)", () => {
    const out = JSON.parse(execFileSync("python3", ["-I", "-c", script, control], { encoding: "utf8", timeout: 60_000 }));
    const T = 1760000000000;
    for (const name of ["first", "later", "past"]) {
      expect(out.durable[name], name).toMatchObject({ uiRenders: false, uiReason: "clock_ahead", uiAt: T + 1_800_000 });
    }
    // The render's age is measured on the home's own clock sample: negative while it is dated ahead.
    expect(out.durable.first.uiAgeMs).toBe(-1_800_000);
    expect(out.durable.later.uiAgeMs).toBe(-60_000);
    expect(out.durable.recorded).toEqual({ instance: "AbCdEfGhIjKlMnOpQrSt_-", uiAt: T + 1_800_000 });
    expect(out.durable.fresh).toMatchObject({ uiRenders: true, uiAt: T + 32 * 60_000, uiAgeMs: 5_000 });
    expect(out.durable.fresh).not.toHaveProperty("uiReason");
    expect(out.durable.noFile).toBeNull();
    for (const checks of Object.values(out.durable).filter((v) => v && typeof v === "object" && "uiBundle" in (v as object))) {
      expect(healthSchema.safeParse({ appResponding: true, checks }).success).toBe(true);
    }
    const src = readFileSync(control, "utf8");
    expect(src).toContain('UI_REJECTED = CONTROL_STATE + "/ui-render-rejected.json"');
  });
  it("the heartbeat carries the kernel boot id, so the control plane can prove a reboot happened (Astra SELFSERVICE4 #1)", () => {
    const out = JSON.parse(execFileSync("python3", ["-I", "-c", script, control], { encoding: "utf8", timeout: 60_000 }));
    expect([out.boot, out.badBoot, out.missingBoot]).toEqual(["1b4e28ba-2fa1-41d2-883f-0016d3cca427", null, null]);
    expect(healthSchema.parse(out.withBoot)).toEqual({ appResponding: true, bootId: "1b4e28ba-2fa1-41d2-883f-0016d3cca427" });
    const control_src = readFileSync(control, "utf8");
    expect(control_src).toContain('boot_id = context.get("bootId", read_boot_id)()');
  });
  it("the heartbeat echoes the evidence epoch of the last ack and nothing orders reports on the home (Astra AUTOCANARY-10)", () => {
    const pollScript = String.raw`
import importlib.machinery, importlib.util, io, json, os, sys, tempfile, contextlib
loader = importlib.machinery.SourceFileLoader("murage_control", sys.argv[1])
spec = importlib.util.spec_from_loader("murage_control", loader)
control = importlib.util.module_from_spec(spec)
loader.exec_module(control)
A = "1b4e28ba-2fa1-41d2-883f-0016d3cca427"
public = tempfile.mkdtemp()
binding = {"homeId": "home-test", "generation": 3, "publicOrigin": "https://home.murage.test"}
clock = lambda: {"wallMs": 1760000000000, "bootMs": 5000, "monoMs": 4000, "bootId": A, "ntpSynced": True}
lease = {"wire": 1, "installationId": "installation-test", "holder": "home-test", "generation": 3, "expiresAt": 1760003600000,
         "renewAfterMs": 60000, "ttlMs": 3600000, "skewMs": 120000}
acks, bodies = [], []
def request(_binding, operation, body=None):
    if operation == "lease":
        return dict(lease)
    if operation == "heartbeat":
        bodies.append(json.loads(json.dumps(body)))
        return acks.pop(0)
    return {}  # desired: refused after the ack was handled
context = {"appProbe": lambda origin: {"ok": True, "ui": "ok", "uiAt": 1759999999000, "instance": "AbCdEfGhIjKlMnOpQrSt_-"},
           "bootId": lambda: A}
def poll(ack):
    acks.append(ack)
    try:
        control._poll_once(binding, context, request, clock, public, os.getuid(), lambda *a: None)
    except ValueError as error:
        return str(error)
    return "ok"
out = {"results": [poll({"wire": 1, "accepted": True, "generation": 3, "evidenceEpoch": 4}),
                   poll({"wire": 1, "accepted": True, "generation": 3, "evidenceEpoch": 5}),
                   poll({"wire": 1, "accepted": True}),
                   poll({"wire": 1, "accepted": True, "generation": 3, "evidenceEpoch": 6}),
                   poll({"wire": 1, "accepted": True, "generation": 2, "evidenceEpoch": 7}),
                   poll({"wire": 1, "accepted": True, "generation": 3, "evidenceEpoch": -1}),
                   poll({"wire": 1, "accepted": True, "generation": 3, "evidenceEpoch": 8, "extra": 1}),
                   poll({"wire": 1, "accepted": True, "generation": 3, "evidenceEpoch": 9}),
                   poll({"wire": 1, "accepted": True, "generation": 3, "evidenceEpoch": 9})]}
out["epochs"] = [b["health"].get("evidenceEpoch", "absent") for b in bodies]
out["last"] = bodies[-1]
out["constants"] = [hasattr(control, "boot_sequence"), hasattr(control, "BOOT_SEQ"), control.UI_REJECTED]
print(json.dumps(out))
`;
    const out = JSON.parse(execFileSync("python3", ["-I", "-c", pollScript, control], { encoding: "utf8", timeout: 60_000 }));
    // Every poll got as far as the desired request (refused here), except the acks that were refused themselves.
    expect(out.results).toEqual(["Invalid control response", "Invalid control response", "Invalid control response", "Invalid control response",
      "Heartbeat refused", "Heartbeat refused", "Invalid control response", "Invalid control response", "Invalid control response"]);
    // A fresh daemon holds no epoch and sends none (Astra AUTOCANARY-11 P1-3: the field is absent, the old shape); each heartbeat echoes
    // the previous ack's; an old ack shape, or a refused ack, leaves none.
    expect(out.epochs).toEqual(["absent", 4, 5, "absent", 6, "absent", "absent", "absent", 9]);
    expect(out.last.health).toMatchObject({ appResponding: true, bootId: "1b4e28ba-2fa1-41d2-883f-0016d3cca427", evidenceEpoch: 9,
      clock: { bootMs: 5000, wallMs: 1760000000000 } });
    expect(out.last.health).not.toHaveProperty("bootSeq");
    expect(healthSchema.parse(out.last.health)).toEqual(out.last.health); // what the Worker accepts
    // The retired field is tolerated (Astra AUTOCANARY-11 P1-3: an older daemon must keep its heartbeat), and makes the report epoch-less
    // (recordHealth); out of range it is refused as before.
    expect(healthSchema.safeParse({ ...out.last.health, bootSeq: 3 }).success).toBe(true);
    expect(healthSchema.safeParse({ ...out.last.health, bootSeq: 0 }).success).toBe(false);
    expect(healthSchema.safeParse({ ...out.last.health, evidenceEpoch: -1 }).success).toBe(false);
    expect(out.constants).toEqual([false, false, "/var/lib/murage-control/ui-render-rejected.json"]);
    // The unit keeps its state directory for the render refusal, writable under ProtectSystem=strict.
    const unit = readFileSync(fileURLToPath(new URL("../../deploy/cloud-home/murage-control.service", import.meta.url)), "utf8");
    expect(unit).toMatch(/^ProtectSystem=strict$/m);
    expect(unit).toMatch(/^StateDirectory=murage-control$/m);
    expect(unit).toMatch(/^User=root$/m);
  });
  it("ASTRA AUTOCANARY-11 P1-3 mixed-version rollout: the new daemon's first heartbeat has the oldest accepted shape and asks for an epoch by header; the full report rides only after an epoch ack", () => {
    const rolloutScript = String.raw`
import http.server, importlib.machinery, importlib.util, json, os, sys, tempfile, threading, urllib.error
loader = importlib.machinery.SourceFileLoader("murage_control", sys.argv[1])
spec = importlib.util.spec_from_loader("murage_control", loader)
control = importlib.util.module_from_spec(spec)
loader.exec_module(control)
A = "1b4e28ba-2fa1-41d2-883f-0016d3cca427"
public = tempfile.mkdtemp()
binding = {"homeId": "home-test", "generation": 3, "publicOrigin": "https://home.murage.test"}
clock = lambda: {"wallMs": 1760000000000, "bootMs": 5000, "monoMs": 4000, "bootId": A, "ntpSynced": True}
lease = {"wire": 1, "installationId": "installation-test", "holder": "home-test", "generation": 3, "expiresAt": 1760003600000,
         "renewAfterMs": 60000, "ttlMs": 3600000, "skewMs": 120000}
acks, bodies = [], []
def request(_binding, operation, body=None):
    if operation == "lease":
        return dict(lease)
    if operation == "heartbeat":
        bodies.append(json.loads(json.dumps(body)))
        ack = acks.pop(0)
        if isinstance(ack, Exception):
            raise ack
        return ack
    return {}
context = {"appProbe": lambda origin: {"ok": True, "ui": "ok", "uiAt": 1759999999000, "instance": "AbCdEfGhIjKlMnOpQrSt_-"},
           "bootId": lambda: A}
def poll(ack):
    acks.append(ack)
    try:
        control.poll_once(binding, context, request, clock, public, os.getuid(), lambda *a: None)
    except (ValueError, urllib.error.HTTPError) as error:
        return str(getattr(error, "code", "")) or str(error)
    return "ok"
class Headers(dict):
    def get(self, name, default=None):
        return dict.get(self, name.lower(), default)
def unavailable(after):
    return urllib.error.HTTPError("https://cp.test/v1/machines/home-test/heartbeat", 503, "unavailable",
                                  Headers({"retry-after": after} if after is not None else {}), None)
out = {"results": [poll({"wire": 1, "accepted": True}),                                   # an old control plane: old ack
                   poll({"wire": 1, "accepted": True, "generation": 3, "evidenceEpoch": 7}), # a new one acks an epoch
                   poll({"wire": 1, "accepted": True, "generation": 3, "evidenceEpoch": 8})]}
out["bodies"] = bodies[:]
# 5xx: resent soon (Retry-After, doubling, jitter, capped), never fenced; a success returns to the normal interval.
delays = []
fixed = lambda lo, hi: hi  # the most jitter
context["invalidated"] = False
for after in ("5", "5", None, "9999", "5", "5"):
    out["results"].append(poll(unavailable(after)))
    delays.append(control.next_poll_delay(context, fixed))
out["fencedBy503"] = context["invalidated"]
out["results"].append(poll({"wire": 1, "accepted": True, "generation": 3, "evidenceEpoch": 9}))
delays.append(control.next_poll_delay(context, fixed))
out["delays"] = delays
out["afterFailure"] = bodies[-1]
# The real request: the capability header rides on every heartbeat, and only there.
seen = []
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_a):
        pass
    def do_POST(self):
        seen.append({"path": self.path, "evidence": self.headers.get("X-Murage-Evidence")})
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        body = b'{"wire":1,"accepted":true}'
        self.send_response(200); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(body)))
        self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        self.do_POST()
server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
real = {"adminUrl": "http://127.0.0.1:%d" % server.server_address[1], "homeId": "home-test", "credential": "c"}
control.machine_request(real, "heartbeat", {"generation": 3})
control.machine_request(real, "lease", {"generation": 3, "holder": "home-test"})
control.machine_request(real, "desired")
out["headers"] = seen
print(json.dumps(out))
`;
    const out = JSON.parse(execFileSync("python3", ["-I", "-c", rolloutScript, control], { encoding: "utf8", timeout: 60_000 }));
    // Every ack was taken; the polls stopped at the stubbed desired request (or at the 503).
    expect(out.results.slice(0, 3)).toEqual(["Invalid control response", "Invalid control response", "Invalid control response"]);
    const [first, second, third] = out.bodies as { generation: number; health: Record<string, unknown> }[];
    // Holding no epoch: the oldest shape (no evidenceEpoch, no checks, no clock), which the 56a15e901 control plane accepted, and which the
    // old ack leaves as it is; after the epoch ack, the full report with the epoch.
    // (diskUsedPercent rides when the test machine has a /data mount; it is in every schema.)
    expect(Object.keys(first.health).filter((k) => k !== "diskUsedPercent").sort()).toEqual(["appResponding", "bootId"]);
    expect(first.health).toMatchObject({ appResponding: true, bootId: "1b4e28ba-2fa1-41d2-883f-0016d3cca427" });
    expect(second.health).toEqual(first.health);
    expect(third.health).toMatchObject({ appResponding: true, evidenceEpoch: 7, clock: { bootMs: 5000, wallMs: 1760000000000 } });
    for (const b of out.bodies as { health: Record<string, unknown> }[]) expect(b.health).not.toHaveProperty("bootSeq");
    // The control plane schemas on either side of the rollout: the OLD strict schema (56a15e901, replicated exactly below) and this one.
    expect(heartbeat56a15e901.safeParse(first).success).toBe(true);
    expect(heartbeat56a15e901.safeParse(third).success).toBe(false); // the full report is sent only to a control plane that acked an epoch
    for (const b of out.bodies) expect(healthSchema.safeParse(b.health).success).toBe(true);
    // A 503 never fences (poll_once re-raises it without the fence) and is resent soon: 5 s base (Retry-After, floor 5, at most 30),
    // doubling per consecutive 503, plus up to half the base of jitter (the most, here); past the 60 s interval, 60 s +/- 25% (the most
    // here: 75, Astra AUTOCANARY-12 P2-1); a success resets to the interval.
    expect(out.results.slice(3, 9)).toEqual(["503", "503", "503", "503", "503", "503"]);
    expect(out.fencedBy503).toBe(false);
    expect(out.delays).toEqual([7.5, 12.5, 22.5, 75, 75, 75, 60]);
    // The resend after a failure holds no epoch: the old shape again, which the control plane drops as 'no_epoch' (a bump).
    expect(out.afterFailure.health).not.toHaveProperty("evidenceEpoch");
    expect(out.headers).toEqual([{ path: "/v1/machines/home-test/heartbeat", evidence: "epoch" },
      { path: "/v1/machines/home-test/lease", evidence: null }, { path: "/v1/machines/home-test/desired", evidence: null }]);
  });
  it("ASTRA AUTOCANARY-12 P1 negotiation is per response: a 400 to the full report falls back to the 56a15e901 shape in the same poll (no fence), in both directions and alternating; a 400 to the oldest shape is a real rejection; one fallback per poll", () => {
    const negotiationScript = String.raw`
import importlib.machinery, importlib.util, json, os, sys, tempfile, urllib.error
loader = importlib.machinery.SourceFileLoader("murage_control", sys.argv[1])
spec = importlib.util.spec_from_loader("murage_control", loader)
control = importlib.util.module_from_spec(spec)
loader.exec_module(control)
A = "1b4e28ba-2fa1-41d2-883f-0016d3cca427"
public = tempfile.mkdtemp()
binding = {"homeId": "home-test", "generation": 3, "publicOrigin": "https://home.murage.test"}
clock = lambda: {"wallMs": 1760000000000, "bootMs": 5000, "monoMs": 4000, "bootId": A, "ntpSynced": True}
lease = {"wire": 1, "installationId": "installation-test", "holder": "home-test", "generation": 3, "expiresAt": 1760003600000,
         "renewAfterMs": 60000, "ttlMs": 3600000, "skewMs": 120000}
# The rest of the poll succeeds, so a poll's outcome is the heartbeat's alone; every fence is counted.
control.validate_desired = lambda value, _binding, _lease: {}
fences = []
real_fence = control.fence
def counted_fence(context, public):
    fences.append(1)
    return real_fence(context, public)
control.fence = counted_fence
class Headers(dict):
    def get(self, name, default=None):
        return dict.get(self, name.lower(), default)
# The two control planes. Old (56a15e901): its strict schema answers 400 invalid_request to any key it does not know, and acks
# {"wire","accepted"}. New: acks every heartbeat with the generation and its next evidence epoch. The TypeScript side checks every
# answer against the real schemas.
OLD_KEYS = {"appResponding", "bootId", "diskUsedPercent", "lastBackupAt", "events"}
log, target = [], {"cp": "new", "rejectAll": False, "epoch": 0}
def request(_binding, operation, body=None):
    if operation == "lease":
        return dict(lease)
    if operation == "heartbeat":
        body = json.loads(json.dumps(body))
        entry = {"cp": target["cp"], "rejectAll": target["rejectAll"], "body": body}
        log.append(entry)
        old_ok = set(body) <= {"generation", "health"} and set(body.get("health") or {}) <= OLD_KEYS
        if target["rejectAll"] or (target["cp"] == "old" and not old_ok):
            entry["answer"] = 400
            raise urllib.error.HTTPError("https://cp.test/v1/machines/home-test/heartbeat", 400, "invalid_request", Headers({}), None)
        entry["answer"] = 200
        if target["cp"] == "old":
            return {"wire": 1, "accepted": True}
        target["epoch"] += 1
        return {"wire": 1, "accepted": True, "generation": 3, "evidenceEpoch": target["epoch"]}
    return {}
context = {"appProbe": lambda origin: {"ok": True, "ui": "ok", "uiAt": 1759999999000, "instance": "AbCdEfGhIjKlMnOpQrSt_-"},
           "bootId": lambda: A}
def poll(cp, reject_all=False):
    target["cp"], target["rejectAll"] = cp, reject_all
    first, fenced = len(log), len(fences)
    try:
        control.poll_once(binding, context, request, clock, public, os.getuid(), lambda *a: None)
        result = "ok"
    except (ValueError, urllib.error.HTTPError) as error:
        result = str(getattr(error, "code", "")) or str(error)
    return {"cp": cp, "result": result, "requests": len(log) - first, "fenced": len(fences) - fenced,
            "shapes": ["full" if "evidenceEpoch" in (e["body"].get("health") or {}) else "oldest" for e in log[first:]]}
steps = [poll("new"),                       # no epoch yet: the oldest shape; the new control plane acks epoch 1
         poll("old"),                       # rollback: the full report is answered 400, the oldest shape at once, same poll
         poll("new"),                       # the old ack carried no epoch: the oldest shape; acked with one again
         poll("new"),                       # the full report again
         poll("old"), poll("new"), poll("new"), poll("old"), poll("new"), poll("new"), poll("old"),   # alternating versions
         poll("old", True),                 # holding no epoch: the oldest shape answered 400 is a real rejection
         poll("new"),
         poll("old", True)]                 # the full report and its fallback both answered 400: one fallback, then fenced
print(json.dumps({"steps": steps, "log": log}))
`;
    const out = JSON.parse(execFileSync("python3", ["-I", "-c", negotiationScript, control], { encoding: "utf8", timeout: 60_000 }));
    const steps = out.steps as { cp: string; result: string; requests: number; fenced: number; shapes: string[] }[];
    expect(steps.map((s) => [s.cp, s.result, s.shapes.join(">"), s.fenced])).toEqual([
      ["new", "ok", "oldest", 0],
      ["old", "ok", "full>oldest", 0],
      ["new", "ok", "oldest", 0],
      ["new", "ok", "full", 0],
      ["old", "ok", "full>oldest", 0], ["new", "ok", "oldest", 0], ["new", "ok", "full", 0], ["old", "ok", "full>oldest", 0],
      ["new", "ok", "oldest", 0], ["new", "ok", "full", 0], ["old", "ok", "full>oldest", 0],
      ["old", "400", "oldest", 1],
      ["new", "ok", "oldest", 0],
      ["old", "400", "full>oldest", 1],
    ]);
    for (const s of steps) expect(s.requests).toBeLessThanOrEqual(2); // bounded: at most one fallback within a poll
    // Every answer of the stand-in control planes is what the real schemas say: the old one (56a15e901, replicated exactly above)
    // accepts exactly the bodies it answered 200 and refuses the ones it answered 400; the new one accepts every body sent.
    const log = out.log as { cp: string; rejectAll: boolean; answer: number; body: { generation: number; health?: Record<string, unknown> } }[];
    for (const e of log) {
      if (e.cp === "old" && !e.rejectAll) expect(heartbeat56a15e901.safeParse(e.body).success).toBe(e.answer === 200);
      if (e.cp === "new") expect(healthSchema.safeParse(e.body.health).success).toBe(true);
    }
    // The fallback is the full report without the epoch-only fields: the same evidence in the oldest shape.
    for (let i = 1; i < log.length; i++) {
      if (log[i - 1].answer !== 400 || !log[i - 1].body.health?.evidenceEpoch) continue;
      const oldest = Object.fromEntries(Object.entries(log[i - 1].body.health!).filter(([k]) => !["evidenceEpoch", "checks", "clock"].includes(k)));
      expect(log[i].body).toEqual({ generation: 3, health: oldest });
      expect(heartbeat56a15e901.safeParse(log[i].body).success).toBe(true);
    }
  });
  it("ASTRA AUTOCANARY-12 P2-1 a slow 503 is retried from its answer, honouring Retry-After, and a fleet's retries stay spread at the cap", () => {
    const scheduleScript = String.raw`
import importlib.machinery, importlib.util, json, os, random, statistics, sys, tempfile, urllib.error
loader = importlib.machinery.SourceFileLoader("murage_control", sys.argv[1])
spec = importlib.util.spec_from_loader("murage_control", loader)
control = importlib.util.module_from_spec(spec)
loader.exec_module(control)
sys.stderr = open(os.devnull, "w")
class Headers(dict):
    def get(self, name, default=None):
        return dict.get(self, name.lower(), default)
def unavailable(after):
    return urllib.error.HTTPError("https://cp.test/v1/machines/home-test/heartbeat", 503, "unavailable", Headers({"retry-after": after}), None)
out = {}
# The daemon's own loop (run): every poll takes 20 s and its heartbeat is answered 503 with Retry-After: 5.
t, starts = [0.0], []
control.secure_parents = lambda *a: None
control.atomic_public = lambda *a: None
control.refresh_probe_namespace = lambda *_: False
control.read_boot_id = lambda: "1b4e28ba-2fa1-41d2-883f-0016d3cca427"
control.sample_clock = lambda *a, **k: None
def slow_poll(_binding, context, *_a):
    starts.append(t[0])
    t[0] += 20
    error = unavailable("5")
    context["heartbeatRetryS"] = control.retry_after(error)  # as _poll_once does
    raise error
control.poll_once = slow_poll
class Stop(Exception):
    pass
def sleep(seconds):
    t[0] += seconds
    if t[0] > 400:
        raise Stop()
try:
    control.run(load=lambda: {"homeId": "home-test"}, sleep=sleep, monotonic=lambda: t[0], public=tempfile.mkdtemp(), expected_uid=os.getuid())
except Stop:
    pass
out["afterAnswer"] = [starts[i + 1] - (starts[i] + 20) for i in range(len(starts) - 1)]
# schedule_next_poll: a success keeps the cadence from the poll's start; a 503 is timed from the answer.
ctx = {}
out["success"] = control.schedule_next_poll(ctx, 100, 120)
ctx["heartbeatRetryS"] = 5
out["slow503"] = control.schedule_next_poll(ctx, 100, 120, lambda lo, hi: lo)
# A fleet that failed together: 500 homes, all answered 503 (Retry-After: 5) at the same moment, eight times running.
rounds = [[] for _ in range(8)]
for home in range(500):
    rng, ctx = random.Random(home), {}
    for k in range(8):
        ctx["heartbeatRetryS"] = 5
        rounds[k].append(control.schedule_next_poll(ctx, 0, 20, rng.uniform) - 20)
out["fleet"] = [{"min": min(r), "max": max(r), "stdev": statistics.pstdev(r), "distinct": len({int(d) for d in r})} for r in rounds]
print(json.dumps(out))
`;
    const out = JSON.parse(execFileSync("python3", ["-I", "-c", scheduleScript, control], { encoding: "utf8", timeout: 60_000 }));
    // Every retry in the real loop starts at least Retry-After (5 s) after the slow 503 arrived, and the delays grow (doubling).
    expect(out.afterAnswer.length).toBeGreaterThanOrEqual(4);
    for (const d of out.afterAnswer as number[]) expect(d).toBeGreaterThanOrEqual(5);
    expect(out.afterAnswer[2]).toBeGreaterThan(out.afterAnswer[0]);
    expect(out.success).toBe(160);
    expect(out.slow503).toBe(125);
    const fleet = out.fleet as { min: number; max: number; stdev: number; distinct: number }[];
    for (const r of fleet) expect(r.min).toBeGreaterThanOrEqual(5); // Retry-After honoured by every home
    // Uncapped rounds keep the base's jitter; capped rounds (5 s doubled past 60 s from the fifth) are spread over 60 s +/- 25%.
    expect(fleet[0].max - fleet[0].min).toBeGreaterThan(2);
    for (const r of fleet.slice(4)) {
      expect(r.min).toBeGreaterThanOrEqual(45);
      expect(r.max).toBeLessThanOrEqual(75);
      expect(r.max - r.min).toBeGreaterThan(25);
      expect(r.stdev).toBeGreaterThan(7);
      expect(r.distinct).toBeGreaterThanOrEqual(25);
    }
  });
});

// The data volume in these runs is /dev/shm: a real mount point (tmpfs, root 1777: sticky, like /data's root:murage 1771) on a different
// device from the temp directory, which stands in for the root file system a missing volume would leave /data on. The probe directory is a
// top-level entry of the volume, as /data/.murage-health is. The code requires the probe directory to be root owned, so as root the run
// uses real chown. As a non-root user (the CI and qualification containers) chown to another owner is impossible, so the script gives the
// code's os.lstat an ownership view instead: entries the test user owns read as root's, and the cases that chown read the owner recorded
// by own(). The decision logic under test (modes, devices, ancestors, EROFS) is the code's own either way; only who owns a path is
// simulated, and the result carries "ownership" so the run says which. A host with no writable /dev/shm mount cannot run these cases and
// the test fails rather than skipping.
const checksScript = String.raw`
import errno, importlib.machinery, importlib.util, json, os, shutil, sys, tempfile
loader = importlib.machinery.SourceFileLoader("murage_control", sys.argv[1])
spec = importlib.util.spec_from_loader("murage_control", loader)
control = importlib.util.module_from_spec(spec)
loader.exec_module(control)
real_root = os.geteuid() == 0
owners = {}
def own(path, uid):
    if real_root:
        os.chown(path, uid, uid)
    else:
        owners[os.path.abspath(path)] = uid
if not real_root:
    import types
    me = os.geteuid()
    shim = types.ModuleType("os")
    shim.__dict__.update(os.__dict__)
    def lstat(path, *args, **kwargs):
        info = os.lstat(path, *args, **kwargs)
        uid = owners.get(os.path.abspath(os.fspath(path)), 0 if info.st_uid == me else info.st_uid)
        fields = list(info)
        fields[4] = uid
        return os.stat_result(fields)
    shim.lstat = lstat
    control.os = shim
root = tempfile.mkdtemp()
os.chmod(root, 0o755)
dist = os.path.join(root, "dist"); os.mkdir(dist)
index = os.path.join(dist, "index.html")
with open(index, "w") as f:
    f.write("<!doctype html>")
# The build manifest (vite build.manifest: dist/.vite/manifest.json) and every file it names.
os.makedirs(os.path.join(dist, ".vite")); os.makedirs(os.path.join(dist, "assets"))
manifest_path = os.path.join(dist, ".vite", "manifest.json")
manifest = {"index.html": {"file": "assets/index-B9x_Qe-2.js", "isEntry": True, "src": "index.html", "imports": ["_vendor-Ab12.js"],
                           "dynamicImports": ["src/Settings.tsx"], "css": ["assets/index-Cc3.css"], "assets": ["assets/logo-Dd4.svg"]},
            "_vendor-Ab12.js": {"file": "assets/vendor-Ab12.js"},
            "src/Settings.tsx": {"file": "assets/Settings-Ee5.js", "isDynamicEntry": True, "css": ["assets/Settings-Ff6.css"]}}
def write_manifest(value):
    with open(manifest_path, "w") as f:
        f.write(value if isinstance(value, str) else json.dumps(value))
write_manifest(manifest)
for name in ("assets/index-B9x_Qe-2.js", "assets/index-Cc3.css", "assets/logo-Dd4.svg", "assets/vendor-Ab12.js", "assets/Settings-Ee5.js", "assets/Settings-Ff6.css"):
    with open(os.path.join(dist, name), "w") as f:
        f.write("x")
control.UI_DIST = dist
out = {"root": real_root, "ownership": "real" if real_root else "simulated"}
# Manifest completeness (Astra AUTOCANARY-4 P1): every file the manifest names must be a non-empty regular file.
out["bundleComplete"] = control.ui_bundle_complete()
chunk = os.path.join(dist, "assets", "Settings-Ee5.js")
os.unlink(chunk)
out["bundleMissingChunk"] = control.ui_bundle_complete()
open(chunk, "w").close()
out["bundleEmptyChunk"] = control.ui_bundle_complete()
with open(chunk, "w") as f:
    f.write("x")
css = os.path.join(dist, "assets", "index-Cc3.css")
os.unlink(css); os.symlink(chunk, css)
out["bundleSymlinkedCss"] = control.ui_bundle_complete()
os.unlink(css)
with open(css, "w") as f:
    f.write("x")
out["bundleRestored"] = control.ui_bundle_complete()
bad = {"missing": None, "notJson": "{", "empty": {}, "noIndexEntry": {"_vendor-Ab12.js": {"file": "assets/vendor-Ab12.js"}},
       "traversal": dict(manifest, **{"x": {"file": "../../etc/passwd"}}), "absolute": dict(manifest, **{"x": {"file": "/etc/passwd"}}),
       "noFile": dict(manifest, **{"x": {"css": []}}), "cssNotList": dict(manifest, **{"x": {"file": "assets/vendor-Ab12.js", "css": "a.css"}})}
out["bundleBad"] = {}
for name, value in bad.items():
    if value is None:
        os.unlink(manifest_path)
    else:
        write_manifest(value)
    out["bundleBad"][name] = control.ui_bundle_complete()
write_manifest(manifest)
os.unlink(manifest_path); os.symlink(os.path.join(dist, "index.html"), manifest_path)
out["bundleBad"]["manifestSymlink"] = control.ui_bundle_complete()
os.unlink(manifest_path)
write_manifest(manifest)
out["bundleAgain"] = control.ui_bundle_complete()
mount = "/dev/shm"
out["mount"] = os.path.ismount(mount) and os.access(mount, os.W_OK) and os.stat(mount).st_dev != os.stat(root).st_dev
# diskUsedPercent (the file system under test) is not under test here.
strip = lambda h: {k: v for k, v in (h or {}).items() if k != "diskUsedPercent"}
health = lambda m: strip(control.collect_health(data_mount=m, backup_last="/nonexistent", events="/nonexistent", app=True)[0])
out["noMount"] = health(os.path.join(root, "absent"))
# A missing volume: /data is a plain directory of the root file system, the probe directory on it perfectly writable. Refused.
plain = os.path.join(root, "data")
os.makedirs(plain, mode=0o755)
control.DATA_PROBE_DIR = os.path.join(plain, ".murage-health")
os.mkdir(control.DATA_PROBE_DIR, 0o700)
out["notMounted"] = health(plain)
if out["mount"]:
    probe = tempfile.mkdtemp(prefix=".murage-health-test-", dir=mount)  # a top-level entry of the volume, root 0700
    os.chmod(probe, 0o700)
    control.DATA_PROBE_DIR = probe
    out["ok"] = health(mount)
    out["leftBehind"] = os.listdir(probe)
    out["unprobed"] = strip(control.collect_health(data_mount=mount, backup_last="/nonexistent", events="/nonexistent")[0])
    os.unlink(index)
    out["noIndex"] = health(mount)
    os.mkdir(index)
    out["indexIsDir"] = health(mount)
    os.rmdir(index)
    open(index, "w").close()
    out["emptyIndex"] = health(mount)
    with open(index, "w") as f:
        f.write("<!doctype html>")
    # The probe directory on another device than the mount (the root file system): refused.
    control.DATA_PROBE_DIR = os.path.join(plain, ".murage-health")
    out["crossDevice"] = health(mount)
    control.DATA_PROBE_DIR = probe
    os.chmod(probe, 0o770)
    out["groupWritable"] = health(mount)
    os.chmod(probe, 0o755)
    out["notExactly0700"] = health(mount)
    os.chmod(probe, 0o700)
    own(probe, 4242)
    out["notRootOwned"] = health(mount)
    own(probe, 0)
    # Not a top-level entry: below a directory the murage user owns (the old server-home/.health layout), even root 0700 itself.
    nest = tempfile.mkdtemp(dir=mount)
    os.chmod(nest, 0o700)
    nested = os.path.join(nest, ".murage-health"); os.mkdir(nested, 0o700)
    own(nest, 4242)
    control.DATA_PROBE_DIR = nested
    out["underMurageOwned"] = health(mount)
    out["ancestorsMurageOwned"] = control.root_controlled_ancestors(nested)
    own(nest, 0)
    out["ancestorsRootOwned"] = control.root_controlled_ancestors(nested)
    out["nestedRootOwned"] = health(mount)  # still refused: its parent is not the mount point
    os.chmod(nest, 0o777)
    out["ancestorsWorldWritableNoSticky"] = control.root_controlled_ancestors(nested)
    os.chmod(nest, 0o1777)
    out["ancestorsSticky"] = control.root_controlled_ancestors(nested)
    shutil.rmtree(nest)
    link = os.path.join(mount, ".murage-health-test-link-%d" % os.getpid())
    os.symlink(probe, link)
    control.DATA_PROBE_DIR = link
    out["symlink"] = health(mount)
    os.unlink(link)
    control.DATA_PROBE_DIR = probe
    os.rmdir(probe)
    out["noProbe"] = health(mount)
    open(probe, "w").close()
    out["probeIsFile"] = health(mount)
    os.unlink(probe)
    # First-boot fallback: the directory exists on the volume but this namespace has the volume read-only (EROFS). Simulated by making
    # the temp-file creation fail with EROFS (a read-only remount needs privileges the test container lacks).
    os.mkdir(probe, 0o700)
    control.DATA_PROBE_DIR = probe
    mark = os.path.join(root, "probe-namespace-refreshed")
    boot = "1b4e28ba-2fa1-41d2-883f-0016d3cca427"
    out["staleWritable"] = control.probe_namespace_stale(mount)
    out["refreshWritable"] = control.refresh_probe_namespace(boot, mark, mount)
    real_mkstemp = control.tempfile.mkstemp
    def readonly(*_a, **_k):
        raise OSError(errno.EROFS, "Read-only file system")
    control.tempfile.mkstemp = readonly
    out["staleReadOnly"] = control.probe_namespace_stale(mount)
    out["refreshFirst"] = control.refresh_probe_namespace(boot, mark, mount)
    out["mark"] = open(mark).read()
    out["refreshSecond"] = control.refresh_probe_namespace(boot, mark, mount)
    out["refreshNextBoot"] = control.refresh_probe_namespace("2b4e28ba-2fa1-41d2-883f-0016d3cca427", mark, mount)
    out["refreshNoBootId"] = control.refresh_probe_namespace(None, os.path.join(root, "other-mark"), mount)
    def denied(*_a, **_k):
        raise OSError(errno.EACCES, "Permission denied")
    control.tempfile.mkstemp = denied
    out["staleDenied"] = control.probe_namespace_stale(mount)
    control.tempfile.mkstemp = real_mkstemp
    os.rmdir(probe)
    out["staleMissing"] = control.probe_namespace_stale(mount)
    # The run loop exits with PROBE_NAMESPACE_EXIT when refresh_probe_namespace says so, and only then.
    control.read_boot_id = lambda *_a: boot
    control.refresh_probe_namespace = lambda *_a, **_k: True
    control.secure_parents = lambda *_a, **_k: None  # the temp directory is world-writable /tmp; the parent rule is not under test
    try:
        control.run(load=lambda: {}, public=os.path.join(root, "public"), expected_uid=os.geteuid(), sleep=lambda _s: None)
        out["exit"] = None
    except SystemExit as stop:
        out["exit"] = stop.code
    out["exitConstant"] = control.PROBE_NAMESPACE_EXIT
shutil.rmtree(root)
print(json.dumps(out))
`;

describe("readiness checks on the heartbeat (Astra AUTOCANARY-2 P1): the UI bundle is on the image and the data volume takes a write", () => {
  let cached: Record<string, unknown> | undefined;
  const out = () => (cached ??= JSON.parse(execFileSync("python3", ["-I", "-c", checksScript, control], { encoding: "utf8", timeout: 60_000 })));
  const notWritable = { appResponding: true, checks: { uiBundle: true, dataWritable: false } };
  it("a missing volume never passes: /data on the root file system is refused", () => {
    expect(out().notMounted).toEqual(notWritable);
  });
  it("checks are omitted when they cannot be evaluated (no data mount)", () => {
    expect(out().noMount).toEqual({ appResponding: true });
  });
  it("the volume cases need a writable /dev/shm mount on its own device; root ownership is real as root and simulated otherwise", () => {
    // Fails loudly rather than skipping the volume cases unnoticed.
    expect(out().mount).toBe(true);
    expect(out().ownership).toBe(process.getuid?.() === 0 ? "real" : "simulated");
  });
  it("both true with the index file and the probe directory on the volume, and the probe file is never left behind", () => {
    const o = out();
    expect(o.ok).toEqual({ appResponding: true, checks: { uiBundle: true, dataWritable: true } });
    expect(o.leftBehind).toEqual([]);
    expect(healthSchema.parse(o.ok)).toEqual(o.ok); // exactly what the Worker accepts on the heartbeat
    expect(o.unprobed).toEqual({}); // no app report, no checks
  });
  it("uiBundle is manifest completeness: every file dist/.vite/manifest.json names is a non-empty regular file (Astra AUTOCANARY-4 P1)", () => {
    const o = out();
    expect([o.bundleComplete, o.bundleRestored, o.bundleAgain]).toEqual([true, true, true]);
    expect([o.bundleMissingChunk, o.bundleEmptyChunk, o.bundleSymlinkedCss]).toEqual([false, false, false]);
    expect(o.bundleBad).toEqual({ missing: false, notJson: false, empty: false, noIndexEntry: false, traversal: false, absolute: false,
      noFile: false, cssNotList: false, manifestSymlink: false });
    // The image's build writes the manifest where the check reads it.
    expect(readFileSync(fileURLToPath(new URL("../../vite.config.ts", import.meta.url)), "utf8")).toMatch(/\n\s*manifest: true,/);
    expect(readFileSync(control, "utf8")).toContain('UI_MANIFEST = ".vite/manifest.json"');
  });
  it("uiBundle is false when the index file is missing, not a regular file or empty", () => {
    const o = out();
    for (const name of ["noIndex", "indexIsDir", "emptyIndex"]) {
      expect(o[name], name).toEqual({ appResponding: true, checks: { uiBundle: false, dataWritable: true } });
    }
  });
  it("dataWritable is false when the probe directory is off the volume, missing, a file, a symlink, not root's or not exactly 0700", () => {
    const o = out();
    for (const name of ["crossDevice", "noProbe", "probeIsFile", "symlink", "groupWritable", "notExactly0700", "notRootOwned"]) {
      expect(o[name], name).toEqual(notWritable);
    }
  });
  it("the probe directory must be a top-level volume entry below root-controlled ancestors: never under a murage-owned parent (Astra AUTOCANARY-3 P1/P2)", () => {
    const o = out();
    expect(o.underMurageOwned).toEqual(notWritable);
    expect(o.ancestorsMurageOwned).toBe(false);
    expect(o.ancestorsRootOwned).toBe(true);
    expect(o.nestedRootOwned).toEqual(notWritable); // root-owned all the way, but not a top-level entry of the volume
    expect(o.ancestorsWorldWritableNoSticky).toBe(false);
    expect(o.ancestorsSticky).toBe(true); // /data is root:murage 1771: the sticky bit keeps its entries from being replaced
  });
  it("first boot: a probe directory read-only in this namespace (EROFS) asks for one restart per boot, with exit 75", () => {
    const o = out();
    expect([o.staleWritable, o.refreshWritable]).toEqual([false, false]); // writable: nothing to refresh
    expect(o.staleReadOnly).toBe(true);
    expect(o.refreshFirst).toBe(true);
    expect(o.mark).toBe("1b4e28ba-2fa1-41d2-883f-0016d3cca427\n");
    expect(o.refreshSecond).toBe(false); // once per boot: the check then just reports false
    expect(o.refreshNextBoot).toBe(true);
    expect(o.refreshNoBootId).toBe(false);
    expect(o.staleDenied).toBe(false); // only a read-only namespace, not any other failure
    expect(o.staleMissing).toBe(false); // no directory yet: nothing a restart would fix
    expect(o.exit).toBe(75);
    expect(o.exitConstant).toBe(75);
  });
  it("the unit makes only /data/.murage-health writable, has no pre-start, restarts for the fallback and keeps the sandbox", () => {
    const unit = readFileSync(fileURLToPath(new URL("../../deploy/cloud-home/murage-control.service", import.meta.url)), "utf8");
    const writable = unit.split("\n").filter(line => line.startsWith("ReadWritePaths="));
    expect(writable).toEqual(["ReadWritePaths=/run/murage-control", "ReadWritePaths=-/var/lib/murage-home/events", "ReadWritePaths=-/data/.murage-health"]);
    for (const line of ["ProtectSystem=strict", "NoNewPrivileges=yes", "CapabilityBoundingSet=", "AmbientCapabilities=", "Restart=on-failure",
      "RestartSec=10", "RuntimeDirectoryPreserve=restart", "RestartPreventExitStatus=78"]) expect(unit).toContain(`\n${line}\n`);
    expect(unit).not.toMatch(/^ExecStartPre=/m);
    expect(unit).not.toContain("--prepare-probe-dir");
    expect(unit).not.toMatch(/RestartPreventExitStatus=.*\b75\b/);
    const src = readFileSync(control, "utf8");
    expect(src).toContain('DATA_PROBE_DIR = DATA_MOUNT + "/.murage-health"');
    expect(src).not.toContain("prepare_probe_dir");
  });
});

// The home supervisor makes the probe directory (Astra AUTOCANARY-3 P1/P2): a top-level entry of the bound volume, root:root 0700,
// only after the binding marker, never by following a symlink; and backups leave it out.
describe("the supervisor's health probe directory", () => {
  const made: string[] = [];
  afterAll(() => { for (const dir of made) removeTempDirSync(dir); });
  const volume = () => { const dir = mkdtempSync(join(tmpdir(), "home-volume-")); made.push(dir); return dir; };
  it("is made root 0700 at /data/.murage-health, idempotently, repairing a wrong mode or owner", () => {
    const dir = volume();
    const owners: [number, number][] = [];
    prepareHealthProbeDir(dir, (_fd, uid, gid) => { owners.push([uid, gid]); });
    const probe = join(dir, HEALTH_PROBE_DIR_NAME);
    expect(probe.endsWith("/.murage-health")).toBe(true);
    expect(lstatSync(probe).isDirectory()).toBe(true);
    expect(lstatSync(probe).mode & 0o7777).toBe(0o700);
    chmodSync(probe, 0o755);
    prepareHealthProbeDir(dir, (_fd, uid, gid) => { owners.push([uid, gid]); });
    expect(lstatSync(probe).mode & 0o7777).toBe(0o700);
    expect(owners).toEqual([[0, 0], [0, 0]]);
  });
  it("refuses a symlink or a file planted at the name, and never touches the symlink's target", () => {
    const dir = volume(), elsewhere = volume();
    chmodSync(elsewhere, 0o755);
    symlinkSync(elsewhere, join(dir, HEALTH_PROBE_DIR_NAME));
    expect(() => prepareHealthProbeDir(dir, () => undefined)).toThrow();
    expect(lstatSync(elsewhere).mode & 0o7777).toBe(0o755);
    const other = volume();
    writeFileSync(join(other, HEALTH_PROBE_DIR_NAME), "");
    expect(() => prepareHealthProbeDir(other, () => undefined)).toThrow();
  });
  it("bindHomeVolume makes it only after the binding marker is validated, so an unbound volume never holds it", () => {
    const source = readFileSync(fileURLToPath(new URL("./home-volume-spec.ts", import.meta.url)), "utf8");
    const bind = source.slice(source.indexOf("export function bindHomeVolume("));
    const marker = bind.indexOf("validateVolumeMarker(stat"), probe = bind.indexOf("prepareHealthProbeDir(dataDir)");
    expect(marker).toBeGreaterThan(-1);
    expect(probe).toBeGreaterThan(marker);
    expect(bind.indexOf("assertUnboundVolumeEmpty(dataDir)")).toBeLessThan(marker);
  });
  it("backups exclude it", () => {
    expect(classifyDataDirEntry(".murage-health")?.backup).toBe("excluded");
  });
  it("Door v2: the heartbeat's X-Murage-Door header follows the last successful probe; a failed probe keeps it; a probe without door clears it", () => {
    const doorScript = String.raw`
import importlib.machinery, importlib.util, json, os, sys, tempfile
loader = importlib.machinery.SourceFileLoader("murage_control", sys.argv[1])
spec = importlib.util.spec_from_loader("murage_control", loader)
control = importlib.util.module_from_spec(spec)
loader.exec_module(control)
A = "1b4e28ba-2fa1-41d2-883f-0016d3cca427"
public = tempfile.mkdtemp()
binding = {"homeId": "home-test", "generation": 3, "publicOrigin": "https://home.murage.test"}
clock = lambda: {"wallMs": 1760000000000, "bootMs": 5000, "monoMs": 4000, "bootId": A, "ntpSynced": True}
lease = {"wire": 1, "installationId": "installation-test", "holder": "home-test", "generation": 3, "expiresAt": 1760003600000,
         "renewAfterMs": 60000, "ttlMs": 3600000, "skewMs": 120000}
calls = []
# Deliberately three parameters: a fake that does not know about door must keep working while the flag is off.
def plain(_binding, operation, body=None):
    if operation == "lease":
        return dict(lease)
    if operation == "heartbeat":
        calls.append(False)
        return {"wire": 1, "accepted": True}
    return {}
def withDoor(_binding, operation, body=None, door=False):
    if operation == "heartbeat":
        calls.append(door)
        return {"wire": 1, "accepted": True}
    return dict(lease) if operation == "lease" else {}
probe = {"answer": None}
context = {"appProbe": lambda origin: probe["answer"], "bootId": lambda: A}
def poll(answer, request):
    probe["answer"] = answer
    try:
        control._poll_once(binding, context, request, clock, public, os.getuid(), lambda *a: None)
    except ValueError:
        pass  # the desired request is refused after the heartbeat was sent
    return context.get("doorV2")
ok = {"ok": True, "ui": "ok", "uiAt": 1759999999000, "instance": "AbCdEfGhIjKlMnOpQrSt_-"}
steps = []
steps.append(poll({**ok}, plain))                      # no door, flag off: a three-parameter fake works
steps.append(poll({**ok, "door": "v2"}, withDoor))     # success with door: on
steps.append(poll({"ok": False, "door": None}, withDoor))  # failed probe: unchanged (on)
steps.append(poll(None, withDoor))                     # non-dict answer: unchanged (on)
steps.append(poll(False, withDoor))                    # bare False: unchanged (on)
steps.append(poll({**ok}, withDoor))                   # success without door: cleared
steps.append(poll({"ok": False}, withDoor))            # failed after clear: stays off
out = {"steps": steps, "calls": calls}
# machine_request sets the header only for heartbeat and only when asked.
import urllib.request
seen = []
class Resp:
    status = 200
    def read(self, n): return b'{"wire":1,"accepted":true}'
    def __enter__(self): return self
    def __exit__(self, *a): return False
class Opener:
    def open(self, request, timeout=None):
        seen.append({k.lower(): v for k, v in request.header_items()})
        return Resp()
control.urllib.request.build_opener = lambda *a: Opener()
b = {"adminUrl": "https://cp.test", "homeId": "home-test", "credential": "c"}
control.machine_request(b, "heartbeat", {"generation": 3})
control.machine_request(b, "heartbeat", {"generation": 3}, door=True)
control.machine_request(b, "lease", {"generation": 3}, door=True)
control.machine_request(b, "desired", None, door=True)
out["headers"] = [{"door": h.get("x-murage-door"), "evidence": h.get("x-murage-evidence")} for h in seen]
print(json.dumps(out))
`;
    const out = JSON.parse(execFileSync("python3", ["-I", "-c", doorScript, control], { encoding: "utf8", timeout: 60_000 }));
    expect(out.steps).toEqual([false, true, true, true, true, false, false]);
    expect(out.calls).toEqual([false, true, true, true, true, false, false]);
    expect(out.headers).toEqual([{ door: null, evidence: "epoch" }, { door: "v2", evidence: "epoch" }, { door: null, evidence: null }, { door: null, evidence: null }]);
    // No ack change: the heartbeat ack is still read exactly as before, and the 400 resend carries the header too.
    const src = readFileSync(control, "utf8");
    expect(src).toContain('strict_fields(heartbeat, ("wire", "accepted", "generation", "evidenceEpoch"))');
    expect(src.match(/request\(binding, "heartbeat", body, door=True, \*\*owner_extra\) if door else request\(binding, "heartbeat", body, \*\*owner_extra\)/g)).toHaveLength(2);
  });
});
