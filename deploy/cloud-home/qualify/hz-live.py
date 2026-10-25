#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""REAL build host Cloud qualification driver for Murage Cloud B1 (stdlib only).

Safety model: every resource it creates is named mcq-* and labelled mcq=1;
every delete path refuses anything lacking BOTH. The API token is read once,
held in memory only, never logged, never passed to children, never put in
exception text. A spend ledger caps projected cost before any create.

Staging image build (`image`), the Lane G three-step order (LANE-G r3 sec. 2, build runbook r7). build-image.sh has no one-pass mode, so
the driver runs, in this order, and stops at the first failure:
  1. on the builder: MURAGE_IMAGE_STAGE=tree build-image.sh (the tree, unsealed, plus the stage 1 marker);
  2. on the builder: cloud-home-release.sh prepare ARCH REV ... SEQUENCE OUT (copy of the tree; unsigned manifest.json);
  3. manifest.json is copied back to THIS machine;
  4. HERE: scripts/cloud-home-sign.sh signs it. The release private key never leaves this machine: it is only read by that local
     script (path in its environment), never copied, never an argument of any ssh/rsync command, never logged;
  5. the .sig and the PUBLIC half of the key (derived locally) are copied to the builder;
  6. on the builder: cloud-home-release.sh finalize ARCH REV OUT PUBLIC_KEY;
  7. on the builder: MURAGE_IMAGE_STAGE=seal build-image.sh with the channel URL, public key, manifest and signature;
  8. only then the unchanged snapshot logic (shutdown, create_image, delete the builder).
Required `image` options (no defaults; a missing or bad one fails before any server is created):
  --release-signing-key PATH   Ed25519 private key (PEM) on this machine, e.g. the STAGING release key
  --release-channel URL        https URL of the signed release channel baked into the image (MURAGE_RELEASE_CHANNEL_URL)
  --release-sequence N         positive integer release sequence for this build
  --openssl PATH               optional; OpenSSL 3 binary used for the local signing. Default on macOS: /opt/homebrew/bin/openssl.
                               LibreSSL (macOS /usr/bin/openssl) is refused; elsewhere `openssl` on PATH must be OpenSSL 3+.
The architecture is derived from the builder (--lane arm = aarch64 on a cax* type, any other lane = x86_64 on a non-cax type; the builder needs 8 GB: cx33 or cax21 at minimum, default cx33), is
cross-checked against the builder's `uname -m`, and is passed explicitly to prepare, sign and finalize.
"""
import argparse
import datetime as dt
import decimal
import ipaddress
import json
import math
import os
import pathlib
import re
import shlex
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://api.hetzner.cloud/v1"
PREFIX = "mcq-"
LABELS = {"mcq": "1"}
VERIFY_PREFIX = "mv-verify-"
VERIFY_LABELS = {"purpose": "image-verify"}
CHECK_VERSION = "1"
VERIFIER = "hz-live-rescue"
IMAGE_ENVS = ("staging", "prod")
HOURS_PER_MONTH = decimal.Decimal(730)
D = decimal.Decimal


def ssh_jump():
    """Optional jump host for networks that block outbound ssh: MCQ_SSH_JUMP
    names an entry in the operator's own ssh config (letters, digits, . _ -)."""
    jump = os.environ.get("MCQ_SSH_JUMP", "")
    if not jump:
        return []
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", jump):
        raise QualError("MCQ_SSH_JUMP must be a plain ssh config host name")
    return ["-o", "ProxyJump=" + jump]


class QualError(Exception):
    """Short, token-free error."""


def urllib_transport(method, url, headers, body):
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()
    except (urllib.error.URLError, OSError, TimeoutError) as exc:
        raise QualError("network error: " + type(exc).__name__) from None


def public_control_jwk(file):
    """The control plane's public ES256 JWK, re-serialized from its public
    fields only. Refuses private material locally, before any upload."""
    try:
        jwk = json.loads(pathlib.Path(file).read_text())
    except (OSError, ValueError):
        raise QualError("--control-public-key must be a readable JSON JWK") from None
    if not isinstance(jwk, dict) or set(jwk) & {"d", "p", "q", "dp", "dq", "qi", "oth", "k"}:
        raise QualError("--control-public-key contains private key material; refusing")
    if jwk.get("kty") != "EC" or jwk.get("crv") != "P-256" or not all(isinstance(jwk.get(f), str) and jwk[f] for f in ("x", "y")):
        raise QualError("--control-public-key must be a P-256 EC public JWK")
    return json.dumps({f: jwk[f] for f in ("kty", "crv", "x", "y", "kid", "alg", "use") if f in jwk}, sort_keys=True)


ARM_LANES = ("arm", "arm64", "aarch64")
RELEASE_SEQUENCE = re.compile(r"[1-9][0-9]{0,8}")
CHANNEL_URL = re.compile(r"https://[A-Za-z0-9.-]+(/[A-Za-z0-9._/-]*)?")
# The staging driver must never sign with the production release key (public values only; the private key is never read here).
PROD_KEY_DIR = "~/.config/murage-prod"
PROD_RELEASE_PUBLIC_B64 = "MCowBQYDK2VwAyEAAu65BN00px2IYJzVXjLOjdyXh2mjRAm1zckEO09fmDc="
PROD_RELEASE_CHANNEL = "https://releases.murage.ai/cloud-home"
REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]


# Builder server types the image build accepts: 8 GB or more (cx33 and cax21 are the minimum; cx23 and cax11 have 4 GB and tsc is
# OOM-killed, measured 2026-10-25).
BUILDER_TYPES = ("cx33", "cx43", "cx53", "cpx32", "cpx42", "cpx52", "cax21", "cax31", "cax41")


def builder_arch(lane, typ):
    """x86_64 or aarch64 for the builder, from its lane and cross-checked against its server type (build host CAX is arm64). A builder with
    under 8 GB is refused before any server is created."""
    if str(typ).lower() not in BUILDER_TYPES:
        raise QualError("--type %s cannot build the image (needs 8 GB RAM): use cx33 (x86_64) or cax21 (arm64), or larger (%s)" % (typ, ", ".join(BUILDER_TYPES)))
    arch = "aarch64" if lane in ARM_LANES else "x86_64"
    if str(typ).lower().startswith("cax") != (arch == "aarch64"):
        raise QualError("--lane %s is %s but --type %s is not: an arm64 image needs --lane arm on a cax* type, an x86_64 image a non-cax type" % (lane, arch, typ))
    return arch


def resolve_openssl(explicit=None, run=subprocess.run, platform=sys.platform):
    """An OpenSSL 3 binary for local Ed25519 signing. LibreSSL (macOS /usr/bin/openssl) cannot sign raw Ed25519 and is refused."""
    if explicit:
        path = explicit
    elif platform == "darwin":
        path = "/opt/homebrew/bin/openssl"
        if not os.path.exists(path):
            raise QualError("OpenSSL 3 not found at /opt/homebrew/bin/openssl (brew install openssl@3) and no --openssl given; macOS /usr/bin/openssl is LibreSSL and cannot sign")
    else:
        path = shutil.which("openssl")
        if not path:
            raise QualError("openssl not found on PATH; install OpenSSL 3 or pass --openssl")
    try:
        text = run([path, "version"], capture_output=True, text=True).stdout.strip()
    except OSError:
        raise QualError("cannot run %s --version" % path) from None
    if not re.match(r"OpenSSL [3-9]\.", text):
        raise QualError("%s is %r; local signing needs OpenSSL 3 or newer (LibreSSL is refused)" % (path, text[:40] or "unknown"))
    return path


class Client:
    def __init__(self, token, transport=urllib_transport, sleep=time.sleep, clock=time.monotonic):
        self._token = token
        self._transport = transport
        self.sleep = sleep
        self.clock = clock

    def _scrub(self, text):
        return text.replace(self._token, "***") if self._token else text

    def request(self, method, path, body=None):
        headers = {"Authorization": "Bearer " + self._token, "Content-Type": "application/json", "User-Agent": "murage-hz-live/1"}
        data = None if body is None else json.dumps(body).encode()
        url = path if path.startswith("http") else BASE + path
        try:
            status, raw = self._transport(method, url, headers, data)
        except QualError:
            raise
        except Exception as exc:
            raise QualError("transport error: " + type(exc).__name__) from None
        try:
            payload = json.loads(raw) if raw else {}
        except ValueError:
            payload = {}
        if status >= 400:
            err = payload.get("error", {}) if isinstance(payload, dict) else {}
            code = str(err.get("code", "")) if isinstance(err, dict) else ""
            msg = str(err.get("message", "")) if isinstance(err, dict) else ""
            raise QualError(self._scrub("%s %s -> HTTP %d %s %s" % (method, path.split("?")[0], status, code, msg)).strip())
        return payload

    def list_all(self, path, key):
        out, page = [], 1
        sep = "&" if "?" in path else "?"
        while True:
            data = self.request("GET", "%s%sper_page=50&page=%d" % (path, sep, page))
            out.extend(data.get(key, []))
            nxt = (data.get("meta") or {}).get("pagination", {}).get("next_page")
            if not nxt:
                return out
            page = nxt

    def wait_action(self, action, timeout=600, interval=3):
        if not isinstance(action, dict) or "id" not in action:
            raise QualError("missing action in response")
        deadline = self.clock() + timeout
        while True:
            if action.get("status") == "success":
                return action
            if action.get("status") == "error":
                err = action.get("error") or {}
                raise QualError("action %s failed: %s" % (action.get("command", "?"), err.get("code", "unknown")))
            if self.clock() >= deadline:
                raise QualError("action %s deadline exceeded" % action.get("command", "?"))
            self.sleep(interval)
            action = self.request("GET", "/actions/%s" % action["id"]).get("action", {})
            if "id" not in action:
                raise QualError("bad action poll response")

    def wait_running(self, server_id, timeout=300, sleep=time.sleep):
        # Create returns before the start action settles; status passes
        # through initializing/starting first.
        deadline = time.monotonic() + timeout
        while True:
            server = self.request("GET", "/servers/%s" % server_id)["server"]
            if server.get("status") == "running" or time.monotonic() >= deadline:
                return server
            sleep(5)

    def wait_actions(self, data):
        acts = list(data.get("actions", [])) + list(data.get("next_actions", []))
        if data.get("action"):
            acts.append(data["action"])
        for a in acts:
            self.wait_action(a)


def owned(name, labels):
    return isinstance(name, str) and name.startswith(PREFIX) and isinstance((labels or {}), dict) and (labels or {}).get("mcq") == "1"


def guard(kind, name, labels):
    if not owned(name, labels):
        raise QualError("NAME GUARD: refusing to touch %s %r (needs mcq- name and label mcq=1)" % (kind, name))


def utcnow():
    return dt.datetime.now(dt.timezone.utc)


class Ledger:
    def __init__(self, path, now=utcnow):
        self.path = pathlib.Path(path)
        self.now = now

    def append(self, rec):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec, sort_keys=True) + "\n")

    def records(self):
        if not self.path.exists():
            return []
        return [json.loads(l) for l in self.path.read_text().splitlines() if l.strip()]

    def create(self, kind, rid, name, typ, location, hourly, currency):
        self.append({"event": "create", "key": "%s:%s" % (kind, rid), "resource": kind, "id": rid, "name": name, "type": typ,
                     "location": location, "hourly_gross": str(hourly), "currency": currency, "created_at": self.now().isoformat()})

    def delete(self, *keys):
        for k in keys:
            self.append({"event": "delete", "key": k, "deleted_at": self.now().isoformat()})

    def accrued(self):
        creates, deletes, cur = {}, {}, None
        for r in self.records():
            if r["event"] == "create":
                creates[r["key"]] = r
                cur = r["currency"]
            elif r["event"] == "delete":
                deletes.setdefault(r["key"], r["deleted_at"])
        now, total = self.now(), D(0)
        for key, r in creates.items():
            start = dt.datetime.fromisoformat(r["created_at"])
            end = dt.datetime.fromisoformat(deletes[key]) if key in deletes else now
            hours = max(1, math.ceil((end - start).total_seconds() / 3600))
            total += D(r["hourly_gross"]) * hours
        return total, cur


def cp_origin(value, flag):
    u = urllib.parse.urlsplit(value)
    if u.scheme != "https" or not u.hostname or u.username or u.password or u.query or u.fragment or u.path not in ("", "/"):
        raise QualError("%s must be a bare https origin" % flag)
    return "https://" + u.netloc


def read_token(path):
    p = pathlib.Path(os.path.expanduser(path))
    try:
        tok = p.read_text().strip()
    except OSError:
        raise QualError("cannot read token file") from None
    if not tok:
        raise QualError("token file is empty")
    return tok


class Driver:
    def __init__(self, client, evidence, cap, now=utcnow, out=print):
        self.c = client
        self.evidence = pathlib.Path(evidence)
        self.cap = D(str(cap))
        self.ledger = Ledger(self.evidence / "spend.jsonl", now)
        self.out = out
        self._pricing = None

    # ---- pricing / cap
    def pricing(self):
        if self._pricing is None:
            self._pricing = self.c.request("GET", "/pricing").get("pricing", {})
        return self._pricing

    def currency(self):
        return self.pricing().get("currency", "?")

    def server_hourly(self, typ, location):
        types = self.c.request("GET", "/server_types?name=" + typ).get("server_types", [])
        if not types:
            raise QualError("unknown server type " + typ)
        for p in types[0].get("prices", []):
            if p.get("location") == location:
                return D(p["price_hourly"]["gross"])
        raise QualError("no price for %s in %s" % (typ, location))

    def volume_hourly(self, gb):
        return D(self.pricing()["volume"]["price_per_gb_month"]["gross"]) * gb / HOURS_PER_MONTH

    def ipv4_hourly(self, location):
        for ip in self.pricing().get("primary_ips", []):
            if ip.get("type") == "ipv4":
                for p in ip.get("prices", []):
                    if p.get("location") == location:
                        return D(p["price_hourly"]["gross"])
        return D(0)

    def snapshot_hourly(self, gb):
        return D(self.pricing()["image"]["price_per_gb_month"]["gross"]) * D(str(gb)) / HOURS_PER_MONTH

    def check_cap(self, projected_hourly, hours=24):
        accrued, _ = self.ledger.accrued()
        total = accrued + projected_hourly * hours
        if total > self.cap:
            raise QualError("SPEND CAP: accrued %.4f + projected %.4f > cap %s %s; refusing" % (accrued, projected_hourly * hours, self.cap, self.currency()))

    # ---- list
    def inventory(self):
        c = self.c
        sel = "&label_selector=mcq%3D1"
        servers = [s for s in c.list_all("/servers?x=1" + sel, "servers") if s["name"].startswith(PREFIX)]
        allservers = c.list_all("/servers?x=1", "servers")
        vols = [v for v in c.list_all("/volumes?x=1" + sel, "volumes") if v["name"].startswith(PREFIX)]
        snaps = [i for i in c.list_all("/images?type=snapshot" + sel, "images") if str(i.get("description", "")).startswith(PREFIX)]
        fws = [f for f in c.list_all("/firewalls?x=1" + sel, "firewalls") if f["name"].startswith(PREFIX)]
        ips = [p for p in c.list_all("/primary_ips?x=1", "primary_ips") if str(p.get("name", "")).startswith(PREFIX) and (p.get("labels") or {}).get("mcq") == "1"]
        return servers, vols, snaps, fws, ips, len(allservers) - len(servers)

    def cmd_list(self):
        servers, vols, snaps, fws, ips, other = self.inventory()
        for s in servers:
            self.out("server   %s %s %s %s" % (s["id"], s["name"], s.get("status"), (s.get("public_net", {}).get("ipv4") or {}).get("ip")))
        for v in vols:
            self.out("volume   %s %s %sGB server=%s" % (v["id"], v["name"], v.get("size"), v.get("server")))
        for i in snaps:
            self.out("snapshot %s %s" % (i["id"], i.get("description")))
        for f in fws:
            self.out("firewall %s %s" % (f["id"], f["name"]))
        for p in ips:
            self.out("pip      %s %s %s" % (p["id"], p["name"], p.get("ip")))
        self.out("non-mcq servers: %d" % other)
        self.out("mcq counts: servers=%d volumes=%d snapshots=%d firewalls=%d primary_ips=%d" % (len(servers), len(vols), len(snaps), len(fws), len(ips)))
        return servers, vols, snaps, fws, ips

    def cmd_spend(self):
        total, cur = self.ledger.accrued()
        self.out("accrued spend (gross, hours rounded up): %.4f %s" % (total, cur or self.currency()))
        return total

    # ---- deletes (all guarded)
    def delete_server(self, s):
        guard("server", s.get("name"), s.get("labels"))
        data = self.c.request("DELETE", "/servers/%s" % s["id"])
        self.c.wait_actions(data)
        self.ledger.delete("server:%s" % s["id"], "ipv4:%s" % s["id"])

    def delete_volume(self, v):
        guard("volume", v.get("name"), v.get("labels"))
        for attempt in range(10):
            try:
                self.c.request("DELETE", "/volumes/%s" % v["id"])
                break
            except QualError as exc:
                if attempt == 9 or "HTTP 4" not in str(exc) or "HTTP 404" in str(exc):
                    raise
                self.c.sleep(5)
        self.ledger.delete("volume:%s" % v["id"])

    def delete_firewall(self, f):
        guard("firewall", f.get("name"), f.get("labels"))
        for attempt in range(10):
            try:
                self.c.request("DELETE", "/firewalls/%s" % f["id"])
                return
            except QualError as exc:
                if attempt == 9:
                    raise
                self.c.sleep(5)

    def delete_snapshot(self, i):
        guard("snapshot", i.get("description"), i.get("labels"))
        self.c.request("DELETE", "/images/%s" % i["id"])
        self.ledger.delete("snapshot:%s" % i["id"])

    def cmd_destroy(self, snapshots=False, name=None, snapshot_id=None):
        servers, vols, snaps, fws, ips, _ = self.inventory()
        if snapshot_id:
            # One superseded image only; inventory() lists mcq-labelled snapshots alone.
            match = [i for i in snaps if str(i["id"]) == str(snapshot_id)]
            if not match:
                raise QualError("no mcq snapshot with id %s" % snapshot_id)
            self.delete_snapshot(match[0])
            self.out("destroy ok: snapshot %s" % snapshot_id)
            return
        if name:
            # One home only: its server and volume; firewalls, snapshots and
            # other mcq servers (e.g. a running image builder) are untouched.
            target = PREFIX + name
            for s in [x for x in servers if x["name"] == target]:
                self.delete_server(s)
            for v in [x for x in vols if x["name"] == target + "-vol"]:
                self.delete_volume(v)
            if any(x["name"] == target for x in self.inventory()[0]):
                raise QualError("assertion failed: %s remains" % target)
            self.out("destroy ok: %s" % target)
            return
        for s in servers:
            self.delete_server(s)
        for v in vols:
            self.delete_volume(v)
        for f in fws:
            self.delete_firewall(f)
        if snapshots:
            for i in snaps:
                self.delete_snapshot(i)
        servers, *_ = self.cmd_list()
        if servers:
            raise QualError("assertion failed: mcq servers remain")
        self.out("destroy ok: zero mcq servers")

    # ---- create-home
    def cmd_create_home(self, suffix, typ, location, image, ssh_key, volume_gb, user_data_file, managed_endpoint=False):
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,40}", suffix):
            raise QualError("bad --name suffix")
        name = PREFIX + suffix
        hourly = self.server_hourly(typ, location) + self.ipv4_hourly(location) + self.volume_hourly(volume_gb)
        self.check_cap(hourly)
        cur = self.currency()
        labels = dict(LABELS, **{"murage/role": "home"})
        vdata = self.c.request("POST", "/volumes", {"name": name + "-vol", "size": volume_gb, "location": location, "automount": False, "labels": labels})
        vol = vdata["volume"]
        guard("volume", vol.get("name"), vol.get("labels"))
        self.ledger.create("volume", vol["id"], vol["name"], "%sGB" % volume_gb, location, self.volume_hourly(volume_gb), cur)
        server = None
        try:
            self.c.wait_actions(vdata)
            # No enrollment user_data: enroll-home supplies it (and volume.json) over ssh
            # once the control-plane machine row exists. IPv4 only: one primary IP to bind.
            body = {"name": name, "server_type": typ, "location": location, "image": int(image) if str(image).isdigit() else image,
                    "ssh_keys": [ssh_key], "volumes": [vol["id"]], "automount": False, "labels": labels,
                    "public_net": {"enable_ipv4": True, "enable_ipv6": False}, "start_after_create": True}
            if user_data_file:
                body["user_data"] = pathlib.Path(user_data_file).read_text()
            sdata = self.c.request("POST", "/servers", body)
            server = sdata["server"]
            guard("server", server.get("name"), server.get("labels"))
            self.ledger.create("server", server["id"], server["name"], typ, location, self.server_hourly(typ, location), cur)
            self.ledger.create("ipv4", server["id"], server["name"], "primary_ipv4", location, self.ipv4_hourly(location), cur)
            self.c.wait_actions(sdata)
            server = self.c.wait_running(server["id"])
            if server.get("status") != "running":
                raise QualError("server not running: %s" % server.get("status"))
        except Exception:
            if server is not None:
                try:
                    self.delete_server(server)
                except Exception:
                    pass
            try:
                self.delete_volume(vol)
            except Exception:
                pass
            raise
        if managed_endpoint:
            # The home is reached only through its Cloudflare Tunnel: nothing here
            # opens 80/443 (use `fw --managed-endpoint` for the shared firewall).
            self.out("managed-endpoint: no public ports; the home dials out through its tunnel")
        # Keep this the LAST line: callers parse the id and address from it.
        self.out("server id=%s name=%s ipv4=%s volume=%s" % (server["id"], server["name"], (server.get("public_net", {}).get("ipv4") or {}).get("ip"), vol["id"]))

    # ---- firewall
    @staticmethod
    def ssh_nets(ssh_from):
        """One or more --ssh-from sources (an operator IP that may change, plus a
        fixed jump host). None of them may be world-open."""
        nets = [ipaddress.ip_network(x, strict=False) for x in ([ssh_from] if isinstance(ssh_from, str) else (ssh_from or []))]
        if any(net.prefixlen == 0 for net in nets):
            raise QualError("--ssh-from must not be world-open")
        return nets

    def cmd_fw(self, ssh_from, managed_endpoint=False):
        nets = self.ssh_nets(ssh_from)
        if not nets:
            raise QualError("--ssh-from is required")
        # A managed-endpoint home is reached through its outbound Cloudflare Tunnel:
        # no world-open 80/443 rule (ssh from the operator sources only).
        rules = [] if managed_endpoint else [{"direction": "in", "protocol": "tcp", "port": p, "source_ips": ["0.0.0.0/0", "::/0"]} for p in ("80", "443")]
        rules.append({"direction": "in", "protocol": "tcp", "port": "22", "source_ips": [str(net) for net in nets]})
        selector = {"type": "label_selector", "label_selector": {"selector": "mcq=1"}}
        existing = [f for f in self.c.list_all("/firewalls?name=mcq-home", "firewalls") if f["name"] == "mcq-home"]
        if existing:
            fw = existing[0]
            guard("firewall", fw["name"], fw.get("labels"))
            self.c.wait_actions(self.c.request("POST", "/firewalls/%s/actions/set_rules" % fw["id"], {"rules": rules}))
            if not any(a.get("type") == "label_selector" and a.get("label_selector", {}).get("selector") == "mcq=1" for a in fw.get("applied_to", [])):
                self.c.wait_actions(self.c.request("POST", "/firewalls/%s/actions/apply_to_resources" % fw["id"], {"apply_to": [selector]}))
            self.out("firewall updated id=%s" % fw["id"])
        else:
            data = self.c.request("POST", "/firewalls", {"name": "mcq-home", "labels": dict(LABELS), "rules": rules, "apply_to": [selector]})
            self.c.wait_actions(data)
            self.out("firewall created id=%s" % data["firewall"]["id"])

    # ---- enroll-home
    def find_home(self, suffix):
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,40}", suffix):
            raise QualError("bad --name suffix")
        name = PREFIX + suffix
        found = [s for s in self.c.list_all("/servers?name=" + name, "servers") if s.get("name") == name]
        if len(found) != 1:
            raise QualError("expected exactly one server named %s, found %d" % (name, len(found)))
        server = found[0]
        guard("server", server.get("name"), server.get("labels"))
        ip = ((server.get("public_net") or {}).get("ipv4") or {}).get("ip")
        try:
            ipaddress.IPv4Address(ip)
        except ValueError:
            raise QualError("server has no IPv4") from None
        vols = server.get("volumes") or []
        if len(vols) != 1:
            raise QualError("server must have exactly one volume")
        vol = self.c.request("GET", "/volumes/%s" % vols[0])["volume"]
        guard("volume", vol.get("name"), vol.get("labels"))
        return name, server, ip, vol

    def cp_create(self, cp_url, admin_token, home_id, server_id, ip, public_origin, transport, managed_endpoint=False):
        admin = cp_origin(cp_url, "--cp-url")
        if managed_endpoint:
            # The control plane allocates the hostname and public origin.
            if public_origin:
                raise QualError("--public-origin and --managed-endpoint are exclusive")
            body = {"homeId": home_id, "managed_endpoint": True, "adminUrl": admin, "serverId": str(server_id), "boundIps": [ip]}
        else:
            if not public_origin:
                raise QualError("--public-origin is required without --managed-endpoint")
            origin = cp_origin(public_origin, "--public-origin")
            body = {"homeId": home_id, "publicOrigin": origin, "adminUrl": admin, "serverId": str(server_id), "boundIps": [ip]}
        headers = {"Authorization": "Bearer " + admin_token, "Content-Type": "application/json", "User-Agent": "murage-hz-live/1"}
        try:
            status, raw = transport("POST", admin + "/v1/machines", headers, json.dumps(body).encode())
        except Exception as exc:
            raise QualError("control-plane transport error: " + type(exc).__name__) from None
        if status != 201:
            raise QualError("control-plane create refused: HTTP %d" % status)
        try:
            payload = json.loads(raw)
            token = payload["enrollmentToken"]
            ok = payload["homeId"] == home_id and isinstance(token, str) and token
            if managed_endpoint:
                got = payload.get("public_origin", payload.get("publicOrigin"))
                origin = cp_origin(got, "control-plane public_origin") if isinstance(got, str) else None
                ok = ok and origin is not None
        except (ValueError, KeyError, TypeError, QualError):
            ok = False
        if not ok:
            raise QualError("control-plane create returned an invalid response")
        return admin, token, origin

    @staticmethod
    def redact(text, *secrets):
        for secret in secrets:
            if secret:
                text = text.replace(secret, "[redacted]")
        return re.sub(r"[A-Za-z0-9+/_=-]{32,}", "[redacted]", text)

    def cmd_retire_home(self, suffix, cp_url, cp_secrets, cp_transport=urllib_transport):
        """Tell the staging control plane the test home is gone so its tunnel and DNS record are swept."""
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,40}", suffix):
            raise QualError("bad --name suffix")
        try:
            admin_token = json.loads(pathlib.Path(os.path.expanduser(cp_secrets)).read_text()).get("CLOUD_ADMIN_TOKEN")
        except (OSError, ValueError, AttributeError):
            raise QualError("cannot read --cp-secrets") from None
        if not isinstance(admin_token, str) or not admin_token:
            raise QualError("CLOUD_ADMIN_TOKEN missing from --cp-secrets")
        home_id = PREFIX + suffix
        admin = cp_origin(cp_url, "--cp-url")
        headers = {"Authorization": "Bearer " + admin_token, "Content-Type": "application/json", "User-Agent": "murage-hz-live/1"}
        try:
            status, raw = cp_transport("POST", admin + "/v1/machines/%s/retire" % home_id, headers, b"{}")
        except Exception as exc:
            raise QualError("control-plane transport error: " + type(exc).__name__) from None
        if status == 404:
            self.out("retire   %s already gone from the control plane" % home_id)
            return
        if status != 200:
            raise QualError("control-plane retire refused: HTTP %d" % status)
        try:
            payload = json.loads(raw)
            ok = payload["machineId"] == home_id and isinstance(payload["state"], str)
        except (ValueError, KeyError, TypeError):
            ok = False
        if not ok:
            raise QualError("control-plane retire returned an invalid response")
        self.out("retire   %s state=%s; endpoint cleanup runs on the next sweep" % (home_id, payload["state"]))

    def cmd_enroll_home(self, suffix, cp_url, cp_secrets, public_origin=None, ssh_from=None, cp_transport=urllib_transport, managed_endpoint=False):
        nets = self.ssh_nets(ssh_from)
        try:
            admin_token = json.loads(pathlib.Path(os.path.expanduser(cp_secrets)).read_text()).get("CLOUD_ADMIN_TOKEN")
        except (OSError, ValueError, AttributeError):
            raise QualError("cannot read --cp-secrets") from None
        if not isinstance(admin_token, str) or not admin_token:
            raise QualError("CLOUD_ADMIN_TOKEN missing from --cp-secrets")
        name, server, ip, vol = self.find_home(suffix)
        home_id = name
        admin, token, origin = self.cp_create(cp_url, admin_token, home_id, server["id"], ip, public_origin, cp_transport, managed_endpoint)
        secrets = (token, admin_token, self.c._token)
        self.evidence.mkdir(parents=True, exist_ok=True)
        known = self.evidence / ("known_hosts-%s" % server["id"])
        ssh = ["ssh", "-o", "StrictHostKeyChecking=accept-new", "-o", "UserKnownHostsFile=" + str(known), "-o", "BatchMode=yes", "-o", "ConnectTimeout=10"] + ssh_jump() + ["root@" + ip]
        for _ in range(40):
            if self.run(ssh + ["true"], capture_output=True).returncode == 0:
                break
            self.c.sleep(15)
        else:
            raise QualError("home ssh never became ready")
        # murage-enroll reads its inputs from cloud-init's user-data file (root 0600).
        # The token travels on ssh stdin only.
        user_data = "#cloud-config\nmurage_home_id: %s\nmurage_enrollment_token: %s\nmurage_admin_url: %s\n" % (home_id, token, admin)
        put = 'd=/var/lib/cloud/instance; [ -d "$d" ] || mkdir -p -m 0755 "$d"; umask 077; cat > "$d/user-data.txt" && chmod 0600 "$d/user-data.txt"'
        if self.run(ssh + [put], input=user_data.encode(), capture_output=True).returncode:
            raise QualError("writing enrollment inputs failed")
        user_data = None
        meta = {"provider": "hetzner", "id": str(vol["id"]), "device": "/dev/disk/by-id/scsi-0HC_Volume_%s" % vol["id"], "new": True, "generation": 1, "homeId": home_id}
        parts = ["set -u", "umask 077", "install -d -m 0755 /etc/murage-home",
                 "printf '%%s\\n' %s > /etc/murage-home/volume.json" % shlex.quote(json.dumps(meta, separators=(",", ":"))), "chmod 0600 /etc/murage-home/volume.json"]
        if nets:
            posts = "".join("ExecStartPost=/usr/sbin/nft add element inet murage_home %s { %s }\\n" % ("qual_ssh" if net.version == 4 else "qual_ssh_v6", net) for net in nets)
            # nft loads only when murage-egress starts and its input chain drops new ssh. The
            # drop-in adds the operator source in the same unit start (no manual window); the
            # established session is accepted by ct state either way.
            parts += ["install -d -m 0755 /etc/systemd/system/murage-egress.service.d",
                      "printf '[Service]\\n%s' > /etc/systemd/system/murage-egress.service.d/qual-ssh.conf" % posts,
                      "systemctl daemon-reload"]
        units = ["murage-volume.service", "data.mount", "murage-egress.service", "murage-home.service", "murage-proxy.service"]
        parts.append("failed=''")
        parts.append("for u in %s; do systemctl start \"$u\" </dev/null || { failed=$u; echo \"START FAILED: $u\"; break; }; done" % " ".join(units))
        if managed_endpoint:
            # Fetches the connector token (retrying while the endpoint provisions) and
            # starts murage-tunnel.service; --no-block as the oneshot may wait minutes.
            parts.append("systemctl start --no-block murage-tunnel-token.service </dev/null || true")
            units = units + ["murage-tunnel-token.service"]
        parts.append("for u in %s; do printf '%%s %%s\\n' \"$u\" \"$(systemctl is-active \"$u\")\"; done" % " ".join(units))
        for setname in sorted({"qual_ssh" if net.version == 4 else "qual_ssh_v6" for net in nets}):
            parts.append("nft list set inet murage_home %s 2>&1 | head -20 || true" % setname)
        parts.append("[ -z \"$failed\" ] || journalctl -u \"$failed\" -n 30 --no-pager 2>&1")
        parts.append("journalctl -u murage-home.service -n 30 --no-pager 2>&1")
        parts.append("[ -z \"$failed\" ]")
        proc = self.run(ssh + ["; ".join(parts)], capture_output=True)
        text = (proc.stdout or b"").decode(errors="replace") + (proc.stderr or b"").decode(errors="replace")
        self.out(self.redact(text, *secrets).rstrip())
        self.ledger.append({"event": "enroll", "key": "enroll:%s" % server["id"], "home_id": home_id, "server_id": str(server["id"]),
                            "ip": ip, "ok": proc.returncode == 0, "at": self.ledger.now().isoformat()})
        if proc.returncode:
            raise QualError("enroll-home: a unit failed to start (CP token is spent; rotate before retrying)")
        self.out("enrolled home=%s server=%s ipv4=%s" % (home_id, server["id"], ip))
        if managed_endpoint:
            self.out("public_origin=%s (through the Cloudflare Tunnel; no 80/443 opened)" % origin)

    # ---- image
    def smallest_type(self, image, location):
        """The cheapest non-deprecated server type that matches the image's architecture and has a disk big enough for it."""
        need = float(image.get("disk_size") or 0)
        arch = image.get("architecture") or "x86"
        best = None
        for t in self.c.list_all("/server_types?x=1", "server_types"):
            if t.get("deprecated") or t.get("architecture", "x86") != arch or float(t.get("disk") or 0) < need:
                continue
            # A type is only orderable where this location lists it as available (a priced type can still be sold out or retired there).
            loc = next((l for l in t.get("locations", []) if l.get("name") == location), None)
            if t.get("locations") and (loc is None or not loc.get("available") or loc.get("deprecation")):
                continue
            price = next((D(p["price_hourly"]["gross"]) for p in t.get("prices", []) if p.get("location") == location), None)
            if price is not None and (best is None or price < best[0]):
                best = (price, t["name"])
        if best is None:
            raise QualError("verify-image: no server type fits image disk %sGB in %s" % (need, location))
        return best[1]

    def delete_verifier(self, server_id, created):
        """Delete the verifier server by its EXACT id, then confirm it is gone. Refuses anything that is not a verifier."""
        if str(created.get("id")) != str(server_id) or not str(created.get("name", "")).startswith(VERIFY_PREFIX) \
                or (created.get("labels") or {}).get("purpose") != VERIFY_LABELS["purpose"]:
            raise QualError("NAME GUARD: refusing to delete %r (not a verify-image server)" % created.get("name"))
        try:
            self.c.wait_actions(self.c.request("DELETE", "/servers/%s" % server_id))
        except QualError as exc:
            if "HTTP 404" not in str(exc):
                raise
        for _ in range(24):
            try:
                self.c.request("GET", "/servers/%s" % server_id)
            except QualError as exc:
                if "HTTP 404" in str(exc):
                    self.ledger.delete("server:%s" % server_id, "ipv4:%s" % server_id)
                    return
                raise
            self.c.sleep(5)
        raise QualError("verify-image: server %s is STILL PRESENT after delete; remove it by id" % server_id)

    def cmd_verify_image(self, image_id, ssh_key, typ=None, location="fsn1"):
        """Release gate on the EXACT published snapshot id. A throwaway server is created from the snapshot and booted into
        build host RESCUE (the image's own sshd is never needed); the root disk is mounted READ-ONLY and image-release-check.sh
        runs on the mounted tree; the server is deleted by exact id in a finally block. Only a PASS writes the snapshot labels
        murage/image-kind=customer, murage/verified-at, murage/check-version and murage/verified-by: the kind label is a RESULT
        of this check, never an input from the build step."""
        if not re.fullmatch(r"[0-9]{1,20}", str(image_id)):
            raise QualError("--image-id must be a numeric snapshot id")
        image = self.c.request("GET", "/images/%s" % image_id)["image"]
        labels = dict(image.get("labels") or {})
        desc = str(image.get("description") or "")
        if str(image.get("id")) != str(image_id) or image.get("type") != "snapshot":
            raise QualError("verify-image: %s is not a snapshot" % image_id)
        if not desc.startswith("mcq-home-") or labels.get("murage/role") != "image":
            raise QualError("verify-image: %s is not a Murage home image" % image_id)
        if labels.get("murage/env") not in IMAGE_ENVS:
            raise QualError("verify-image: %s has no murage/env label (staging or prod); refusing to verify an image that does not name its environment" % image_id)
        if labels.get("murage/image-kind") == "customer" and (labels.get("murage/verified-by") != VERIFIER or not labels.get("murage/verified-at")):
            raise QualError("verify-image: %s carries kind=customer without the verifier's labels; a build cannot set it. Refusing" % image_id)
        typ = typ or self.smallest_type(image, location)
        hourly = self.server_hourly(typ, location) + self.ipv4_hourly(location)
        self.check_cap(hourly)
        cur = self.currency()
        script = pathlib.Path(__file__).resolve().parent.parent.joinpath("image-release-check.sh").read_bytes()
        self.evidence.mkdir(parents=True, exist_ok=True)
        name = VERIFY_PREFIX + str(image_id)[-12:]
        created, passed, verdict = None, False, []
        try:
            sdata = self.c.request("POST", "/servers", {"name": name, "server_type": typ, "location": location, "image": int(image_id), "ssh_keys": [ssh_key],
                                                        "labels": dict(VERIFY_LABELS, **{"murage/verify-image": str(image_id)}), "start_after_create": False,
                                                        "public_net": {"enable_ipv4": True, "enable_ipv6": False}})
            created = sdata["server"]
            self.ledger.create("server", created["id"], created["name"], typ, location, self.server_hourly(typ, location), cur)
            self.ledger.create("ipv4", created["id"], created["name"], "primary_ipv4", location, self.ipv4_hourly(location), cur)
            sid = created["id"]
            self.c.wait_actions(sdata)
            rescue = self.c.request("POST", "/servers/%s/actions/enable_rescue" % sid, {"type": "linux64", "ssh_keys": [ssh_key]})
            self.c.wait_action(rescue.get("action"))
            self.c.wait_action(self.c.request("POST", "/servers/%s/actions/poweron" % sid).get("action"))
            deadline = self.c.clock() + 300
            while True:
                server = self.c.request("GET", "/servers/%s" % sid)["server"]
                if server.get("status") == "running":
                    break
                if self.c.clock() >= deadline:
                    raise QualError("verify-image: server did not reach running")
                self.c.sleep(5)
            ip = server["public_net"]["ipv4"]["ip"]
            known = self.evidence / ("known_hosts-%s" % sid)
            ssh = ["ssh", "-o", "StrictHostKeyChecking=accept-new", "-o", "UserKnownHostsFile=" + str(known), "-o", "BatchMode=yes", "-o", "ConnectTimeout=10"] + ssh_jump() + ["root@" + ip]
            for _ in range(40):
                if self.run(ssh + ["true"], capture_output=True).returncode == 0:
                    break
                self.c.sleep(15)
            else:
                raise QualError("verify-image: rescue ssh never became ready")
            mount = ("set -e; mkdir -p /mnt/img; dev=/dev/disk/by-label/cloudimg-rootfs; [ -e $dev ] || dev=/dev/sda1; "
                     "mount -o ro,noload $dev /mnt/img; awk '$2==\"/mnt/img\"{print $4}' /proc/mounts | grep '^ro' >/dev/null; "
                     "[ -r /mnt/img/var/lib/dpkg/status ]")
            res = self.run(ssh + [mount], capture_output=True)
            if res.returncode:
                raise QualError("verify-image: could not mount the image root disk read-only")
            res = self.run(ssh + ["bash -s -- /mnt/img %s" % image_id], input=script, capture_output=True)
            verdict = ((res.stdout or b"") + (res.stderr or b"")).decode(errors="replace").strip().splitlines()
            (self.evidence / ("verify-%s.log" % image_id)).write_text("\n".join(verdict) + "\n")
            for line in verdict:
                self.out(line)
            passed = res.returncode == 0
        finally:
            if created is not None:
                self.delete_verifier(created["id"], created)
        if not passed:
            raise QualError("verify-image: FAILED release check for %s (no label written): %s" % (image_id, "; ".join(l for l in verdict if "FAIL" in l) or "see log"))
        if labels.get("murage/image-kind") == "staging-ops-ssh" or desc.endswith("-stagingssh"):
            raise QualError("verify-image: %s is a staging image; no customer label written" % image_id)
        labels.update({"murage/image-kind": "customer", "murage/verified-at": self.ledger.now().strftime("%Y%m%dT%H%M%SZ"),
                       "murage/check-version": CHECK_VERSION, "murage/verified-by": VERIFIER})
        self.c.request("PUT", "/images/%s" % image_id, {"labels": labels})
        self.out("verify-image ok id=%s kind=customer description=%s" % (image_id, desc))

    def run(self, argv, env_extra=None, **kw):
        env = {k: v for k, v in os.environ.items() if "TOKEN" not in k.upper() and "HCLOUD" not in k.upper()}
        env.update(env_extra or {})
        return subprocess.run(argv, env=env, **kw)

    def _stage(self, ssh, log_name, command, what):
        with open(self.evidence / log_name, "wb") as log:
            rc = self.run(ssh + [command], stdout=log, stderr=subprocess.STDOUT).returncode
        if rc:
            raise QualError("%s failed rc=%d (see %s)" % (what, rc, log_name))

    def cmd_image(self, revision, source, typ, location, ssh_key, control_public_key=None, lane=None, staging_ops_ssh=False, env=None,
                  release_key=None, release_channel=None, release_sequence=None, openssl=None):
        if env not in IMAGE_ENVS:
            raise QualError("--env staging|prod is required: the image label murage/env names the environment it is built for")
        if staging_ops_ssh and env != "staging":
            raise QualError("--staging-ops-ssh images are staging only (--env staging)")
        if not re.fullmatch(r"[0-9a-f]{40}", revision):
            raise QualError("--revision must be 40 hex")
        # Everything the signed build needs is checked here, before any API call, so a bad input never costs a server.
        if not release_key:
            raise QualError("--release-signing-key is required (path of the Ed25519 release private key on this machine); there is no default")
        if not release_channel:
            raise QualError("--release-channel is required (https URL of the signed release channel); there is no default")
        if not release_sequence or not RELEASE_SEQUENCE.fullmatch(str(release_sequence)):
            raise QualError("--release-sequence is required and must be a positive integer")
        if not CHANNEL_URL.fullmatch(release_channel):
            raise QualError("--release-channel must be an https URL (letters, digits, . - and a plain path)")
        release_sequence = str(release_sequence)
        if release_channel.rstrip("/").lower() == PROD_RELEASE_CHANNEL:
            raise QualError("--release-channel is the production channel; this staging driver refuses it")
        key_path = pathlib.Path(os.path.realpath(os.path.expanduser(release_key)))
        prod_dir = os.path.realpath(os.path.expanduser(PROD_KEY_DIR))
        if key_path == pathlib.Path(prod_dir) or pathlib.Path(prod_dir) in key_path.parents:
            raise QualError("--release-signing-key resolves under %s (the production keys); this staging driver refuses it" % PROD_KEY_DIR)
        if not key_path.is_file():
            raise QualError("--release-signing-key is not a readable file")
        sign_script = REPO_ROOT / "scripts" / "cloud-home-sign.sh"
        if not sign_script.is_file():
            raise QualError("scripts/cloud-home-sign.sh not found next to this driver")
        arch = builder_arch(lane, typ)
        openssl_bin = resolve_openssl(openssl)
        src = pathlib.Path(source)
        head = subprocess.run(["git", "-C", str(src), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
        dirty = subprocess.run(["git", "-C", str(src), "status", "--porcelain"], capture_output=True, text=True).stdout.strip()
        if head != revision or dirty:
            raise QualError("source checkout must be clean and at --revision")
        public_jwk = public_control_jwk(control_public_key) if control_public_key else None
        short = revision[:12]
        # --lane NAME (e.g. arm): builder mcq-NAME-build labelled lane=NAME, snapshot mcq-home-<sha>-NAME,
        # so an arm64 image never shares a description with the x86 image of the same revision.
        if lane is not None and not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,20}", lane):
            raise QualError("bad --lane")
        name = ("mcq-%s-build" % lane) if lane else "mcq-builder-" + short
        snap_desc = "mcq-home-" + short + (("-" + lane) if lane else "") + ("-stagingssh" if staging_ops_ssh else "")
        # a staging image keeps sshd and says so in a label. A customer build is labelled "unverified": only verify-image
        # (rescue-mode check of the exact snapshot) may write "customer".
        image_kind = "staging-ops-ssh" if staging_ops_ssh else "unverified"
        self.evidence.mkdir(parents=True, exist_ok=True)
        release_dir = (self.evidence / ("release-%s-%s" % (short, arch))).resolve()
        release_dir.mkdir(parents=True, exist_ok=True)
        os.chmod(release_dir, 0o700)
        public_pem = release_dir / "release-public.pem"
        derived = self.run([openssl_bin, "pkey", "-in", str(key_path), "-pubout", "-out", str(public_pem)], capture_output=True)
        if derived.returncode:
            raise QualError("cannot derive the public key from --release-signing-key (not a PEM private key?)")
        body = "".join(l for l in public_pem.read_text().splitlines() if not l.startswith("-----"))
        if body == PROD_RELEASE_PUBLIC_B64:
            public_pem.unlink(missing_ok=True)
            raise QualError("--release-signing-key is the production release key (its public half matches); this staging driver refuses it")
        shown = self.run([openssl_bin, "pkey", "-pubin", "-in", str(public_pem), "-noout", "-text"], capture_output=True)
        if shown.returncode or b"ED25519 Public-Key" not in shown.stdout:
            raise QualError("--release-signing-key must be an Ed25519 private key")
        hourly = self.server_hourly(typ, location) + self.ipv4_hourly(location)
        self.check_cap(hourly)
        cur = self.currency()
        known = self.evidence / "known_hosts"
        labels = dict(LABELS, **{"murage/role": "builder", "murage/build": revision})
        if lane:
            labels["lane"] = lane
        sdata = self.c.request("POST", "/servers", {"name": name, "server_type": typ, "location": location, "image": "ubuntu-24.04", "ssh_keys": [ssh_key],
                                                    "labels": labels, "start_after_create": True})
        builder = sdata["server"]
        guard("server", builder.get("name"), builder.get("labels"))
        self.ledger.create("server", builder["id"], builder["name"], typ, location, self.server_hourly(typ, location), cur)
        self.ledger.create("ipv4", builder["id"], builder["name"], "primary_ipv4", location, self.ipv4_hourly(location), cur)
        try:
            self.c.wait_actions(sdata)
            builder = self.c.wait_running(builder["id"])
            if builder.get("status") != "running":
                raise QualError("builder not running: %s" % builder.get("status"))
            ip = builder["public_net"]["ipv4"]["ip"]
            # build host reuses IPs; a fresh known_hosts per server keeps
            # accept-new from refusing a recycled address's new host key.
            known = self.evidence / ("known_hosts-%s" % builder["id"])
            ssh = ["ssh", "-o", "StrictHostKeyChecking=accept-new", "-o", "UserKnownHostsFile=" + str(known), "-o", "BatchMode=yes", "-o", "ConnectTimeout=10"] + ssh_jump() + ["root@" + ip]
            for _ in range(40):
                if self.run(ssh + ["true"], capture_output=True).returncode == 0:
                    break
                self.c.sleep(15)
            else:
                raise QualError("builder ssh never became ready")
            sshcmd = "ssh -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=%s -o BatchMode=yes" % known
            sshcmd += "".join(" " + part for part in ssh_jump())
            if self.run(ssh + ["mkdir -p /build/murage"], capture_output=True).returncode:
                raise QualError("remote mkdir failed")
            # Only tracked files (plus .git, which build-image.sh archives from)
            # reach the builder: ignored local files such as .env never leave.
            tracked = subprocess.run(["git", "-C", str(src), "ls-files", "-z"], capture_output=True).stdout
            if not tracked or self.run(["rsync", "-a", "--no-owner", "--no-group", "--from0", "--files-from=-", "-e", sshcmd, str(src) + "/", "root@%s:/build/murage/" % ip], input=tracked, capture_output=True).returncode:
                raise QualError("rsync of checkout failed")
            if self.run(["rsync", "-a", "--no-owner", "--no-group", "-e", sshcmd, str(src) + "/.git/", "root@%s:/build/murage/.git/" % ip], capture_output=True).returncode:
                raise QualError("rsync of checkout failed")
            trust = ""
            if control_public_key:
                # Only the validated public fields leave this machine; the
                # supplied file itself is never copied.
                if self.run(ssh + ["umask 077 && cat > /build/control-public-key.json"], input=public_jwk.encode(), capture_output=True).returncode:
                    raise QualError("copy of control public key failed")
                trust = " /build/control-public-key.json"
            # Images are built on the smallest type (its disk size sticks to
            # the snapshot); 4 GB is too little for the server bundle's heap,
            # so the builder gets temporary swap, removed before the snapshot.
            prep = ("chown -R root:root /build/murage && git config --global --add safe.directory /build/murage"
                    " && fallocate -l 4G /mcq-build.swap && chmod 600 /mcq-build.swap && mkswap -q /mcq-build.swap && swapon /mcq-build.swap")
            res = self.run(ssh + [prep], capture_output=True)
            (self.evidence / "prep.log").write_bytes(res.stdout + res.stderr)
            if res.returncode:
                raise QualError("remote prep failed: %s" % ((res.stdout + res.stderr).decode(errors="replace").strip().splitlines() or [""])[-1])
            if self.run(ssh + ["[ \"$(uname -m)\" = %s ]" % arch], capture_output=True).returncode:
                raise QualError("builder is not %s: lane/type and builder disagree" % arch)
            remote_build = ("STAGING_OPS_SSH=1 " if staging_ops_ssh else "") + "/build/murage/deploy/cloud-home/build-image.sh %s /build/murage%s" % (revision, trust)
            remote_release = "/build/murage/scripts/cloud-home-release.sh"
            out_dir, tree_copy, remote_pub = "/build/out", "/build/tree", "/build/release-public.pem"
            remote_manifest = "%s/%s/manifest.json" % (out_dir, arch)
            # 1. stage tree: builds the final slot A tree (pnpm runs here, once) and writes the stage 1 marker.
            self._stage(ssh, "build.log", "NODE_OPTIONS=--max-old-space-size=3072 MURAGE_IMAGE_STAGE=tree " + remote_build, "build-image.sh stage tree")
            # 2. prepare on a copy of the tree: archive plus unsigned manifest.json (no key on the builder).
            self._stage(ssh, "prepare.log", "install -d -m 0755 %s && cp -a /opt/murage-releases/A/. %s/ && %s prepare %s %s /build/murage %s %s %s"
                        % (tree_copy, tree_copy, remote_release, arch, revision, tree_copy, release_sequence, out_dir), "release prepare")
            # 3. manifest.json back to this machine.
            for stale in ("manifest.json", "manifest.json.sig"):
                (release_dir / stale).unlink(missing_ok=True)
            if self.run(["rsync", "-a", "--no-owner", "--no-group", "-e", sshcmd, "root@%s:%s" % (ip, remote_manifest), str(release_dir) + "/"], capture_output=True).returncode:
                raise QualError("copy of manifest.json back from the builder failed")
            # 4. sign LOCALLY. The key path is only in this local process's environment: never in argv, never sent to the builder.
            signed = self.run(["bash", str(REPO_ROOT / "scripts" / "cloud-home-sign.sh"), str(release_dir / "manifest.json"), revision, arch, release_sequence],
                              env_extra={"MURAGE_RELEASE_SIGNING_KEY": str(key_path), "MURAGE_OPENSSL": openssl_bin,
                                         "PATH": os.path.dirname(openssl_bin) + os.pathsep + os.environ.get("PATH", "")}, capture_output=True)
            (self.evidence / "sign.log").write_bytes(self.redact((signed.stdout or b"").decode(errors="replace") + (signed.stderr or b"").decode(errors="replace"), str(key_path)).encode())
            if signed.returncode:
                raise QualError("local signing failed (see sign.log)")
            # 5. signature and PUBLIC key to the builder.
            if self.run(["rsync", "-a", "--no-owner", "--no-group", "-e", sshcmd, str(release_dir / "manifest.json.sig"), "root@%s:%s/%s/manifest.json.sig" % (ip, out_dir, arch)], capture_output=True).returncode \
                    or self.run(["rsync", "-a", "--no-owner", "--no-group", "-e", sshcmd, str(public_pem), "root@%s:%s" % (ip, remote_pub)], capture_output=True).returncode:
                raise QualError("copy of signature and public key to the builder failed")
            # 6. finalize: the builder re-verifies the signature and the published bytes with the home's own code.
            self._stage(ssh, "finalize.log", "%s finalize %s %s %s %s" % (remote_release, arch, revision, out_dir, remote_pub), "release finalize")
            # 7. stage seal on the same host and revision.
            self._stage(ssh, "seal.log", "MURAGE_IMAGE_STAGE=seal MURAGE_RELEASE_CHANNEL_URL=%s MURAGE_RELEASE_PUBLIC_KEY=%s MURAGE_RELEASE_MANIFEST=%s MURAGE_RELEASE_MANIFEST_SIG=%s %s"
                        % (shlex.quote(release_channel), remote_pub, remote_manifest, remote_manifest + ".sig", remote_build), "build-image.sh stage seal")
            # A hard poweroff loses files still in the page cache: the first
            # real home booted with every late-written unit and helper at 0
            # bytes. Flush, prove the key files are intact, then shut down.
            # The snapshot is the builder's disk: nothing of the build may remain
            # on a customer home (audit A1-01: /build/murage shipped world-readable).
            check = ("cp /build/murage/deploy/cloud-home/finalize-customer-image.sh /build/murage/deploy/cloud-home/image-release-check.sh /run/ && swapoff /mcq-build.swap && rm -f /mcq-build.swap && rm -rf /build /root/.bash_history /root/.cache /root/.gitconfig /root/.ssh/authorized_keys /etc/ssh/ssh_host_*_key /etc/ssh/ssh_host_*_key.pub"
                     " && apt-get clean && journalctl --rotate >/dev/null && journalctl --vacuum-time=1s >/dev/null"
                     # Per-instance identity: every home generates its own machine-id on
                     # first boot (seen on a real home: all homes shared the builder's).
                     " && truncate -s 0 /etc/machine-id && { [ -L /var/lib/dbus/machine-id ] || rm -f /var/lib/dbus/machine-id; } && rm -rf /var/log/journal"
                     " && cloud-init clean --logs >/dev/null"
                     " && [ ! -e /build ] || { echo 'BUILD LEFTOVERS'; exit 1; }; sync; for f in /etc/systemd/system/murage-home.service /etc/systemd/system/murage-volume.service "
                     "/usr/local/libexec/murage-turn-launch /usr/local/libexec/murage-enroll /usr/local/libexec/murage-seccomp.bpf "
                     "/etc/murage-home/murage-egress.nft /etc/murage-home/identity.json; do [ -s \"$f\" ] || { echo \"EMPTY $f\"; exit 1; }; done; sync")
            # A customer image: purge sshd and run the release check as the very last command of this last ssh session, on the
            # disk that becomes the snapshot. The server is shut down through the API; nothing connects after the purge.
            if not staging_ops_ssh:
                check += "; bash /run/finalize-customer-image.sh build-%s" % short
            res = self.run(ssh + [check], capture_output=True)
            (self.evidence / "check.log").write_bytes(res.stdout + res.stderr)
            if res.returncode:
                raise QualError("image files empty or missing before snapshot: %s" % ((res.stdout + res.stderr).decode(errors="replace").strip().splitlines() or [""])[-1])
            self.c.wait_actions(self.c.request("POST", "/servers/%s/actions/shutdown" % builder["id"]))
            for _ in range(36):
                if self.c.request("GET", "/servers/%s" % builder["id"])["server"].get("status") == "off":
                    break
                self.c.sleep(5)
            else:
                raise QualError("builder did not shut down cleanly; refusing to snapshot")
            idata = self.c.request("POST", "/servers/%s/actions/create_image" % builder["id"],
                                   {"type": "snapshot", "description": snap_desc, "labels": dict({"mcq": "1", "murage/build": revision, "murage/role": "image", "murage/image-kind": image_kind, "murage/env": env}, **({"lane": lane} if lane else {}))})
            image = idata["image"]
            self.ledger.create("snapshot", image["id"], snap_desc, "snapshot", location, self.snapshot_hourly(float(image.get("image_size") or 20)), cur)
            # build host has taken over 10 min for a 4 GB snapshot (2026-10-14); a timeout
            # here deletes the builder and the half-made snapshot with it, so wait long.
            self.c.wait_action(idata.get("action"), timeout=3600, interval=10)
            self.out("snapshot id=%s description=%s image-kind=%s" % (image["id"], snap_desc, image_kind))
        finally:
            try:
                self.delete_server(builder)
            except Exception as exc:
                print("WARNING: builder delete failed: %s (run destroy --all)" % exc, file=sys.stderr)


def build_parser():
    common = argparse.ArgumentParser(add_help=False)
    # No default path: the token file is named by the operator (flag, or MURAGE_HZ_TOKEN_FILE).
    common.add_argument("--token-file", default=os.environ.get("MURAGE_HZ_TOKEN_FILE"),
                        required=not os.environ.get("MURAGE_HZ_TOKEN_FILE"),
                        help="file holding the build host API token (or set MURAGE_HZ_TOKEN_FILE)")
    common.add_argument("--evidence", default="qualification-evidence")
    common.add_argument("--cap", type=float, default=250.0)
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list", parents=[common])
    sub.add_parser("spend", parents=[common])
    i = sub.add_parser("image", parents=[common])
    i.add_argument("--revision", required=True)
    i.add_argument("--source", required=True)
    i.add_argument("--control-public-key")
    i.add_argument("--type", default="cx33", help="builder server type, 8 GB or more: cx33 (x86_64) or cax21 (arm64, with --lane arm) at minimum")
    i.add_argument("--location", default="fsn1")
    i.add_argument("--ssh-key", required=True)
    i.add_argument("--env", required=True, choices=IMAGE_ENVS, help="environment this image is built for; written to the murage/env label")
    i.add_argument("--staging-ops-ssh", action="store_true", help="STAGING ONLY: keep sshd and mark the image staging-ops-ssh; the control plane refuses it for any non-staging home")
    i.add_argument("--release-signing-key", required=True, help="Ed25519 release private key (PEM) on THIS machine (staging key; the production key is refused); never sent to the builder")
    i.add_argument("--release-channel", required=True, help="https URL of the signed release channel baked into the image (the production channel is refused)")
    i.add_argument("--release-sequence", required=True, help="positive integer release sequence")
    i.add_argument("--openssl", help="OpenSSL 3 binary for local signing (default on macOS: /opt/homebrew/bin/openssl; LibreSSL refused)")
    i.add_argument("--lane", help="name the builder mcq-LANE-build, label lane=LANE and suffix the snapshot description (arm64 images)")
    v = sub.add_parser("verify-image", parents=[common])
    v.add_argument("--image-id", required=True)
    v.add_argument("--ssh-key", required=True)
    v.add_argument("--type", help="default: the cheapest server type that fits the image")
    v.add_argument("--location", default="fsn1")
    h = sub.add_parser("create-home", parents=[common])
    h.add_argument("--name", required=True)
    h.add_argument("--type", required=True)
    h.add_argument("--location", required=True)
    h.add_argument("--image", required=True)
    h.add_argument("--ssh-key", required=True)
    h.add_argument("--volume-gb", type=int, default=30)
    h.add_argument("--user-data-file")
    h.add_argument("--managed-endpoint", action="store_true", help="reached only through a Cloudflare Tunnel; no 80/443")
    e = sub.add_parser("enroll-home", parents=[common])
    e.add_argument("--name", required=True)
    e.add_argument("--cp-url", required=True)
    e.add_argument("--cp-secrets", required=True)
    e.add_argument("--public-origin", help="required unless --managed-endpoint (the control plane then allocates it)")
    e.add_argument("--managed-endpoint", action="store_true", help="control plane allocates the public origin; home dials out through a Cloudflare Tunnel")
    e.add_argument("--ssh-from", action="append", help="repeatable: operator IP and a fixed jump host")
    r = sub.add_parser("retire-home", parents=[common])
    r.add_argument("--name", required=True)
    r.add_argument("--cp-url", required=True)
    r.add_argument("--cp-secrets", required=True)
    f = sub.add_parser("fw", parents=[common])
    f.add_argument("--ssh-from", action="append", required=True, help="repeatable")
    f.add_argument("--managed-endpoint", action="store_true", help="no world-open 80/443 rule")
    d = sub.add_parser("destroy", parents=[common])
    g = d.add_mutually_exclusive_group(required=True)
    g.add_argument("--all", action="store_true")
    g.add_argument("--name")
    g.add_argument("--snapshot", dest="snapshot_id")
    d.add_argument("--snapshots", action="store_true")
    return p


def main(argv=None, transport=urllib_transport, cp_transport=urllib_transport, sleep=time.sleep, clock=time.monotonic, now=utcnow, out=print):
    args = build_parser().parse_args(argv)
    try:
        client = Client(read_token(args.token_file), transport, sleep, clock)
        drv = Driver(client, args.evidence, args.cap, now, out)
        if args.cmd == "list":
            drv.cmd_list()
        elif args.cmd == "spend":
            drv.cmd_spend()
        elif args.cmd == "image":
            drv.cmd_image(args.revision, args.source, args.type, args.location, args.ssh_key, args.control_public_key, args.lane,
                           args.staging_ops_ssh, args.env, args.release_signing_key, args.release_channel, args.release_sequence, args.openssl)
        elif args.cmd == "verify-image":
            drv.cmd_verify_image(args.image_id, args.ssh_key, args.type, args.location)
        elif args.cmd == "create-home":
            drv.cmd_create_home(args.name, args.type, args.location, args.image, args.ssh_key, args.volume_gb, args.user_data_file, args.managed_endpoint)
        elif args.cmd == "enroll-home":
            drv.cmd_enroll_home(args.name, args.cp_url, args.cp_secrets, args.public_origin, args.ssh_from, cp_transport, args.managed_endpoint)
        elif args.cmd == "retire-home":
            drv.cmd_retire_home(args.name, args.cp_url, args.cp_secrets, cp_transport)
        elif args.cmd == "fw":
            drv.cmd_fw(args.ssh_from, args.managed_endpoint)
        elif args.cmd == "destroy":
            drv.cmd_destroy(args.snapshots, args.name, args.snapshot_id)
        return 0
    except QualError as exc:
        print("error: %s" % exc, file=sys.stderr)
    except Exception as exc:
        print("error: unexpected %s" % type(exc).__name__, file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
