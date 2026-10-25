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


PUB_BODY = "MCowBQYDK2VwAyEAstagingstagingstagingstagingstagingstagi="
CHANNEL = "https://staging-releases.example.dev/cloud-home"
RUNNING = dict(SRV, id=88, name="mcq-builder-x", status="running", labels={"mcq": "1"}, public_net={"ipv4": {"ip": "203.0.113.20"}})


class ImageEnv:
    """The image subcommand with SSH, rsync, openssl, signing and the build host API all mocked."""

    def __init__(self, d, pub_body=PUB_BODY, typ="cx33", lane=None):
        import os
        import subprocess
        self.d = pathlib.Path(d)
        self.repo = self.d / "repo"
        self.repo.mkdir()
        git = lambda *a: subprocess.run(["git", "-C", str(self.repo), "-c", "user.name=t", "-c", "user.email=t@e.x", *a], check=True, capture_output=True)
        git("init", "-q")
        (self.repo / "f").write_text("x")
        git("add", "f")
        git("commit", "-q", "-m", "m")
        self.rev = subprocess.run(["git", "-C", str(self.repo), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
        self.key = self.d / "staging-release.pem"
        self.key.write_text("not a real key")
        self.pub_body, self.typ, self.lane = pub_body, typ, lane
        self.runs, self.api = [], []
        self.server_gets = [0]

        def api(method, url, headers, body):
            path = url.replace(hz.BASE, "")
            self.api.append((method, path))
            if (method, path.split("?")[0]) == ("GET", "/servers/88"):
                self.server_gets[0] += 1
                return 200, json.dumps({"server": RUNNING if self.server_gets[0] == 1 else dict(RUNNING, status="off")}).encode()
            ok = {"action": {"id": 1, "status": "success", "command": "x"}}
            table = {("GET", "/pricing"): {"pricing": {"currency": "EUR", "image": {"price_per_gb_month": {"gross": "0.01"}}, "primary_ips": []}},
                     ("GET", "/server_types"): {"server_types": [{"prices": [{"location": "fsn1", "price_hourly": {"gross": "0.01"}}]}]},
                     ("POST", "/servers"): {"server": RUNNING, "actions": [], "next_actions": []},
                     ("POST", "/servers/88/actions/shutdown"): ok,
                     ("POST", "/servers/88/actions/create_image"): {"image": {"id": 5, "image_size": 4}, "action": ok["action"]},
                     ("DELETE", "/servers/88"): ok}
            for (m, pre), payload in table.items():
                if m == method and path.split("?")[0] == pre:
                    return 200, json.dumps(payload).encode()
            return 404, b"{}"
        self.drv = hz.Driver(hz.Client(TOKEN, api, sleep=lambda s: None), d, 250, out=lambda *a: None)
        self.drv.evidence = self.d / "ev"
        self.drv.ledger = hz.Ledger(self.drv.evidence / "spend.jsonl")
        self.openssl_calls = []

        def run(argv, env_extra=None, **kw):
            self.runs.append((list(argv), env_extra))
            text = " ".join(argv)
            if argv[0] == "/fake/openssl":
                self.openssl_calls.append(argv)
                if "-pubout" in argv:
                    pathlib.Path(argv[argv.index("-out") + 1]).write_text("-----BEGIN PUBLIC KEY-----\n%s\n-----END PUBLIC KEY-----\n" % self.pub_body)
                return Proc(0, b"ED25519 Public-Key:")
            if argv[0] == "bash" and "cloud-home-sign.sh" in argv[1]:
                pathlib.Path(argv[2] + ".sig").write_bytes(b"s" * 64)
            if argv[0] == "rsync" and "manifest.json" in text and "root@" in argv[-2]:
                (self.drv.evidence / ("release-%s-%s" % (self.rev[:12], "aarch64" if lane else "x86_64")) / "manifest.json").write_text("{}")
            return Proc(0, b"")
        self.drv.run = run
        self._orig = hz.resolve_openssl
        hz.resolve_openssl = lambda explicit=None, **k: "/fake/openssl"

    def close(self):
        hz.resolve_openssl = self._orig

    def go(self, **kw):
        args = dict(revision=self.rev, source=str(self.repo), typ=self.typ, location="fsn1", ssh_key="k", lane=self.lane, release_key=str(self.key),
                    release_channel=CHANNEL, release_sequence="7", env="staging")
        args.update(kw)
        self.drv.cmd_image(**args)

    def remote(self):
        return [a[-1] for a, _ in self.runs if a[0] == "ssh"]


class ImageTest(unittest.TestCase):
    def env(self, **kw):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        e = ImageEnv(d.name, **kw)
        self.addCleanup(e.close)
        return e

    def test_stage_order(self):
        e = self.env()
        e.go()
        marks = []
        for argv, _ in e.runs:
            t = " ".join(argv) + " "
            for name, needle in (("tree", "MURAGE_IMAGE_STAGE=tree"), ("prepare", " prepare x86_64 "), ("pull", "root@203.0.113.20:/build/out/x86_64/manifest.json "),
                                 ("sign", "cloud-home-sign.sh"), ("push", "manifest.json.sig"), ("finalize", " finalize x86_64 "), ("seal", "MURAGE_IMAGE_STAGE=seal")):
                if needle in t and (name != "push" or "root@203.0.113.20:/build/out" in t) and (name != "sign" or argv[0] == "bash"):
                    marks.append(name)
        self.assertEqual(marks, ["tree", "prepare", "pull", "sign", "push", "finalize", "seal"])
        self.assertEqual(e.drv.evidence.joinpath("sign.log").exists(), True)
        # snapshot logic ran only after seal
        self.assertEqual([m for m, _ in e.api][-4:], ["POST", "GET", "POST", "DELETE"])

    def test_arch_explicit_per_lane(self):
        e = self.env()
        e.go()
        r = " ".join(e.remote())
        self.assertIn("prepare x86_64 %s" % e.rev, r)
        self.assertIn("finalize x86_64 %s" % e.rev, r)
        self.assertIn("= x86_64", r)
        self.assertEqual([a for a, _ in e.runs if a[0] == "bash"][0][2:], [str(e.drv.evidence.resolve() / ("release-%s-x86_64" % e.rev[:12]) / "manifest.json"), e.rev, "x86_64", "7"])
        a = self.env(typ="cax21", lane="arm")
        a.go()
        r = " ".join(a.remote())
        self.assertIn("prepare aarch64 %s" % a.rev, r)
        self.assertIn("finalize aarch64 %s" % a.rev, r)
        self.assertEqual([x for x, _ in a.runs if x[0] == "bash"][0][4], "aarch64")
        for bad in (dict(typ="cax21", lane=None), dict(typ="cx33", lane="arm")):
            with self.assertRaises(hz.QualError):
                hz.builder_arch(bad["lane"], bad["typ"])

    def test_builder_under_8gb_refused_with_the_minimum_named(self):
        for small, lane in (("cx23", None), ("cax11", "arm"), ("cpx11", None)):
            with self.assertRaises(hz.QualError) as raised:
                hz.builder_arch(lane, small)
            self.assertIn("cx33", str(raised.exception))
            self.assertIn("cax21", str(raised.exception))
        self.assertEqual(hz.builder_arch(None, "cx33"), "x86_64")
        self.assertEqual(hz.builder_arch("arm", "cax21"), "aarch64")

    def test_key_path_never_in_any_argv_only_local_env(self):
        e = self.env()
        e.go()
        for argv, _ in e.runs:
            if argv[0] != "/fake/openssl":  # only the local public-key derivation names the key file
                self.assertNotIn(str(e.key), " ".join(argv))
                self.assertNotIn(str(e.key.resolve()), " ".join(argv))
        for cmd in e.remote():
            self.assertNotIn(str(e.key), cmd)
            self.assertNotIn("SIGNING_KEY", cmd)
            self.assertNotIn(e.key.name, cmd)
        for argv, env in e.runs:
            if argv[0] in ("ssh", "rsync"):
                self.assertNotIn(str(e.key), " ".join(argv))
                self.assertIsNone(env)
        signs = [(a, env) for a, env in e.runs if a[0] == "bash"]
        self.assertEqual(signs[0][1]["MURAGE_RELEASE_SIGNING_KEY"], str(e.key.resolve()))
        # only the derived public key is copied to the builder
        self.assertTrue(any(a[0] == "rsync" and a[-2].endswith("release-public.pem") for a, _ in e.runs))
        self.assertIn("MURAGE_RELEASE_CHANNEL_URL=%s" % CHANNEL, " ".join(e.remote()))

    def test_missing_options_refused_before_any_server(self):
        e = self.env()
        for kw in (dict(release_key=None), dict(release_channel=None), dict(release_sequence=None), dict(release_sequence="0"),
                   dict(release_channel="http://x.example"), dict(release_key=str(e.d / "nope"))):
            with self.assertRaises(hz.QualError):
                e.go(**kw)
        self.assertEqual(e.api, [])
        self.assertFalse([r for r in e.runs if r[0][0] == "ssh"])
        for flag in ("--release-signing-key", "--release-channel", "--release-sequence"):
            args = ["image", "--token-file", "t", "--revision", e.rev, "--source", ".", "--ssh-key", "k",
                    "--release-signing-key", "k", "--release-channel", CHANNEL, "--release-sequence", "1"]
            i = args.index(flag)
            del args[i:i + 2]
            with contextlib.redirect_stderr(io.StringIO()) as err, self.assertRaises(SystemExit):
                hz.build_parser().parse_args(args)
            self.assertIn(flag, err.getvalue())

    def test_prod_key_dir_refused_including_symlink(self):
        import os
        e = self.env()
        home = e.d / "home"
        (home / ".config" / "murage-prod").mkdir(parents=True)
        link = e.d / "innocent.pem"
        old = os.environ.get("HOME")
        os.environ["HOME"] = str(home)
        try:
            # never created or opened: the refusal is on the path alone
            direct = str(home / ".config" / "murage-prod" / "release.pem")
            link.symlink_to(direct)
            for path in (direct, str(link), "~/.config/murage-prod/release.pem"):
                with self.assertRaises(hz.QualError) as cm:
                    e.go(release_key=path)
                self.assertIn("production", str(cm.exception))
        finally:
            if old is None:
                del os.environ["HOME"]
            else:
                os.environ["HOME"] = old
        self.assertEqual(e.api, [])
        self.assertEqual(e.openssl_calls, [])

    def test_prod_public_half_refused(self):
        e = self.env(pub_body=hz.PROD_RELEASE_PUBLIC_B64)
        with self.assertRaises(hz.QualError) as cm:
            e.go()
        self.assertIn("production release key", str(cm.exception))
        self.assertEqual(e.api, [])
        self.assertFalse([r for r in e.runs if r[0][0] in ("ssh", "bash")])

    def test_prod_channel_refused(self):
        e = self.env()
        for url in ("https://releases.murage.ai/cloud-home", "https://releases.murage.ai/cloud-home/"):
            with self.assertRaises(hz.QualError):
                e.go(release_channel=url)
        self.assertEqual(e.api, [])
        self.assertEqual(e.runs, [])

    def test_openssl_refuses_libressl(self):
        fake = lambda out: (lambda argv, **k: type("R", (), {"stdout": out})())
        hz.resolve_openssl("/x/openssl", run=fake("OpenSSL 3.5.0 8 Apr 2025"))
        for bad in ("LibreSSL 3.3.6", "OpenSSL 1.1.1w", ""):
            with self.assertRaises(hz.QualError):
                hz.resolve_openssl("/x/openssl", run=fake(bad))
        with self.assertRaises(hz.QualError):
            hz.resolve_openssl(None, run=fake("OpenSSL 3.5.0"), platform="darwin") if not pathlib.Path("/opt/homebrew/bin/openssl").exists() else (_ for _ in ()).throw(hz.QualError("n/a"))


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


class VerifyWorld:
    """Stateful fake build host for verify-image; `events` is the ordered list of everything the flow did."""
    def __init__(self, labels=None, check_rc=0, fail_at=None, gone_after=0):
        self.events, self.fail_at, self.check_rc, self.gone_after = [], fail_at, check_rc, gone_after
        self.image_labels = dict({"murage/role": "image", "murage/image-kind": "unverified", "murage/env": "prod"} if labels is None else labels)
        self.server, self.gets_after_delete = None, 0

    def transport(self, method, url, headers, body):
        path = url.replace(hz.BASE, "")
        body = json.loads(body) if body else {}
        ok = lambda payload: (200, json.dumps(payload).encode())
        act = {"action": {"id": 9, "status": "success", "command": "x"}}
        if method == "GET" and path.startswith("/images/"):
            return ok({"image": {"id": 55, "type": "snapshot", "description": "mcq-home-abcdef123456", "labels": dict(self.image_labels), "disk_size": 20, "architecture": "x86"}})
        if path.startswith("/server_types"):
            return ok({"server_types": [{"name": "big", "disk": 80, "architecture": "x86", "prices": [{"location": "fsn1", "price_hourly": {"gross": "0.05"}}]},
                                         {"name": "small", "disk": 40, "architecture": "x86", "prices": [{"location": "fsn1", "price_hourly": {"gross": "0.01"}}]},
                                         {"name": "retired", "disk": 40, "architecture": "x86", "prices": [{"location": "fsn1", "price_hourly": {"gross": "0.002"}}],
                                          "locations": [{"name": "fsn1", "available": False, "deprecation": {"announced": "x"}}]},
                                         {"name": "tiny", "disk": 10, "architecture": "x86", "prices": [{"location": "fsn1", "price_hourly": {"gross": "0.001"}}]}],
                        "meta": {"pagination": {"next_page": None}}})
        if path == "/pricing":
            return ok({"pricing": {"currency": "EUR", "primary_ips": []}})
        if method == "POST" and path == "/servers":
            self.events.append("create")
            self.server = {"id": 777, "name": body["name"], "labels": body["labels"], "status": "off", "type": body["server_type"], "start_after_create": body["start_after_create"]}
            return ok({"server": self.server, "action": act["action"]})
        if method == "POST" and path.endswith("/enable_rescue"):
            if self.fail_at == "rescue":
                return 500, json.dumps({"error": {"code": "boom", "message": "x"}}).encode()
            self.events.append("rescue")
            return ok(act)
        if method == "POST" and path.endswith("/poweron"):
            self.events.append("poweron")
            self.server["status"] = "running"
            return ok(act)
        if method == "GET" and path == "/servers/777":
            if self.events and self.events[-1] == "delete":
                self.gets_after_delete += 1
                if self.gets_after_delete > self.gone_after:
                    self.events.append("gone")
                    return 404, json.dumps({"error": {"code": "not_found", "message": "x"}}).encode()
            return ok({"server": dict(self.server, public_net={"ipv4": {"ip": "192.0.2.7"}})})
        if method == "DELETE" and path == "/servers/777":
            self.events.append("delete")
            return ok(act)
        if method == "PUT" and path == "/images/55":
            self.events.append("label")
            self.image_labels = body["labels"]
            return ok({"image": {"id": 55}})
        return 404, json.dumps({"error": {"code": "not_found", "message": path}}).encode()


def verify_driver(world, d):
    drv = hz.Driver(hz.Client(TOKEN, world.transport, sleep=lambda s: None), d, 250, out=lambda *a: None)
    def run(argv, **kw):
        cmd = argv[-1]
        if cmd == "true":
            return subprocess_result(0)
        if cmd.startswith("set -e; mkdir -p /mnt/img"):
            world.events.append("mount-ro")
            self_check = "mount -o ro,noload" in cmd
            assert self_check
            return subprocess_result(3 if world.fail_at == "mount" else 0)
        if cmd.startswith("bash -s -- /mnt/img"):
            world.events.append("check")
            assert b"image-release-check" in kw["input"]
            out = b"image-release-check: FAIL openssh-server package is present\n" if world.check_rc else b"image-release-check: ok\n"
            return subprocess_result(world.check_rc, out)
        raise AssertionError(cmd)
    drv.run = run
    return drv


def subprocess_result(rc, out=b""):
    class R:
        returncode, stdout, stderr = rc, out, b""
    return R()


class VerifyImage(unittest.TestCase):
    def go(self, world, **kw):
        with tempfile.TemporaryDirectory() as d:
            drv = verify_driver(world, d)
            return drv.cmd_verify_image("55", "key", **kw)

    def test_order_create_rescue_mount_check_delete_then_label(self):
        w = VerifyWorld()
        self.go(w)
        self.assertEqual(w.events, ["create", "rescue", "poweron", "mount-ro", "check", "delete", "gone", "label"])
        self.assertTrue(w.server["start_after_create"] is False)
        self.assertEqual(w.server["type"], "small")  # cheapest type with a big enough disk
        self.assertTrue(w.server["name"].startswith("mv-verify-"))
        self.assertEqual(w.server["labels"]["purpose"], "image-verify")
        self.assertEqual(w.image_labels["murage/image-kind"], "customer")
        self.assertEqual(w.image_labels["murage/verified-by"], "hz-live-rescue")
        self.assertEqual(w.image_labels["murage/check-version"], "1")
        self.assertRegex(w.image_labels["murage/verified-at"], r"^\d{8}T\d{6}Z$")
        self.assertEqual(w.image_labels["murage/role"], "image")

    def test_fail_deletes_server_and_writes_no_label(self):
        w = VerifyWorld(check_rc=1)
        with self.assertRaises(hz.QualError) as cm:
            self.go(w)
        self.assertIn("openssh-server package is present", str(cm.exception))
        self.assertEqual(w.events, ["create", "rescue", "poweron", "mount-ro", "check", "delete", "gone"])
        self.assertEqual(w.image_labels["murage/image-kind"], "unverified")

    def test_delete_runs_on_every_failure_path(self):
        for at in ("rescue", "mount"):
            w = VerifyWorld(fail_at=at)
            with self.assertRaises(hz.QualError):
                self.go(w)
            self.assertEqual(w.events[-2:], ["delete", "gone"], at)
            self.assertNotIn("label", w.events)

    def test_pre_set_customer_label_without_verifier_labels_is_refused_before_any_server(self):
        w = VerifyWorld(labels={"murage/role": "image", "murage/image-kind": "customer", "murage/env": "prod"})
        with self.assertRaises(hz.QualError):
            self.go(w)
        self.assertEqual(w.events, [])

    def test_image_without_env_label_is_refused_before_any_server(self):
        for labels in ({"murage/role": "image", "murage/image-kind": "unverified"},
                       {"murage/role": "image", "murage/image-kind": "unverified", "murage/env": "newest"},
                       {"murage/role": "image", "murage/image-kind": "unverified", "murage/env": ""}):
            w = VerifyWorld(labels=labels)
            with self.assertRaises(hz.QualError) as cm:
                self.go(w)
            self.assertIn("murage/env", str(cm.exception))
            self.assertEqual(w.events, [])

    def test_env_label_survives_a_pass(self):
        w = VerifyWorld()
        self.go(w)
        self.assertEqual(w.image_labels["murage/env"], "prod")

    def test_image_build_requires_env_and_staging_ssh_is_staging_only(self):
        with tempfile.TemporaryDirectory() as d:
            drv = hz.Driver(hz.Client(TOKEN, Fake({}), sleep=lambda s: None), d, 250, out=lambda *a: None)
            for kw in ({}, {"env": "newest"}, {"env": "prod", "staging_ops_ssh": True}):
                with self.assertRaises(hz.QualError):
                    drv.cmd_image("a" * 40, d, "cpx32", "fsn1", "k", **kw)

    def test_verify_image_cli_has_no_default_target(self):
        with self.assertRaises(SystemExit):
            hz.main(["verify-image", "--ssh-key", "k"])

    def test_staging_image_that_somehow_passes_gets_no_customer_label(self):
        w = VerifyWorld(labels={"murage/role": "image", "murage/image-kind": "staging-ops-ssh", "murage/env": "prod"})
        with self.assertRaises(hz.QualError):
            self.go(w)
        self.assertNotIn("label", w.events)
        self.assertEqual(w.events[-2:], ["delete", "gone"])

    def test_still_present_after_delete_is_an_error(self):
        w = VerifyWorld(gone_after=10 ** 6)
        with self.assertRaises(hz.QualError) as cm:
            self.go(w)
        self.assertIn("STILL PRESENT", str(cm.exception))
        self.assertNotIn("label", w.events)

    def test_delete_guard_refuses_a_non_verifier_server(self):
        with tempfile.TemporaryDirectory() as d:
            drv = hz.Driver(hz.Client(TOKEN, Fake({}), sleep=lambda s: None), d, 250, out=lambda *a: None)
            with self.assertRaises(hz.QualError):
                drv.delete_verifier(1, {"id": 1, "name": "mcq-home", "labels": {"purpose": "image-verify"}})
            with self.assertRaises(hz.QualError):
                drv.delete_verifier(2, {"id": 1, "name": "mv-verify-1", "labels": {"purpose": "image-verify"}})


if __name__ == "__main__":
    unittest.main()
