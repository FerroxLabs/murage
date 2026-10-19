#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
import contextlib
import importlib.util
import io
import json
import pathlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("hz_live", pathlib.Path(__file__).with_name("hz-live.py"))
hz = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hz)

TOKEN = "SECRET-TOKEN-abc123"


class Fake:
    def __init__(self, routes):
        self.routes = routes
        self.calls = []

    def __call__(self, method, url, headers, body):
        path = url.replace(hz.BASE, "")
        self.calls.append((method, path))
        assert headers["Authorization"].endswith(TOKEN)
        for (m, prefix), resp in self.routes.items():
            if m == method and path.startswith(prefix):
                if callable(resp):
                    resp = resp(path, body)
                status, payload = resp
                return status, json.dumps(payload).encode()
        return 404, json.dumps({"error": {"code": "not_found", "message": "nope"}}).encode()


def client(routes):
    return hz.Client(TOKEN, Fake(routes), sleep=lambda s: None)


class T(unittest.TestCase):
    def test_guard_refuses_foreign_delete(self):
        with tempfile.TemporaryDirectory() as d:
            fake = Fake({})
            drv = hz.Driver(hz.Client(TOKEN, fake, sleep=lambda s: None), d, 250, out=lambda *a: None)
            for bad in ({"id": 1, "name": "prod", "labels": {"mcq": "1"}}, {"id": 2, "name": "mcq-x", "labels": {}}):
                with self.assertRaises(hz.QualError):
                    drv.delete_server(bad)
                with self.assertRaises(hz.QualError):
                    drv.delete_volume(bad)
            self.assertEqual(fake.calls, [])

    def test_snapshot_hourly_accepts_float_size(self):
        # The sixth real image build crashed here mixing Decimal and float.
        with tempfile.TemporaryDirectory() as d:
            routes = {("GET", "/pricing"): (200, {"pricing": {"currency": "USD", "image": {"price_per_gb_month": {"gross": "0.0119"}}}})}
            drv = hz.Driver(hz.Client(TOKEN, Fake(routes), sleep=lambda s: None), d, 10, out=lambda *a: None)
            self.assertEqual(drv.snapshot_hourly(20.0), hz.D("0.0119") * hz.D("20.0") / hz.HOURS_PER_MONTH)

    def test_cap_refusal(self):
        with tempfile.TemporaryDirectory() as d:
            routes = {("GET", "/pricing"): (200, {"pricing": {"currency": "EUR", "volume": {"price_per_gb_month": {"gross": "0.05"}}, "primary_ips": []}})}
            drv = hz.Driver(hz.Client(TOKEN, Fake(routes), sleep=lambda s: None), d, 10, out=lambda *a: None)
            with self.assertRaises(hz.QualError) as cm:
                drv.check_cap(hz.D("1.0"))  # 24 > 10
            self.assertIn("SPEND CAP", str(cm.exception))
            drv.check_cap(hz.D("0.1"))

    def test_pagination(self):
        def pages(path, body):
            if "page=1" in path:
                return 200, {"servers": [{"id": 1}], "meta": {"pagination": {"next_page": 2}}}
            return 200, {"servers": [{"id": 2}], "meta": {"pagination": {"next_page": None}}}
        c = client({("GET", "/servers"): pages})
        self.assertEqual([s["id"] for s in c.list_all("/servers", "servers")], [1, 2])

    def test_action_error_path_and_no_token(self):
        c = client({("GET", "/actions/9"): (200, {"action": {"id": 9, "status": "error", "command": "create_server", "error": {"code": "boom"}}})})
        with self.assertRaises(hz.QualError) as cm:
            c.wait_action({"id": 9, "status": "running", "command": "create_server"})
        self.assertNotIn(TOKEN, str(cm.exception))
        self.assertIn("boom", str(cm.exception))

    def test_action_deadline(self):
        t = [0]
        c = hz.Client(TOKEN, Fake({("GET", "/actions/1"): (200, {"action": {"id": 1, "status": "running", "command": "x"}})}),
                      sleep=lambda s: t.__setitem__(0, t[0] + s), clock=lambda: t[0])
        with self.assertRaises(hz.QualError):
            c.wait_action({"id": 1, "status": "running", "command": "x"}, timeout=10)

    def test_http_error_hides_token_and_main_output(self):
        with tempfile.TemporaryDirectory() as d:
            tf = pathlib.Path(d) / "tok"
            tf.write_text(TOKEN + "\n")
            bad = lambda m, u, h, b: (401, json.dumps({"error": {"code": "unauthorized", "message": "bad " + TOKEN}}).encode())
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                rc = hz.main(["list", "--token-file", str(tf), "--evidence", d], transport=bad, sleep=lambda s: None)
            self.assertEqual(rc, 1)
            self.assertNotIn(TOKEN, out.getvalue() + err.getvalue())
            self.assertNotIn("Traceback", err.getvalue())

    def test_spend_rounds_up_hours(self):
        import datetime as dt
        with tempfile.TemporaryDirectory() as d:
            t0 = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)
            clock = [t0]
            led = hz.Ledger(pathlib.Path(d) / "spend.jsonl", now=lambda: clock[0])
            led.create("server", 1, "mcq-a", "cpx22", "fsn1", hz.D("0.5"), "EUR")
            clock[0] = t0 + dt.timedelta(minutes=61)
            total, cur = led.accrued()
            self.assertEqual(total, hz.D("1.0"))
            led.delete("server:1")
            clock[0] = t0 + dt.timedelta(days=5)
            self.assertEqual(led.accrued()[0], hz.D("1.0"))


ADMIN = "ADMINTOKEN-0123456789abcdef0123456789abcdef"
ENROLL = "ENROLLTOKEN-0123456789abcdef0123456789abcdef"
SRV = {"id": 77, "name": "mcq-h1", "labels": {"mcq": "1"}, "volumes": [55], "public_net": {"ipv4": {"ip": "203.0.113.9"}}}
VOL = {"id": 55, "name": "mcq-h1-vol", "labels": {"mcq": "1"}}


class Proc:
    def __init__(self, rc=0, out=b""):
        self.returncode, self.stdout, self.stderr = rc, out, b""


class EnrollEnv:
    def __init__(self, d, srv=SRV, cp=None, run_out=b"murage-home.service active\n"):
        self.d = pathlib.Path(d)
        self.secrets = self.d / "cp.json"
        self.secrets.write_text(json.dumps({"CLOUD_ADMIN_TOKEN": ADMIN}))
        self.cp_calls, self.runs, self.out = [], [], []
        routes = {("GET", "/servers"): (200, {"servers": [srv], "meta": {"pagination": {"next_page": None}}}),
                  ("GET", "/volumes/55"): (200, {"volume": VOL})}
        self.drv = hz.Driver(client(routes), d, 250, out=self.out.append)

        def run(argv, **kw):
            self.runs.append((argv, kw.get("input")))
            return Proc(0, run_out + (b"leak " + ENROLL.encode() if kw.get("input") is None and argv[-1] != "true" else b""))
        self.drv.run = run

        def cp_transport(method, url, headers, body):
            self.cp_calls.append((method, url, headers, body))
            if cp:
                return cp
            return 201, json.dumps({"machineId": "mcq-h1", "homeId": "mcq-h1", "enrollmentToken": ENROLL, "generation": 1}).encode()
        self.cp = cp_transport

    def go(self, **kw):
        args = dict(suffix="h1", cp_url="https://cp.example.dev", cp_secrets=str(self.secrets), public_origin="https://h1.example.dev", ssh_from="198.51.100.4")
        args.update(kw)
        self.drv.cmd_enroll_home(cp_transport=self.cp, **args)


class E(unittest.TestCase):
    def test_cp_request_shape_and_auth(self):
        with tempfile.TemporaryDirectory() as d:
            e = EnrollEnv(d)
            e.go()
            method, url, headers, body = e.cp_calls[0]
            self.assertEqual((method, url), ("POST", "https://cp.example.dev/v1/machines"))
            self.assertEqual(headers["Authorization"], "Bearer " + ADMIN)
            self.assertEqual(json.loads(body), {"homeId": "mcq-h1", "publicOrigin": "https://h1.example.dev", "adminUrl": "https://cp.example.dev",
                                                "serverId": "77", "boundIps": ["203.0.113.9"]})

    def test_secrets_never_in_argv_or_output_and_go_over_stdin(self):
        with tempfile.TemporaryDirectory() as d:
            e = EnrollEnv(d)
            e.go()
            for argv, _ in e.runs:
                self.assertNotIn(ENROLL, " ".join(argv))
                self.assertNotIn(ADMIN, " ".join(argv))
                self.assertNotIn(TOKEN, " ".join(argv))
            stdins = [i for _, i in e.runs if i]
            self.assertEqual(len(stdins), 1)
            self.assertIn("murage_enrollment_token: " + ENROLL, stdins[0].decode())
            self.assertIn("murage_home_id: mcq-h1", stdins[0].decode())
            joined = "\n".join(e.out) + (pathlib.Path(d) / "spend.jsonl").read_text()
            for secret in (ENROLL, ADMIN, TOKEN):
                self.assertNotIn(secret, joined)
            self.assertIn("[redacted]", joined)

    def test_unit_order_and_ssh_allow(self):
        with tempfile.TemporaryDirectory() as d:
            e = EnrollEnv(d)
            e.go()
            script = e.runs[-1][0][-1]
            order = ["murage-volume.service", "data.mount", "murage-egress.service", "murage-home.service", "murage-proxy.service"]
            self.assertIn("for u in " + " ".join(order) + ";", script)
            self.assertIn("nft add element inet murage_home qual_ssh { 198.51.100.4/32 }", script)
            self.assertLess(script.index("qual-ssh.conf"), script.index("systemctl start"))
            self.assertIn("/etc/murage-home/volume.json", script)
            self.assertIn('"homeId":"mcq-h1"', script)
            ev = [json.loads(l) for l in (pathlib.Path(d) / "spend.jsonl").read_text().splitlines()]
            self.assertEqual(ev[-1]["event"], "enroll")

    def test_name_guard_blocks_before_cp_call(self):
        with tempfile.TemporaryDirectory() as d:
            e = EnrollEnv(d, srv=dict(SRV, labels={}))
            with self.assertRaises(hz.QualError):
                e.go()
            self.assertEqual(e.cp_calls, [])
            self.assertEqual(e.runs, [])
            e2 = EnrollEnv(d, srv=dict(SRV, name="prod"))
            with self.assertRaises(hz.QualError):
                e2.go()
            self.assertEqual(e2.cp_calls, [])

    def test_cp_refusal_no_ssh_and_no_leak(self):
        with tempfile.TemporaryDirectory() as d:
            e = EnrollEnv(d, cp=(401, ADMIN.encode()))
            with self.assertRaises(hz.QualError) as cm:
                e.go()
            self.assertNotIn(ADMIN, str(cm.exception))
            self.assertEqual(e.runs, [])

    def test_bad_inputs(self):
        with tempfile.TemporaryDirectory() as d:
            e = EnrollEnv(d)
            for kw in ({"cp_url": "http://cp.example.dev"}, {"public_origin": "https://x.dev/path"}, {"ssh_from": "0.0.0.0/0"}):
                with self.assertRaises(hz.QualError):
                    e.go(**kw)
            self.assertEqual(e.cp_calls, [])

    def test_managed_endpoint_sends_flag_takes_origin_from_response_and_starts_token_unit(self):
        with tempfile.TemporaryDirectory() as d:
            resp = (201, json.dumps({"machineId": "mcq-h1", "homeId": "mcq-h1", "enrollmentToken": ENROLL, "generation": 1,
                                     "public_origin": "https://abc123.homes.example.dev"}).encode())
            e = EnrollEnv(d, cp=resp)
            e.go(public_origin=None, managed_endpoint=True)
            body = json.loads(e.cp_calls[0][3])
            self.assertEqual(body, {"homeId": "mcq-h1", "managed_endpoint": True, "adminUrl": "https://cp.example.dev",
                                    "serverId": "77", "boundIps": ["203.0.113.9"]})
            script = e.runs[-1][0][-1]
            self.assertIn("systemctl start --no-block murage-tunnel-token.service", script)
            self.assertIn("public_origin=https://abc123.homes.example.dev", "\n".join(e.out))

    def test_managed_endpoint_refuses_public_origin_and_missing_origin_in_response(self):
        with tempfile.TemporaryDirectory() as d:
            e = EnrollEnv(d)
            with self.assertRaises(hz.QualError):
                e.go(managed_endpoint=True)  # --public-origin is exclusive with it
            with self.assertRaises(hz.QualError):
                e.go(public_origin=None, managed_endpoint=True)  # default response has no public_origin
            with self.assertRaises(hz.QualError):
                e.go(public_origin=None)  # the old path still requires it
            self.assertEqual(e.runs, [])

    def test_default_enroll_body_unchanged_and_no_tunnel_unit(self):
        with tempfile.TemporaryDirectory() as d:
            e = EnrollEnv(d)
            e.go()
            self.assertNotIn("managed_endpoint", json.loads(e.cp_calls[0][3]))
            self.assertNotIn("murage-tunnel-token", e.runs[-1][0][-1])

    def test_fw_world_open_80_443_only_without_managed_endpoint(self):
        with tempfile.TemporaryDirectory() as d:
            seen = []
            def create(path, body):
                seen.append(json.loads(body)["rules"])
                return 201, {"firewall": {"id": 9}, "actions": [], "next_actions": []}
            routes = {("GET", "/firewalls"): (200, {"firewalls": [], "meta": {"pagination": {"next_page": None}}}), ("POST", "/firewalls"): create}
            drv = hz.Driver(client(routes), d, 250, out=lambda *a: None)
            drv.cmd_fw(["198.51.100.4"])
            drv.cmd_fw(["198.51.100.4"], managed_endpoint=True)
            self.assertEqual([r["port"] for r in seen[0]], ["80", "443", "22"])
            self.assertEqual([r["port"] for r in seen[1]], ["22"])
            self.assertEqual(seen[1][0]["source_ips"], ["198.51.100.4/32"])

    def test_create_home_ipv4_only_no_user_data(self):
        with tempfile.TemporaryDirectory() as d:
            bodies = {}
            running = dict(SRV, status="running")
            routes = {
                ("GET", "/pricing"): (200, {"pricing": {"currency": "EUR", "volume": {"price_per_gb_month": {"gross": "0.05"}}, "primary_ips": []}}),
                ("GET", "/server_types"): (200, {"server_types": [{"prices": [{"location": "fsn1", "price_hourly": {"gross": "0.01"}}]}]}),
                ("POST", "/volumes"): (200, {"volume": VOL, "actions": [], "next_actions": []}),
                ("POST", "/servers"): lambda p, b: (bodies.__setitem__("s", json.loads(b)) or (201, {"server": SRV, "actions": [], "next_actions": []})),
                ("GET", "/servers/77"): (200, {"server": running}),
            }
            out = []
            hz.Driver(client(routes), d, 250, out=out.append).cmd_create_home("h1", "cpx22", "fsn1", "123", "key", 10, None)
            self.assertEqual(bodies["s"]["public_net"], {"enable_ipv4": True, "enable_ipv6": False})
            self.assertNotIn("user_data", bodies["s"])
            self.assertIn("ipv4=203.0.113.9", out[-1])


class ControlJwkTest(unittest.TestCase):
    def write(self, d, obj):
        f = pathlib.Path(d) / "k.json"
        f.write_text(obj if isinstance(obj, str) else json.dumps(obj))
        return f

    def test_public_fields_only_and_private_refused_locally(self):
        pub = {"kty": "EC", "crv": "P-256", "x": "AAAA", "y": "BBBB", "kid": "k1", "extra": "dropped"}
        with tempfile.TemporaryDirectory() as d:
            out = json.loads(hz.public_control_jwk(self.write(d, pub)))
            self.assertEqual(out, {"kty": "EC", "crv": "P-256", "x": "AAAA", "y": "BBBB", "kid": "k1"})
            for bad in [dict(pub, d="SECRET"), dict(pub, k="SECRET"), {"kty": "RSA", "n": "x", "e": "AQAB"},
                        {"kty": "EC", "crv": "P-256", "x": "AAAA"}, "not json", ["list"]]:
                with self.assertRaises(hz.QualError) as cm:
                    hz.public_control_jwk(self.write(d, bad))
                self.assertNotIn("SECRET", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
