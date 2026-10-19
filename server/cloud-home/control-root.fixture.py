# SPDX-License-Identifier: AGPL-3.0-or-later
"""Disposable protocol fixture: real root module, injected CP/clock boundaries.

Files are actual descriptor-checked fixture-UID files beneath a private /work
fixture directory; only the fixture expected_uid differs from production zero.
CP requests retain only operation/body, never credentials.
The TypeScript fixture supplies a genuine matching ES256 public key/envelope.
No production URL, path, executable or main() override is shipped in product.
"""
import importlib.machinery
import importlib.util
import json
import os
import sys
import urllib.error

loader = importlib.machinery.SourceFileLoader("root_control_fixture", sys.argv[1])
spec = importlib.util.spec_from_loader(loader.name, loader)
module = importlib.util.module_from_spec(spec)
loader.exec_module(module)
root, scenario = sys.argv[2:4]
inputs = json.load(sys.stdin)
clock_value = dict(inputs["clock"])
requests = []
# The app probe (murage-control app_responding) and the boot id reader have their own test (app-health.test.ts); not used here.
context = {"appProbe": lambda _origin: None, "bootId": lambda: None}
binding = None
refused = False
snapshots = []
publication_order = []
atomic = module.atomic_public
def record_atomic(path, value, expected_uid=0):
    publication_order.append(os.path.basename(path))
    return atomic(path, value, expected_uid)
module.atomic_public = record_atomic

def clock():
    return dict(clock_value)

def request(current, operation, body=None):
    assert current == binding
    requests.append({"operation": operation, "body": body})
    if operation == "lease":
        if scenario in ("authorization-401", "authorization-403") and len(snapshots):
            raise urllib.error.HTTPError("https://admin.murage.test", int(scenario[-3:]), "refused", {}, None)
        if scenario == "ordinary-outage" and len(snapshots):
            raise urllib.error.URLError("synthetic transport unavailable")
        if scenario == "delay":
            for name in ("wallMs", "bootMs", "monoMs"):
                clock_value[name] += 10000
        value = dict(inputs["lease"])
        if scenario == "lease-generation":
            value["generation"] += 1
        if scenario == "lease-unknown":
            value["unknown"] = "refused"
        return wire_variant(value, "lease-")
    if operation == "heartbeat":
        return wire_variant({"wire": 1, "accepted": True}, "heartbeat-")
    value = wire_variant(json.loads(json.dumps(inputs["desired"])), "desired-")
    if scenario == "desired-generation":
        value["generation"] += 1
    if scenario == "desired-expiry":
        value["lease"]["expiresAt"] += 1
    if scenario == "secret-body":
        value["machineCredential"] = inputs["credential"]
    return value

def wire_variant(value, prefix):
    # Wire-version probes: missing, unknown, or the retired fake literal alone.
    if scenario == prefix + "wire-missing":
        del value["wire"]
    if scenario == prefix + "wire-2":
        value["wire"] = 2
    if scenario == prefix + "wire-true":
        value["wire"] = True
    if scenario == prefix + "fake-only":
        del value["wire"]
        value["fakeOnly"] = True
    return value

def poll():
    snapshot = module.poll_once(binding, context, request, clock, root + "/public", os.getuid())
    snapshots.append(snapshot)
    return snapshot

try:
    if scenario.startswith("secure-"):
        path = root + "/state/credential"
        if scenario == "secure-mode":
            os.chmod(path, 0o644)
        if scenario == "secure-symlink":
            os.rename(path, path + "-original")
            os.symlink(path + "-original", path)
        if scenario == "secure-parent":
            os.chmod(root + "/state", 0o777)
        if scenario == "secure-parent-symlink":
            os.rename(root + "/state", root + "/state-original")
            os.symlink(root + "/state-original", root + "/state")
        if scenario == "secure-generation":
            with open(root + "/state/generation", "w") as stream:
                stream.write("2.0")
        if scenario == "secure-trust":
            with open(root + "/config/control-plane-public-key.json", "w") as stream:
                stream.write('{"kty":"EC","crv":"P-256","d":"private"}')
        if scenario == "secure-missing-trust":
            os.unlink(root + "/config/control-plane-public-key.json")
    if scenario == "secure-world-parent":
        module.read_secure("/tmp/absent-control-fixture", expected_uid=os.getuid())
    binding = module.load_private_binding(root + "/state", root + "/config", os.getuid())
    if scenario.startswith("transport-"):
        class Response:
            status = 200
            def __enter__(self):
                return self
            def __exit__(self, *_):
                pass
            def read(self, limit):
                assert limit == 65537
                return b"x" * limit if scenario == "transport-oversize" else b'{"wire":1,"accepted":true}'
        class Opener:
            def open(self, outgoing, timeout):
                assert timeout == 15
                requests.append({"url": outgoing.full_url, "method": outgoing.method,
                                 "body": json.loads(outgoing.data),
                                 "bearerPresent": outgoing.get_header("Authorization") == "Bearer " + inputs["credential"],
                                 "secretInEnvironment": inputs["credential"] in repr(dict(os.environ))})
                return Response()
        def opener(*handlers):
            assert len(handlers) == 2 and handlers[0].proxies == {} and isinstance(handlers[1], module.NoRedirect)
            return Opener()
        module.urllib.request.build_opener = opener
        try:
            if scenario == "transport-redirect":
                module.NoRedirect().redirect_request(None)
            elif scenario == "transport-operation":
                module.machine_request(binding, "unwrap", {})
            else:
                module.machine_request(binding, "heartbeat", {"generation": 1})
        except ValueError:
            refused = True
        print(json.dumps({"refused": refused, "requests": requests}))
        sys.exit(0)
    if scenario == "helper":
        module.CLOCK = inputs["helper"]
        helper_value = module.read_clock(expected_uid=os.getuid())
        print(json.dumps({"clock": helper_value}))
        sys.exit(0)
    if scenario == "readiness":
        ticks = [0]
        def missing():
            raise FileNotFoundError()
        try:
            module.run(load=missing, sleep=lambda _: ticks.__setitem__(0, ticks[0] + 1),
                       monotonic=lambda: ticks[0], public=root + "/public", expected_uid=os.getuid())
        except ValueError:
            refused = True
        print(json.dumps({"refused": refused, "ticks": ticks[0], "requests": requests}))
        sys.exit(0)
    if scenario == "startup-run":
        ticks = [0]
        def sleep(_):
            raise StopIteration()
        try:
            module.run(load=lambda: binding, request=request, clock=clock, sleep=sleep,
                       monotonic=lambda: ticks[0], public=root + "/public", expected_uid=os.getuid())
        except StopIteration:
            pass
    else:
        first = poll()
        if scenario in ("suspend", "jump-forward", "jump-backward", "ntp", "boot-change", "unknown-clock"):
            for name in ("wallMs", "bootMs", "monoMs"):
                clock_value[name] += 1000
            if scenario == "suspend":
                clock_value["bootMs"] += 10000
                clock_value["wallMs"] += 10000
            if scenario == "jump-forward":
                clock_value["wallMs"] += 5001
            if scenario == "jump-backward":
                clock_value["wallMs"] -= 5001
            if scenario == "ntp":
                clock_value["ntpSynced"] = False
            if scenario == "boot-change":
                clock_value["bootId"] = "99999999-1111-1111-1111-111111111111"
            try:
                if scenario == "unknown-clock":
                    module.sample_clock(context, lambda: (_ for _ in ()).throw(ValueError("missing helper")), root + "/public")
                else:
                    module.sample_clock(context, clock, root + "/public")
            except ValueError:
                refused = True
        if scenario == "renew-after-invalidation":
            clock_value["wallMs"] += 5001
            try:
                module.sample_clock(context, clock, root + "/public")
            except ValueError:
                pass
            # Subsequent send after anomaly is the only operation clearing fence.
            inputs["lease"]["expiresAt"] = int(clock_value["wallMs"] + 3600000)
            inputs["desired"]["lease"]["expiresAt"] = inputs["lease"]["expiresAt"]
            poll()
        if scenario == "ordinary-outage":
            for name in ("wallMs", "bootMs", "monoMs"):
                clock_value[name] += 1800000
            try:
                poll()
            except urllib.error.URLError:
                pass
            module.sample_clock(context, clock, root + "/public")
        if scenario in ("authorization-401", "authorization-403"):
            poll()
        if scenario == "restart":
            # A reader/process restart cannot rewrite or extend existing send time.
            before = open(root + "/public/state.json").read()
            replacement_context = {}
            for name in ("wallMs", "bootMs", "monoMs"):
                clock_value[name] += 1800000
            module.sample_clock(replacement_context, clock, root + "/public")
            assert before == open(root + "/public/state.json").read()
except Exception:
    refused = True

files = {}
for name in ("state.json", "home-generation.json", "home-identity.json"):
    path = root + "/public/" + name
    if os.path.exists(path):
        with open(path) as stream:
            files[name] = json.load(stream)
print(json.dumps({"refused": refused, "requests": requests, "snapshots": snapshots,
                  "files": files, "invalidated": context.get("invalidated", False), "publicationOrder": publication_order}))
