#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# The owner-factor capability negotiation (CLOUD-DOOR-OWNER-FACTOR-DESIGN-r3 4.1): app_report reads ownerFactor from the app's
# health body, and machine_request stamps X-Murage-Owner-Factor: 1 on a heartbeat only when it is True.
import importlib.machinery
import importlib.util
import json
import os
import pathlib
import tempfile
import time
import unittest
import unittest.mock
import urllib.error
import urllib.request

# The module file has no .py extension, so give importlib an explicit source loader.
# MC_UNDER_TEST points the whole file at a mutant copy of murage-control (mutation runs); unset it is the real file.
_loader = importlib.machinery.SourceFileLoader("murage_control", os.environ.get("MC_UNDER_TEST") or str(pathlib.Path(__file__).with_name("murage-control")))
mc = importlib.util.module_from_spec(importlib.util.spec_from_loader("murage_control", _loader))
_loader.exec_module(mc)


def scoped_ancestors(root):
    """Check a test's control paths only from their own temp directory down. secure_parents and read_secure walk every ancestor to
    "/" and refuse one that is owned by another user or group/world-writable; that is right for the daemon, but above a checkout it
    is whatever the machine running the test has (a runner that is another uid than the checkout's owner, a group-writable
    /Volumes). Inside the temp directory the same rules apply, and read_secure's file rules are applied to the file itself."""
    import os, stat
    root = os.path.realpath(root)
    real_parents, real_read = mc.secure_parents, mc.read_secure

    def check(path, expected_uid=0):
        if not path.startswith(root + "/"):
            return real_parents(path, expected_uid)
        parent = os.path.dirname(path)
        while True:
            info = os.lstat(parent)
            if not stat.S_ISDIR(info.st_mode) or info.st_uid not in (0, expected_uid) or info.st_mode & 0o022:
                raise ValueError("Unsafe control parent")
            if parent == root:
                return
            parent = os.path.dirname(parent)

    def read(path, private=False, expected_uid=0, limit=65536, binary=False):
        if not path.startswith(root + "/"):
            return real_read(path, private, expected_uid, limit, binary)
        check(path, expected_uid)
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            mode = stat.S_IMODE(info.st_mode)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != expected_uid
                    or (mode != 0o600 if private else bool(mode & 0o022)) or info.st_size > limit):
                raise ValueError("Unsafe control input")
            raw = stream.read(limit + 1)
            if len(raw) > limit:
                raise ValueError("Oversize control input")
            return raw if binary else raw.decode("utf-8")

    stack = unittest.mock.patch.multiple(mc, secure_parents=check, read_secure=read)
    return stack


class FakeResp:
    def __init__(self, body):
        self._body = body
        self.status = 200

    def read(self, n=-1):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class FakeOpener:
    def __init__(self, body):
        self.body = body
        self.req = None

    def open(self, request, timeout=None):
        self.req = request
        return FakeResp(self.body)


def report_for(body):
    import json
    return mc.app_report("https://home.example", opener=FakeOpener(json.dumps(body).encode()))


class AppReportOwnerFactor(unittest.TestCase):
    def test_absent_is_false(self):
        self.assertIs(report_for({"app": "murage", "door": "v2"})["ownerFactor"], False)

    def test_integer_one_is_true(self):
        self.assertIs(report_for({"app": "murage", "ownerFactor": 1})["ownerFactor"], True)

    def test_bool_string_and_two_are_false(self):
        for value in (True, "1", 2):
            self.assertIs(report_for({"app": "murage", "ownerFactor": value})["ownerFactor"], False, value)

    def test_door_unchanged(self):
        self.assertEqual(report_for({"app": "murage", "door": "v2", "ownerFactor": 1})["door"], "v2")
        self.assertIsNone(report_for({"app": "murage", "ownerFactor": 1})["door"])


class MachineRequestHeader(unittest.TestCase):
    def setUp(self):
        self.captured = []
        real = urllib.request.build_opener

        def fake_build_opener(*_a, **_k):
            opener = FakeOpener(b"{}")
            captured = self.captured

            class Rec(FakeOpener):
                def open(self, request, timeout=None):
                    captured.append(request)
                    return FakeResp(b"{}")

            return Rec(b"{}")

        self._real = real
        urllib.request.build_opener = fake_build_opener

    def tearDown(self):
        urllib.request.build_opener = self._real

    def call(self, **kwargs):
        binding = {"adminUrl": "https://cp.example", "homeId": "home-1", "credential": "tok"}
        mc.machine_request(binding, "heartbeat", {"generation": 1}, **kwargs)
        return self.captured[-1]

    def test_owner_factor_true_sends_header(self):
        req = self.call(door=True, owner_factor=True)
        self.assertTrue(req.has_header("X-murage-owner-factor"))
        self.assertEqual(req.get_header("X-murage-owner-factor"), "1")

    def test_owner_factor_false_omits_header(self):
        req = self.call(door=True, owner_factor=False)
        self.assertFalse(req.has_header("X-murage-owner-factor"))

    def test_door_header_unchanged(self):
        self.assertTrue(self.call(door=True, owner_factor=True).has_header("X-murage-door"))
        self.assertFalse(self.call(door=False, owner_factor=True).has_header("X-murage-door"))


class ValidateDesiredFluxRenewal(unittest.TestCase):
    BINDING = {"homeId": "h1", "generation": 3}
    LEASE = {"expiresAt": 5000}

    def desired(self, **extra):
        value = {"wire": 1, "homeId": "h1", "generation": 3, "desiredState": "ready",
                 "engineSubscriptionGates": {"claudeAgent": True, "codex": True, "grokAgent": True, "kimiAgent": True, "opencodeGo": True},
                 "lease": {"holder": "h1", "generation": 3, "expiresAt": 5000},
                 "executionAllowed": True, "heartbeatFresh": True, "heartbeatEveryMs": 60000,
                 "homeKey": {"payload": "abc", "signature": "A" * 86, "algorithm": "ES256"}}
        value.update(extra)
        return value

    def check(self, value):
        return mc.validate_desired(value, self.BINDING, self.LEASE)

    def test_absent_passes(self):
        self.assertNotIn("flux_renewal_due", self.check(self.desired()))

    def test_valid_present_passes_and_is_dropped(self):
        for flag in (True, False):
            out = self.check(self.desired(flux_renewal_due=flag))
            self.assertNotIn("flux_renewal_due", out)
            self.assertEqual(out, self.desired())

    def test_wrong_type_refused(self):
        for bad in (1, 0, "true", None, [], {}):
            with self.assertRaises(ValueError, msg=repr(bad)):
                self.check(self.desired(flux_renewal_due=bad))

    def test_other_unknown_field_refused(self):
        with self.assertRaises(ValueError):
            self.check(self.desired(surprise=True))
        with self.assertRaises(ValueError):
            self.check(self.desired(flux_renewal_due=True, surprise=True))


class RenewalHonoursTheCue(unittest.TestCase):
    """The poller asks the control plane about renewal only when its desired answer carried flux_renewal_due: true."""

    def run_renewal(self, context):
        import tempfile
        asked = []
        def request(binding, operation, body=None):
            asked.append(operation)
            return {"due": False}
        with tempfile.TemporaryDirectory() as directory:
            mc.renew_flux_subkey({"generation": 1}, context, request, pending_path=directory + "/pending.json", directory=directory,
                                 owner_uid=None, expected_uid=__import__("os").getuid())
        return asked

    def test_no_cue_means_no_question(self):
        self.assertEqual(self.run_renewal({}), [])
        self.assertEqual(self.run_renewal({"fluxRenewalDue": False}), [])
        self.assertEqual(self.run_renewal({"fluxRenewalDue": 1}), [])

    def test_cue_asks_once(self):
        self.assertEqual(self.run_renewal({"fluxRenewalDue": True}), ["flux/renewal-due"])


class FluxHandoffWithoutChown(unittest.TestCase):
    """The hand-off needs no chown to another uid and no capability (murage-control.service drops them all)."""
    SUBKEY = {"key": "sk-flux-home-" + "S" * 40, "generation": 2, "expiresAt": "2030-01-01T00:00:00Z", "capUsd": 5.0}
    OP = "renew:h1:1:1"

    def test_directory_and_file_modes_and_group(self):
        import os, stat, tempfile
        os.umask(0o077)  # the unit's UMask=0077
        with tempfile.TemporaryDirectory(dir=str(pathlib.Path(__file__).parent)) as root, scoped_ancestors(root):  # not /tmp: world-writable
            directory = root + "/flux-subkey"
            ack = mc.deliver_flux_subkey({"generation": 1}, lambda *_a: dict(self.SUBKEY), self.OP, directory, os.getuid(), os.getgid())
            self.assertEqual(ack, {"generation": 1, "op_id": self.OP, "key_generation": 2})
            self.assertEqual(stat.S_IMODE(os.stat(directory).st_mode), 0o770)
            info = os.stat(directory + "/key.json")
            self.assertEqual(stat.S_IMODE(info.st_mode), 0o640)
            self.assertEqual((info.st_uid, info.st_gid), (os.geteuid(), os.getgid()))

    def test_receipt_is_read_through_the_group_and_only_when_it_is_the_supervisors_own(self):
        import os, tempfile
        pending = {"op_id": self.OP, "key_generation": 2}
        with tempfile.TemporaryDirectory(dir=str(pathlib.Path(__file__).parent)) as root, scoped_ancestors(root):  # not /tmp: world-writable
            directory = root + "/flux-subkey"
            mc.private_delivery_dir(directory, os.getgid())
            def receipt(mode, body='{"op_id":"%s","generation":2}' % self.OP):
                path = directory + "/receipt.json"
                if os.path.exists(path):
                    os.unlink(path)
                fd = os.open(path, os.O_WRONLY | os.O_CREAT, mode); os.fchmod(fd, mode); os.write(fd, body.encode()); os.close(fd)
            read = lambda uid=os.getuid(): mc.read_flux_receipt(pending, directory, uid, os.getgid(), os.getuid())
            self.assertFalse(read())
            receipt(0o640); self.assertTrue(read())
            receipt(0o600); self.assertTrue(read())
            receipt(0o644); self.assertFalse(read())          # world readable is not the supervisor's file
            receipt(0o660); self.assertFalse(read())
            receipt(0o640); self.assertFalse(read(os.getuid() + 1))  # not written by the supervisor's uid
            receipt(0o640, '{"op_id":"renew:h1:1:2","generation":2}'); self.assertFalse(read())

    def test_pending_record_is_in_the_daemons_own_state_directory(self):
        self.assertTrue(mc.FLUX_PENDING_ACK.startswith(mc.CONTROL_STATE + "/"))


class FluxAckGeneration(unittest.TestCase):
    """Finding 3: a receipt retried after a restart authenticates with the CURRENT machine generation, not the pending record's."""
    def test_ack_uses_the_current_binding_generation(self):
        sent = []
        mc.ack_flux_subkey({"generation": 5}, lambda b, op, body: sent.append((op, body)) or {"acked": True},
                           {"generation": 1, "op_id": "renew:h1:1:1", "key_generation": 2, "written_at": 1})
        self.assertEqual(sent, [("flux/subkey/ack", {"generation": 5, "op_id": "renew:h1:1:1", "key_generation": 2})])

    def test_unknown_op_after_a_rebind_clears_the_record(self):
        import io, os, tempfile, urllib.error
        with tempfile.TemporaryDirectory(dir=str(pathlib.Path(__file__).parent)) as root, scoped_ancestors(root):  # not /tmp: world-writable
            directory, pending_path = root + "/flux-subkey", root + "/pending.json"
            mc.private_delivery_dir(directory, os.getgid())
            record = {"generation": 1, "op_id": "renew:h1:1:1", "key_generation": 2, "written_at": 1}
            mc.atomic_private(pending_path, record)
            fd = os.open(directory + "/receipt.json", os.O_WRONLY | os.O_CREAT, 0o640); os.fchmod(fd, 0o640)
            os.write(fd, b'{"op_id":"renew:h1:1:1","generation":2}'); os.close(fd)
            def ack(binding, request, pending):
                raise urllib.error.HTTPError("u", 409, "ack_unknown", {}, io.BytesIO(b""))
            mc.renew_flux_subkey({"generation": 5}, {}, None, ack_fn=ack, pending_path=pending_path, directory=directory,
                                 owner_uid=os.getuid(), owner_gid=os.getgid(), expected_uid=os.getuid())
            self.assertFalse(os.path.exists(pending_path))
            self.assertFalse(os.path.exists(directory + "/receipt.json"))
# ---- Cross-version event negotiation (1.0.19 home against a control plane with and without the new event types) ----
# OLD_PROD_* replays the live prod control plane 9b1f5c7cb (the release line):
#   cloudflare/control-plane/src/ops-monitor.ts:14   HOME_EVENT_TYPES = ["abuse.mining_suspected"]
#   cloudflare/control-plane/src/ops-monitor.ts:41-88 healthSchema (z.object(...).strict(), events: z.array(...).max(5), type: z.enum(HOME_EVENT_TYPES))
#   cloudflare/control-plane/src/b3-control.ts:3149  heartbeatSchema = z.object({generation, health: healthSchema.optional()}).strict()
#   cloudflare/control-plane/src/b3-control.ts:3183-3186 a parse failure is refused (400), the whole heartbeat.
# The TypeScript side (cloudflare/control-plane/test/home-event-types.test.ts) replays the exact zod schemas; this is the same rule for the python home.
OLD_PROD_EVENT_TYPES = ("abuse.mining_suspected",)
OLD_PROD_HEALTH_KEYS = {"diskUsedPercent", "lastBackupAt", "appResponding", "checks", "clock", "evidenceEpoch", "bootSeq", "bootId", "events"}
HOME = "home-test"
WALL = 1_800_000_000_000


def old_prod_accepts(body):
    if set(body) - {"generation", "health"} or "generation" not in body:
        return False
    health = body.get("health")
    if health is None:
        return True
    if set(health) - OLD_PROD_HEALTH_KEYS:
        return False
    events = health.get("events", [])
    return len(events) <= 5 and all(set(e) == {"type", "at"} and e["type"] in OLD_PROD_EVENT_TYPES and type(e["at"]) is int for e in events)


class FakeCP:
    """mode "old": strict 9b1f5c7cb schema, 400 on a parse failure, plain {wire, accepted} ack. mode "new": accepts the extended types and
    advertises them in the X-Murage-Event-Types response header. epoch=True: the ack also carries generation and evidenceEpoch."""
    def __init__(self, mode, epoch=False, advertise="restore.aborted,restore.stuck,home.event_spool_failed"):
        self.mode, self.epoch, self.advertise, self.bodies, self.fail_next = mode, epoch, advertise, [], 0

    def __call__(self, binding, operation, body=None, **kw):
        if operation == "lease":
            return {"wire": 1, "installationId": "inst1", "holder": HOME, "generation": 1, "expiresAt": WALL + 3_600_000,
                    "renewAfterMs": 60000, "ttlMs": 3600000, "skewMs": 120000}
        if operation == "desired":
            return {"stub": True}
        self.bodies.append(body)
        if self.fail_next:
            self.fail_next -= 1
            raise urllib.error.HTTPError("https://cp.test", 503, "unavailable", {}, None)
        if self.mode == "old" and not old_prod_accepts(body):
            raise urllib.error.HTTPError("https://cp.test", 400, "rejected", {}, None)
        ack = {"wire": 1, "accepted": True}
        if self.epoch:
            ack.update(generation=1, evidenceEpoch=7)
        reply = mc.Reply(ack)
        reply.event_types = self.advertise if self.mode == "new" else None
        return reply


class NegotiationBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.spool = self.tmp.name + "/events"
        os.mkdir(self.spool)
        self.saved = {name: getattr(mc, name) for name in ("EVENTS", "SERVER_EVENTS", "validate_desired", "sample_clock", "clocks_match", "fence")}
        mc.EVENTS, mc.SERVER_EVENTS = self.spool, self.tmp.name + "/none"
        mc.validate_desired = lambda value, binding, lease: value
        mc.sample_clock = lambda context, clock, public: {"wallMs": WALL, "bootMs": 1000, "monoMs": 1000, "bootId": "b"}
        mc.clocks_match = lambda a, b: True
        mc.fence = lambda context, public: None
        for name, value in self.saved.items():
            self.addCleanup(setattr, mc, name, value)
        self.binding = {"homeId": HOME, "generation": 1, "adminUrl": "https://cp.test", "credential": "c"}
        self.state_path = self.tmp.name + "/spool-state.json"
        self.context = {"appProbe": lambda origin: None, "bootId": lambda: None, "spoolStatePath": self.state_path}

    def pending(self):
        try:
            with open(self.state_path) as handle:
                return json.load(handle).get("pending")
        except (OSError, ValueError):
            return None

    def spool_event(self, type_, at):
        with open("%s/%s-%d.json" % (self.spool, type_, at), "w") as handle:
            json.dump({"type": type_, "at": at}, handle)

    def spooled(self):
        return sorted(os.listdir(self.spool))

    def poll(self, cp):
        return mc.poll_once(self.binding, self.context, cp, lambda: {}, self.tmp.name + "/public", os.getuid(), lambda *a: None)

    def sent_events(self, cp, index=-1):
        return [(e["type"], e["at"]) for e in (cp.bodies[index].get("health") or {}).get("events", [])]


class EventNegotiation(NegotiationBase):
    def test_old_cp_stuck_restore_is_held_and_heartbeat_accepted(self):
        self.spool_event("restore.stuck", 11)
        self.spool_event("abuse.mining_suspected", 12)
        cp = FakeCP("old")
        self.poll(cp)
        self.assertEqual(self.sent_events(cp), [("abuse.mining_suspected", 12)])
        self.assertEqual(self.spooled(), ["restore.stuck-11.json"])  # held on disk, the base event consumed

    def test_never_sends_new_types_without_advertisement_even_when_spooled_first(self):
        for at in range(1, 8):
            self.spool_event("restore.aborted", at)
        self.spool_event("abuse.mining_suspected", 99)
        cp = FakeCP("old")
        for _ in range(3):
            self.poll(cp)
        self.assertTrue(all(old_prod_accepts(body) for body in cp.bodies))
        self.assertEqual(len(self.spooled()), 7)  # none lost, none sent

    def test_new_cp_flush_on_first_advertising_ack_exactly_once(self):
        self.spool_event("restore.stuck", 11)
        cp = FakeCP("new")
        self.poll(cp)                       # first answer not yet seen: held
        self.assertEqual(self.sent_events(cp), [])
        self.poll(cp)                       # last ack advertised: flushed
        self.assertEqual(self.sent_events(cp), [("restore.stuck", 11)])
        self.assertEqual(self.spooled(), [])
        self.poll(cp)                       # advertises again: nothing is sent twice
        self.poll(cp)
        self.assertEqual(self.sent_events(cp, 2), [])
        self.assertEqual(self.sent_events(cp, 3), [])
        self.assertEqual([b for b in cp.bodies if self.events_of(b)], [cp.bodies[1]])

    @staticmethod
    def events_of(body):
        return (body.get("health") or {}).get("events", [])

    def test_retried_heartbeat_resends_the_same_event_and_flushes_once(self):
        self.spool_event("restore.aborted", 21)
        cp = FakeCP("new")
        self.poll(cp)
        cp.fail_next = 1
        with self.assertRaises(urllib.error.HTTPError):
            self.poll(cp)                   # the heartbeat that carried it was answered 503: file stays
        self.assertEqual(self.spooled(), ["restore.aborted-21.json"])
        self.poll(cp)                       # a failed answer forgets the advertisement (per response): held again, never lost
        self.assertEqual(self.sent_events(cp), [])
        self.poll(cp)
        self.assertEqual(self.sent_events(cp), [("restore.aborted", 21)])
        self.poll(cp)
        self.assertEqual([self.events_of(b) for b in cp.bodies if self.events_of(b)], [[{"type": "restore.aborted", "at": 21}]] * 2)
        # the 503 attempt and the accepted flush carried the identical (type, at): the control plane keeps one open alert per home and kind
        self.assertEqual(self.spooled(), [])

    def test_rollback_to_old_cp_after_an_advertising_ack_resends_without_the_new_types(self):
        self.spool_event("restore.stuck", 31)
        new, old = FakeCP("new"), FakeCP("old")
        self.poll(new)                      # advertisement learned
        self.poll(old)                      # reaches an older CP: its 400 is not a rejection of this home
        self.assertEqual(len(old.bodies), 2)
        self.assertEqual(self.sent_events(old, 0), [("restore.stuck", 31)])
        self.assertEqual(self.sent_events(old, 1), [])
        self.assertEqual(self.spooled(), ["restore.stuck-31.json"])
        self.assertTrue(old_prod_accepts(old.bodies[1]))

    def test_spool_failed_alert_is_pending_until_advertised(self):
        self.context["appProbe"] = lambda origin: {"ok": True, "spoolFailures": 1}
        cp = FakeCP("old")
        self.poll(cp)
        self.assertTrue(all(old_prod_accepts(body) for body in cp.bodies))
        self.assertIsNotNone(self.pending())
        new = FakeCP("new")
        self.poll(new)
        self.poll(new)
        self.assertEqual([t for t, _ in self.sent_events(new)], ["home.event_spool_failed"])
        self.assertIsNone(self.pending())
        self.poll(new)
        self.assertEqual(self.sent_events(new), [])

    def test_stuck_restore_old_ack_then_owner_spool_survives_for_the_owner_surface(self):
        # the owner status line reads the same spool (server/home-events.ts heldHomeEvents): the file must still be there after accepted old-CP heartbeats
        self.spool_event("restore.stuck", 41)
        cp = FakeCP("old")
        for _ in range(3):
            self.poll(cp)
        self.assertEqual(self.spooled(), ["restore.stuck-41.json"])
        self.assertTrue(all(old_prod_accepts(body) for body in cp.bodies))

    def test_header_is_an_allowlist_and_the_ack_body_stays_strict(self):
        self.assertEqual(mc.advertised_event_types(type("R", (), {"event_types": "restore.stuck, evil.type,abuse.mining_suspected"})()), {"restore.stuck"})
        self.assertEqual(mc.advertised_event_types({"wire": 1}), frozenset())
        for epoch in (False, True):
            cp = FakeCP("new", epoch=epoch)
            self.context.pop("eventTypes", None)
            self.spool_event("restore.stuck", 51 + epoch)
            self.poll(cp)
            self.poll(cp)
            self.assertEqual(self.sent_events(cp), [("restore.stuck", 51 + epoch)])

    def test_emit_bodies(self):
        out = os.environ.get("MC_BODIES_OUT")
        if not out:
            self.skipTest("fixture generation only")
        self.spool_event("abuse.mining_suspected", 5)
        self.spool_event("restore.stuck", 6)
        self.context["appProbe"] = lambda origin: {"ok": True, "spoolFailures": 1}
        without, with_ad = FakeCP("old"), FakeCP("new")
        self.poll(without)
        self.spool_event("restore.aborted", 7)
        self.poll(with_ad)
        self.poll(with_ad)
        json.dump({"withoutAdvertisement": without.bodies, "withAdvertisement": with_ad.bodies}, open(out, "w"), indent=1, sort_keys=True)


class HttpReply:
    """A real response object as urllib gives it: status, read(), and headers (an HTTPMessage)."""
    def __init__(self, body, headers=None):
        import email.message
        self._body, self.status = body, 200
        self.headers = email.message.Message()
        for name, value in (headers or {}).items():
            self.headers[name] = value

    def read(self, n=-1):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class WireTransport:
    """Patches build_opener so machine_request() runs for real (headers parsed from a fake HTTP response)."""
    def install(self, testcase, header=None, ack=None):
        self.requests, self.header = [], header
        self.ack = ack if ack is not None else {"wire": 1, "accepted": True}
        owner = self
        lease = {"wire": 1, "installationId": "inst1", "holder": HOME, "generation": 1, "expiresAt": WALL + 3_600_000,
                 "renewAfterMs": 60000, "ttlMs": 3600000, "skewMs": 120000}

        class Opener:
            def open(self, request, timeout=None):
                owner.requests.append(request)
                if request.full_url.endswith("/lease"):
                    return HttpReply(json.dumps(lease).encode())
                if request.full_url.endswith("/desired"):
                    return HttpReply(b'{"stub": true}')
                headers = {} if owner.header is None else {"X-Murage-Event-Types": owner.header}
                return HttpReply(json.dumps(owner.ack).encode(), headers)

        real = urllib.request.build_opener
        urllib.request.build_opener = lambda *a, **k: Opener()
        testcase.addCleanup(setattr, urllib.request, "build_opener", real)

    def heartbeat_events(self, index=-1):
        beats = [r for r in self.requests if r.full_url.endswith("/heartbeat")]
        body = json.loads(beats[index].data)
        return [(e["type"], e["at"]) for e in (body.get("health") or {}).get("events", [])]


class TransportAndRejection(NegotiationBase):
    def test_machine_request_reads_the_response_header_on_a_heartbeat_only(self):
        wire = WireTransport()
        wire.install(self, header="restore.stuck,restore.aborted")
        reply = mc.machine_request(self.binding, "heartbeat", {"generation": 1})
        self.assertEqual(reply.event_types, "restore.stuck,restore.aborted")
        self.assertEqual(mc.advertised_event_types(reply), {"restore.stuck", "restore.aborted"})
        self.assertNotIsInstance(mc.machine_request(self.binding, "desired"), mc.Reply)
        wire.header = None
        self.assertIsNone(mc.machine_request(self.binding, "heartbeat", {"generation": 1}).event_types)

    def test_oversized_header_is_ignored(self):
        wire = WireTransport()
        wire.install(self, header="restore.stuck," + "x" * 600)
        reply = mc.machine_request(self.binding, "heartbeat", {"generation": 1})
        self.assertGreater(len(reply.event_types), 512)
        self.assertEqual(mc.advertised_event_types(reply), frozenset())
        wire.header = "restore.stuck," + "x" * (512 - len("restore.stuck,"))  # exactly 512 is still read
        self.assertEqual(len(wire.header), 512)
        self.assertEqual(mc.advertised_event_types(mc.machine_request(self.binding, "heartbeat", {"generation": 1})), {"restore.stuck"})

    def test_whole_poll_over_the_real_transport_flushes_a_held_event_after_a_header(self):
        wire = WireTransport()
        wire.install(self, header="restore.stuck")
        self.spool_event("restore.stuck", 81)
        self.poll(mc.machine_request)
        self.assertEqual(wire.heartbeat_events(), [])
        self.poll(mc.machine_request)
        self.assertEqual(wire.heartbeat_events(), [("restore.stuck", 81)])
        self.assertEqual(self.spooled(), [])

    def test_oversized_header_over_the_real_transport_keeps_the_event_held(self):
        wire = WireTransport()
        wire.install(self, header="restore.stuck," + "x" * 600)
        self.spool_event("restore.stuck", 82)
        for _ in range(3):
            self.poll(mc.machine_request)
        self.assertEqual(wire.heartbeat_events(), [])
        self.assertEqual(self.spooled(), ["restore.stuck-82.json"])

    def test_a_malformed_or_refused_ack_consumes_nothing_and_learns_nothing(self):
        bad_acks = [{"wire": 1, "accepted": False}, {"wire": 1}, {"wire": 1, "accepted": True, "extra": 1}, {"wire": 2, "accepted": True},
                    {"wire": 1, "accepted": "yes"}, {"wire": 1, "accepted": True, "generation": 1, "evidenceEpoch": "7"}]
        for ack in bad_acks:
            for name in os.listdir(self.spool):
                os.unlink(self.spool + "/" + name)
            self.spool_event("abuse.mining_suspected", 91)
            wire = WireTransport()
            wire.install(self, header="restore.stuck", ack=ack)
            self.context.pop("eventTypes", None)
            with self.assertRaises(ValueError, msg=ack):
                self.poll(mc.machine_request)
            self.assertEqual(self.spooled(), ["abuse.mining_suspected-91.json"], ack)
            self.assertNotIn("eventTypes", self.context, ack)
            self.assertEqual(wire.heartbeat_events(), [("abuse.mining_suspected", 91)])


class ExactConsumption(NegotiationBase):
    def prime(self):
        """An advertising answer learned, and a spool failure owed."""
        self.context["appProbe"] = lambda origin: {"ok": True, "spoolFailures": 1}
        new = FakeCP("new")
        self.poll(new)
        return new

    def five_mining(self):
        for at in range(1, 6):
            self.spool_event("abuse.mining_suspected", at)

    def test_the_fifth_mining_event_survives_the_trim_for_the_spool_failed_report(self):
        self.prime()
        self.five_mining()
        new = FakeCP("new")
        self.poll(new)
        self.assertEqual(self.sent_events(new), [("abuse.mining_suspected", at) for at in (1, 2, 3, 4)] + [("home.event_spool_failed", self.sent_events(new)[-1][1])])
        self.assertEqual(self.spooled(), ["abuse.mining_suspected-5.json"])  # collected, trimmed out of the body, never sent: still on disk
        self.assertIsNone(self.pending())
        self.poll(new)
        self.assertEqual(self.sent_events(new), [("abuse.mining_suspected", 5)])
        self.assertEqual(self.spooled(), [])

    def test_the_fifth_mining_event_survives_the_rollback_resend_too(self):
        self.prime()
        self.five_mining()
        old = FakeCP("old")
        self.poll(old)
        self.assertEqual(len(old.bodies), 2)  # the extended body was refused 400, then the oldest shape went out
        self.assertEqual(self.sent_events(old, 1), [("abuse.mining_suspected", at) for at in (1, 2, 3, 4)])
        self.assertEqual(self.spooled(), ["abuse.mining_suspected-5.json"])
        self.assertIsNotNone(self.pending())  # the spool-failed report was not in the accepted body: still owed
        new = FakeCP("new")
        self.poll(new)
        self.poll(new)
        self.assertEqual(self.sent_events(new, 0), [("abuse.mining_suspected", 5)])
        self.assertEqual([t for t, _ in self.sent_events(new, 1)], ["home.event_spool_failed"])
        self.assertIsNone(self.pending())

    def test_same_type_other_time_is_not_consumed_by_a_sent_event(self):
        # consumption is keyed by (type, at) and the file: a sent event never takes a file of the same type with another time
        self.five_mining()
        self.spool_event("abuse.mining_suspected", 6)
        cp = FakeCP("old")
        self.poll(cp)
        self.assertEqual(len(self.sent_events(cp)), 5)
        self.assertEqual(self.spooled(), ["abuse.mining_suspected-6.json"])


class TempFiles(NegotiationBase):
    def temps(self, count, age_s=0):
        for number in range(count):
            path = "%s/.abuse.mining_suspected-%d-1.json.tmp" % (self.spool, number)
            open(path, "w").close()
            if age_s:
                os.utime(path, (time.time() - age_s, time.time() - age_s))

    def test_64_leftover_temp_files_do_not_block_a_completed_event(self):
        mc.sweep_stale_temps, real = (lambda *a, **k: None), mc.sweep_stale_temps  # the scan itself, not the sweep, keeps temps out
        self.addCleanup(setattr, mc, "sweep_stale_temps", real)
        self.temps(64)
        self.spool_event("abuse.mining_suspected", 5)
        cp = FakeCP("old")
        self.poll(cp)
        self.assertEqual(self.sent_events(cp), [("abuse.mining_suspected", 5)])

    def test_five_fresh_temps_stay_untouched_and_a_real_event_still_sends(self):
        self.temps(5)
        self.spool_event("abuse.mining_suspected", 5)
        cp = FakeCP("old")
        self.poll(cp)
        self.assertEqual(self.sent_events(cp), [("abuse.mining_suspected", 5)])
        self.assertEqual(len(self.spooled()), 5)  # a write in progress is never swept
        self.assertTrue(all(name.startswith(".") for name in self.spooled()))

    def test_old_temp_files_are_removed_and_young_ones_kept(self):
        self.temps(3, age_s=mc.STALE_TEMP_S + 60)
        open(self.spool + "/.young.json.tmp", "w").close()
        young = time.time()
        os.utime(self.spool + "/.young.json.tmp", (young, young))
        mc.sweep_stale_temps(self.spool, now=young + 5)
        self.assertEqual(self.spooled(), [".young.json.tmp"])
        mc.sweep_stale_temps(self.spool, now=young + mc.STALE_TEMP_S + 5)
        self.assertEqual(self.spooled(), [])

    def test_collect_health_sweeps_the_old_ones_it_meets(self):
        self.temps(2, age_s=mc.STALE_TEMP_S + 60)
        mc.collect_health(events=self.spool)
        self.assertEqual(self.spooled(), [])


class SpoolFailedDurable(NegotiationBase):
    def setUp(self):
        super().setUp()
        self.now = [1_000]
        real = mc.time.time
        mc.time.time = lambda: self.now[0] / 1000
        self.addCleanup(setattr, mc.time, "time", real)

    def probe(self, failures, instance=None):
        def answer(origin):
            if failures is None:
                return None
            report = {"ok": True, "spoolFailures": failures}
            if instance is not None:
                report["instance"] = instance
            return report
        self.context["appProbe"] = answer

    def reboot(self):
        self.context = {"appProbe": self.context["appProbe"], "bootId": lambda: None, "spoolStatePath": self.state_path}

    def test_a_reboot_neither_loses_nor_duplicates_the_pending_report(self):
        self.probe(2)
        old = FakeCP("old")
        self.poll(old)                       # prod does not take it: owed, on disk
        self.assertEqual(self.pending(), 1000)
        self.reboot()
        self.now[0] = 9_000
        new = FakeCP("new")
        self.poll(new)                       # advertisement learned (a fresh daemon)
        self.assertEqual(self.sent_events(new), [])
        self.poll(new)
        self.assertEqual(self.sent_events(new), [("home.event_spool_failed", 1000)])  # lost? no. and its time is the first rise
        self.reboot()
        self.poll(new)
        self.poll(new)
        self.assertEqual([b for b in new.bodies if self.events_of(b)], [new.bodies[1]])  # not sent again after another reboot

    @staticmethod
    def events_of(body):
        return (body.get("health") or {}).get("events", [])

    def test_a_failed_probe_never_re_emits(self):
        self.probe(1)
        new = FakeCP("new")
        self.poll(new)
        self.poll(new)
        self.assertEqual([t for t, _ in self.sent_events(new)], ["home.event_spool_failed"])
        self.probe(None)                     # one failed app probe
        self.poll(new)
        self.probe(1)                        # the unchanged counter again
        self.now[0] = 5_000
        self.poll(new)
        self.poll(new)
        self.assertEqual([b for b in new.bodies if self.events_of(b)], [new.bodies[1]])

    def test_the_time_is_the_first_rise_and_a_restarted_counter_can_raise_again(self):
        self.probe(1)
        old = FakeCP("old")
        self.poll(old)
        self.now[0] = 2_000
        self.probe(3)
        self.poll(old)
        self.assertEqual(self.pending(), 1000)   # a second rise while owed keeps the first time
        new = FakeCP("new")
        self.poll(new)
        self.poll(new)
        self.assertEqual(self.sent_events(new), [("home.event_spool_failed", 1000)])
        self.probe(0)                            # the app restarted its counter
        self.poll(new)
        self.probe(1)
        self.now[0] = 7_000
        self.poll(new)
        self.poll(new)
        self.assertEqual(self.sent_events(new, -2) + self.sent_events(new, -1), [("home.event_spool_failed", 7000)])


    # Astra r2 M2: the counter is the app's and restarts with the app; it is kept with the app instance id it came from.
    def delivered_once(self, count, instance):
        self.probe(count, instance)
        new = FakeCP("new")
        self.poll(new)
        self.poll(new)
        self.assertEqual([t for t, _ in self.sent_events(new)], ["home.event_spool_failed"])
        self.assertIsNone(self.pending())
        return new

    def test_reboot_between_failures_a_new_instance_at_count_one_still_reports(self):
        self.delivered_once(1, "A" * 16)                     # failure 1 delivered, durable {seen 1, pending None}
        self.reboot()                                        # the app counter resets and its instance id changes
        self.probe(1, "B" * 16)                              # failure 2 brings the NEW counter to 1, the same number as the persisted one
        self.now[0] = 8_000
        new = FakeCP("new")
        self.poll(new)
        self.poll(new)
        self.assertEqual(self.sent_events(new), [("home.event_spool_failed", 8000)])

    def test_reboot_between_failures_a_lower_count_in_a_new_instance_still_reports(self):
        self.delivered_once(3, "A" * 16)
        self.reboot()
        self.probe(1, "B" * 16)                              # lower than the persisted 3
        self.now[0] = 8_000
        new = FakeCP("new")
        self.poll(new)
        self.poll(new)
        self.assertEqual(self.sent_events(new), [("home.event_spool_failed", 8000)])

    def test_the_same_instance_and_count_is_not_reported_again_and_the_instance_is_persisted(self):
        new = self.delivered_once(2, "A" * 16)
        self.assertEqual(json.load(open(self.state_path))["instance"], "A" * 16)
        self.reboot()
        self.probe(2, "A" * 16)
        self.now[0] = 8_000
        before = len([b for b in new.bodies if self.events_of(b)])
        self.poll(new)
        self.poll(new)
        self.assertIsNone(self.pending())
        self.assertEqual(len([b for b in new.bodies if self.events_of(b)]), before)   # nothing is sent a second time

    def test_a_failed_write_leaves_memory_newer_than_a_stale_file(self):
        with open(self.state_path, "w") as handle:
            json.dump({"seen": 0, "pending": None, "instance": None}, handle)
        context = {"spoolDirty": True, "spoolState": {"seen": 5, "pending": 9, "instance": "A" * 16}}
        self.assertEqual(mc.load_spool_state(self.state_path, context), {"seen": 5, "pending": 9, "instance": "A" * 16})
        self.assertEqual(mc.load_spool_state(self.state_path, {})["seen"], 0)             # once written, the file is what counts


class SpoolStatePlacement(NegotiationBase):
    """Astra r2 M1: the state sits in the directory systemd creates (StateDirectory=), never in the lazily made events folder."""
    def test_the_state_path_is_in_the_service_created_state_directory(self):
        unit = pathlib.Path(__file__).with_name("murage-control.service").read_text()
        self.assertIn("ProtectSystem=strict", unit)
        self.assertIn("\nStateDirectory=murage-control\n", unit)
        self.assertEqual(mc.CONTROL_STATE, "/var/lib/murage-control")
        self.assertEqual(mc.SPOOL_STATE_PATH, "/var/lib/murage-control/spool-failed-state.json")
        for lazy in ("/var/lib/murage-home", "/data/.murage-events", "/data/.murage-health"):
            self.assertFalse(mc.SPOOL_STATE_PATH.startswith(lazy), lazy)

    def test_the_default_state_is_written_there_while_the_events_folder_does_not_exist(self):
        state_dir = self.tmp.name + "/state"
        os.mkdir(state_dir)                                  # what systemd made before the daemon started
        saved = mc.SPOOL_STATE_PATH, mc.EVENTS
        mc.SPOOL_STATE_PATH, mc.EVENTS = state_dir + "/spool-failed-state.json", self.tmp.name + "/never-made/events"
        self.addCleanup(lambda: setattr(mc, "SPOOL_STATE_PATH", saved[0]) or setattr(mc, "EVENTS", saved[1]))
        del self.context["spoolStatePath"]
        self.context["appProbe"] = lambda origin: {"ok": True, "spoolFailures": 2, "instance": "A" * 16}
        self.poll(FakeCP("old"))
        with open(state_dir + "/spool-failed-state.json") as handle:
            state = json.load(handle)
        self.assertEqual((state["seen"], type(state["pending"]), state["instance"]), (2, int, "A" * 16))
        self.assertFalse(os.path.exists(self.tmp.name + "/never-made"))

    def test_a_failed_write_is_kept_and_written_on_a_later_poll(self):
        blocker = self.tmp.name + "/blocker"
        open(blocker, "w").close()
        self.context["spoolStatePath"] = blocker + "/sub/state.json"   # its parent is a file: the write cannot succeed
        self.context["appProbe"] = lambda origin: {"ok": True, "spoolFailures": 1, "instance": "A" * 16}
        clock = [1_000]
        def tick():
            clock[0] += 1_000
            return clock[0] / 1000
        real = mc.time.time
        mc.time.time = tick                                  # every read of the clock is a different time
        self.addCleanup(setattr, mc.time, "time", real)
        old = FakeCP("old")
        self.poll(old)
        self.assertTrue(self.context["spoolDirty"])
        self.assertIsNotNone(self.context["spoolState"]["pending"])
        first = self.context["spoolState"]["pending"]
        self.poll(old)                                       # still failing: the owed report is not dropped or restamped
        self.assertEqual(self.context["spoolState"]["pending"], first)
        os.unlink(blocker)
        self.poll(old)
        with open(blocker + "/sub/state.json") as handle:
            self.assertEqual(json.load(handle)["pending"], first)
        self.assertFalse(self.context["spoolDirty"])


miner_loader = importlib.machinery.SourceFileLoader("murage_miner_watch", str(pathlib.Path(__file__).with_name("murage-miner-watch.py")))
miner = importlib.util.module_from_spec(importlib.util.spec_from_loader("murage_miner_watch", miner_loader))
miner_loader.exec_module(miner)


class SweepRace(unittest.TestCase):
    """Astra r2 M3 and surviving mutant 2, for control and the mining writer."""
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = self.tmp.name
        self.path = self.dir + "/.restore.stuck-7.json.tmp"

    def old_temp(self, age=700):
        open(self.path, "w").close()
        os.utime(self.path, (time.time() - age, time.time() - age))

    def sweeps(self):
        return (("control", mc.sweep_stale_temps), ("miner", miner.sweep_stale_temps))

    def test_the_minimum_age_is_ten_minutes_in_every_implementation(self):
        self.assertEqual(mc.STALE_TEMP_S, 600)
        self.assertEqual(miner.STALE_TEMP_S, 600)
        for name, sweep in self.sweeps():
            with self.subTest(name):
                self.old_temp(age=0)
                base = os.lstat(self.path).st_mtime
                sweep(self.dir, now=base + 599)
                self.assertTrue(os.path.exists(self.path))
                sweep(self.dir, now=base + 601)
                self.assertFalse(os.path.exists(self.path))

    def test_a_temp_reopened_at_the_same_name_after_the_first_look_is_not_removed(self):
        for name, sweep in self.sweeps():
            with self.subTest(name):
                self.old_temp()
                def reopen(path):                            # the server sweep removed the old one and its writer opened a fresh file at the name
                    os.unlink(path)
                    open(path, "w").write("fresh")
                sweep(self.dir, between=reopen)
                self.assertEqual(open(self.path).read(), "fresh")
                os.unlink(self.path)

    def test_a_replacement_with_another_identity_is_not_removed_even_if_it_looks_old(self):
        for name, sweep in self.sweeps():
            with self.subTest(name):
                self.old_temp()
                def swap(path):
                    other = self.dir + "/other"
                    open(other, "w").write("other")
                    os.utime(other, (time.time() - 700, time.time() - 700))
                    os.rename(other, path)                   # a different inode, still old by its time
                sweep(self.dir, between=swap)
                self.assertEqual(open(self.path).read(), "other")
                os.unlink(self.path)

    def test_the_same_file_written_afresh_after_the_first_look_is_not_removed(self):
        for name, sweep in self.sweeps():
            with self.subTest(name):
                self.old_temp()
                def rewrite(path):                           # same inode, now young: a write in progress
                    with open(path, "w") as handle:
                        handle.write("again")
                sweep(self.dir, between=rewrite)
                self.assertEqual(open(self.path).read(), "again")
                os.unlink(self.path)

    def test_an_old_untouched_temp_is_still_removed(self):
        for name, sweep in self.sweeps():
            with self.subTest(name):
                self.old_temp()
                sweep(self.dir)
                self.assertFalse(os.path.exists(self.path))

    def test_temp_names_are_never_reused(self):
        names = []
        real = os.replace
        def spy(src, dst):
            names.append(os.path.basename(src))
            return real(src, dst)
        os.replace = spy
        self.addCleanup(setattr, os, "replace", real)
        miner.write_event(5, 1000, self.dir)
        miner.write_event(5, 1000, self.dir)                 # the same pid and time twice
        context = {}
        mc.save_spool_state(self.dir + "/s.json", {"seen": 0, "pending": None, "instance": None}, context)
        mc.save_spool_state(self.dir + "/s.json", {"seen": 0, "pending": None, "instance": None}, context)
        self.assertEqual(len(names), 4)
        self.assertEqual(len(set(names)), 4, names)
        self.assertTrue(all(n.startswith(".") and n.endswith(".tmp") and str(os.getpid()) in n for n in names), names)


_old_loader = importlib.machinery.SourceFileLoader("murage_control_1018", str(pathlib.Path(__file__).with_name("testdata") / "murage-control-20f95f742a.py"))
old_home = importlib.util.module_from_spec(importlib.util.spec_from_loader("murage_control_1018", _old_loader))
_old_loader.exec_module(old_home)


class Released1018HomeAgainstNewControlPlane(NegotiationBase):
    """testdata/murage-control-20f95f742a.py is the murage-control built into the live pool images (murage/build=20f95f742a, x86 image 451878214 and arm image 451877100), byte for byte (git show 20f95f742a:deploy/cloud-home/murage-control).
    Its strict ack validation (set(heartbeat) == {wire, accepted}, or exactly wire/accepted/generation/evidenceEpoch) must accept what the new control
    plane answers, header included, and the new control plane must accept what it sends."""
    def setUp(self):
        super().setUp()
        saved = {name: getattr(old_home, name) for name in ("EVENTS", "validate_desired", "sample_clock", "clocks_match", "fence")}
        for name, value in saved.items():
            self.addCleanup(setattr, old_home, name, value)
        old_home.EVENTS = self.spool
        old_home.validate_desired = mc.validate_desired
        old_home.sample_clock = mc.sample_clock
        old_home.clocks_match = mc.clocks_match
        old_home.fence = mc.fence

    def poll(self, cp):
        return old_home.poll_once(self.binding, self.context, cp, lambda: {}, self.tmp.name + "/public", os.getuid(), lambda *a: None)

    def test_old_home_accepts_new_cp_ack_with_header_and_both_ack_shapes(self):
        for epoch in (False, True):
            cp = FakeCP("new", epoch=epoch)
            self.context.clear()
            self.context.update({"appProbe": lambda origin: None, "bootId": lambda: None})
            self.spool_event("abuse.mining_suspected", 61 + epoch)
            self.spool_event("restore.stuck", 71 + epoch)  # a 1.0.18 home does not know this type: it never reads it
            self.poll(cp)
            self.poll(cp)
            self.assertTrue(all(old_prod_accepts(body) for body in cp.bodies))
            self.assertEqual(self.sent_events(cp, 0), [("abuse.mining_suspected", 61 + epoch)])
            self.assertEqual(len(cp.bodies), 2)

    def test_emit_bodies(self):
        out = os.environ.get("MC_BODIES_OUT_1018")
        if not out:
            self.skipTest("fixture generation only")
        cp = FakeCP("new")
        self.spool_event("abuse.mining_suspected", 5)
        self.poll(cp)
        json.dump({"release1018": cp.bodies}, open(out, "w"), indent=1, sort_keys=True)


# ======================================================================================================================================
# J5b r7 RED corpus (DESIGN-J5b-r7.md sections 1, 6, 8): P4b P5b P6b P7c P17 to P27 (P26 and P27 are MurageMain's r7 rulings 7 and 8). Skeletons written ahead of the build: each runs the real
# `run` loop of murage-control in a child process (qualify/control-deployed-harness.py) against an in-test app (a real http.server serving
# /api/health) and a file-based control plane mock, and asserts through files only: the control's journal (CONTROL_STATE/home-events.journal),
# the ACK file (PUBLIC/home-events-ack.json) and the heartbeat bodies the mock logged. Base runs the same call shapes and fails on the missing
# behavior (no intake, no journal, no ACK file, no app item ever sent), never on a signature error.
# Interface assumptions the builders must keep or tell the reviewer about (the design is silent): app_report puts the parsed field at
# report["homeEvents"] = {"items": [...], "outboxDegraded": N}; the ACK file is written with control=1 before the first intake pass.
# ======================================================================================================================================
import hashlib
import http.server
import re
import shutil
import signal
import subprocess
import sys
import threading
import zlib

HERE = pathlib.Path(__file__).resolve().parent
HARNESS = HERE / "qualify" / "control-deployed-harness.py"
RECORDS = HERE / "testdata" / "j5b-records"
HEALTH = HERE.parent.parent / "testdata" / "j5b-health"
BASE_AT = 1_800_000_000_000
FAILURE = "home.event_spool_failed"
# The channel caps (DESIGN-J5b-r7.md section 1, r6-M1). The real limits: atomic_public refuses a public file over 16384 bytes (murage-control:317) and
# the app's readHomePublicMetadata refuses one over 16384 (server/cloud-home/b1b-identity.ts:15-18). A 16 hex id costs 19 bytes in a JSON list, so the
# ACK file holds at most 512 distinct ids IN TOTAL across `acked` and `accepted` (disjoint lists): worst case 9,788 bytes.
ACK_FILE_MAX_BYTES = 16384
ACK_IDS_MAX = 512
DIRTY_MAX = 32
HEX16 = re.compile(r"^[0-9a-f]{16}$")
ACK_DIR = HERE.parent.parent / "testdata" / "j5b-ack"


def crc_hex(raw):
    return "%08x" % (zlib.crc32(raw) & 0xFFFFFFFF)


def record_line(ops):
    raw = json.dumps({"v": 1, "ops": ops}, separators=(",", ":")).encode()
    return crc_hex(raw).encode() + b" " + raw + b"\n"


def read_records(path):
    """The valid prefix of a record file: (list of op lists, byte length of the prefix, True when every byte was part of a valid line)."""
    try:
        data = pathlib.Path(path).read_bytes()
    except OSError:
        return [], 0, True
    records, offset = [], 0
    while offset < len(data):
        end = data.find(b"\n", offset)
        if end < 0:
            return records, offset, False
        line = data[offset:end]
        crc, _, raw = line.partition(b" ")
        if crc != crc_hex(raw).encode():
            return records, offset, False
        try:
            records.append(json.loads(raw)["ops"])
        except (ValueError, KeyError):
            return records, offset, False
        offset = end + 1
    return records, offset, True


def journal_state(path):
    """Replays the journal: ids by (type, at), the pending keys (added, not sent, not dropped), all add ops in order."""
    records, _, _ = read_records(path)
    ids, pending, adds = {}, {}, []
    for ops in records:
        for op in ops:
            key = (op.get("type"), op.get("at"))
            if op["r"] == "add":
                ids[op["id"]] = key
                pending[key] = op["id"]
                adds.append(op)
            elif op["r"] in ("sent", "drop"):
                pending.pop(key, None)
    return {"ids": ids, "pending": pending, "adds": adds}


def item(n, type_="restore.aborted"):
    return {"id": "%016x" % n, "type": type_, "at": BASE_AT + n}


def hid(tag, n):
    return hashlib.sha256(("%s\0%d" % (tag, n)).encode()).hexdigest()[:16]


def wait_for(predicate, timeout=8.0, step=0.02):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(step)
    return predicate()


class AppFixture:
    """A real http.server standing in for the app's /api/health. follow drops every id the ACK file lists as acked or accepted, as the app does."""
    def __init__(self, ack_path, follow=True):
        self.items, self.degraded, self.follow, self.ack_path = [], 0, follow, ack_path
        self.requests, self.first_ack, self.degraded_budget = 0, None, None
        fixture = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(handler):
                fixture.requests += 1
                ack = fixture.read_ack()
                if fixture.first_ack is None:
                    fixture.first_ack = ack if ack is not None else {"absent": True}
                gone = (set(ack.get("acked", [])) | set(ack.get("accepted", []))) if (ack and fixture.follow) else set()
                shown = [row for row in fixture.items if row["id"] not in gone][:32]
                served_degraded = fixture.degraded
                if fixture.degraded_budget is not None:
                    served_degraded = 2 if fixture.degraded_budget > 0 else 0
                    fixture.degraded_budget -= 1
                body = {"app": "murage", "instance": "i" * 16, "eventSpoolFailures": 0,
                        "homeEvents": {"v": 1, "items": shown, "outboxDegraded": served_degraded}}
                raw = json.dumps(body).encode()
                handler.send_response(200)
                handler.send_header("Content-Type", "application/json")
                handler.send_header("Content-Length", str(len(raw)))
                handler.end_headers()
                handler.wfile.write(raw)

            def log_message(handler, *args):
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = "http://127.0.0.1:%d/api/health" % self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def read_ack(self):
        try:
            return json.loads(pathlib.Path(self.ack_path).read_text())
        except (OSError, ValueError):
            return None

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class ControlRig(unittest.TestCase):
    SCALE = "400"

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="j5b-", dir=str(HERE))
        os.chmod(self.root, 0o755)
        for name in ("ctl", "state", "run", "events"):
            os.mkdir(self.root + "/" + name, 0o755)
        self.addCleanup(shutil.rmtree, self.root, True)
        self.ack_path = self.root + "/run/home-events-ack.json"
        self.journal = self.root + "/state/home-events.journal"
        self.app = AppFixture(self.ack_path)
        self.addCleanup(self.app.close)
        self.procs = []
        self.addCleanup(self.stop_all)

    def start(self, **extra):
        env = dict(os.environ, J5B_ROOT=self.root, J5B_APP_URL=self.app.url, J5B_SCALE=self.SCALE, J5B_UNIT="1")
        env.update(extra)
        log = open(self.root + "/harness-%d.log" % len(self.procs), "wb")
        proc = subprocess.Popen([sys.executable, "-I", str(HARNESS)], env=env, stdout=log, stderr=log, stdin=subprocess.DEVNULL)
        self.procs.append(proc)
        before = self.app.requests
        if not wait_for(lambda: self.app.requests > before or proc.poll() is not None, timeout=10) or proc.poll() is not None:
            self.fail("the harness did not reach its first app probe (a rig fault, not a RED): " + open(log.name, errors="replace").read()[-600:])
        return proc

    def kill(self, proc):
        proc.send_signal(signal.SIGKILL)
        proc.wait()

    def stop_all(self):
        for proc in self.procs:
            if proc.poll() is None:
                proc.send_signal(signal.SIGKILL)
                proc.wait()

    def fault(self, name, content=""):
        pathlib.Path(self.root + "/ctl/" + name).write_text(content)

    def clear(self, name):
        try:
            os.unlink(self.root + "/ctl/" + name)
        except OSError:
            pass

    def ack(self):
        return self.app.read_ack()

    def bodies(self):
        try:
            return [json.loads(line) for line in pathlib.Path(self.root + "/cp-bodies.jsonl").read_text().splitlines()]
        except OSError:
            return []

    @staticmethod
    def keys_of(row):
        return [(event["type"], event["at"]) for event in ((row["body"] or {}).get("health") or {}).get("events", [])]

    def accepted_keys(self):
        """Event keys of every heartbeat the mock accepted, in acceptance order (a key sent twice appears twice)."""
        return [key for row in self.bodies() if row["status"] == "ok" for key in self.keys_of(row)]

    def preload_journal(self, lines):
        pathlib.Path(self.journal).write_bytes(b"".join(lines))


class P4bIntakeDuringBlockedCall(ControlRig):
    def test_intake_runs_during_blocked_cp_call(self):
        # The request mock blocks inside _poll_once (hold-heartbeat); intake must journal and ACK the offered item anyway.
        self.fault("hold-heartbeat")
        row = item(1)
        self.app.items = [row]
        self.start()
        acked = wait_for(lambda: row["id"] in ((self.ack() or {}).get("acked") or []), timeout=5)
        self.assertTrue(acked, "the id was never ACKed while the CP call was blocked: no intake thread (base has no ACK file)")
        self.assertIn(row["id"], journal_state(self.journal)["ids"], "the add is not in the journal")
        self.assertEqual(self.bodies(), [], "the heartbeat was supposed to be blocked for the whole test")


class P5bMemoryOnlyRetrySameKey(ControlRig):
    def test_memory_only_retry_same_key(self):
        # DESIGN 8.3 (r7). The journal refuses writes, the app serves K with outboxDegraded 1. Heartbeat 0 is accepted and advertises the types.
        # Body 1 (advertised by the accepted answer before it) carries K and is answered 503; body 2 carries NO extended event and is answered accepted
        # with the advertisement; body 3 carries K with the same (type, at) and is accepted. A heartbeat sent without advertisement leaves K pending.
        k = item(7)
        key = (k["type"], k["at"])
        self.app.items, self.app.degraded = [k], 1
        self.fault("fault-journal-erofs")
        self.fault("cp-script.json", json.dumps(["ok", "503", "ok", "ok", "ok", "ok", "ok", "ok"]))
        self.start()
        wait_for(lambda: len(self.bodies()) >= 4 and any(row["status"] == "ok" and key in self.keys_of(row) for row in self.bodies()), timeout=8)
        rows = self.bodies()
        self.assertGreaterEqual(len(rows), 4, "fewer than four heartbeats were sent")
        self.assertIn(key, self.keys_of(rows[1]), "body 1 (the heartbeat after the advertisement) carries no K: base never offers an app item")
        self.assertEqual(rows[1]["status"], "503")
        self.assertEqual(self.keys_of(rows[2]), [], "body 2, sent without an advertisement, must carry no extended event (K stays pending)")
        self.assertEqual(rows[2]["status"], "ok")
        self.assertEqual(self.keys_of(rows[3]).count(key), 1, "body 3 must carry K again with the same (type, at)")
        self.assertEqual(rows[3]["status"], "ok")
        self.assertNotIn(k["id"], (self.ack() or {}).get("acked", []), "a journal that refuses writes must not ACK as durable")
        self.assertTrue(wait_for(lambda: k["id"] in ((self.ack() or {}).get("accepted") or []), timeout=5), "accepted never lists K after the accepting body")
        self.clear("fault-journal-erofs")
        ops = lambda: [op for rec in read_records(self.journal)[0] for op in rec]
        self.assertTrue(wait_for(lambda: any(op["r"] == "add" and op["id"] == k["id"] for op in ops()) and any(op["r"] == "sent" and (op["type"], op["at"]) == key for op in ops()), timeout=5),
                        "once the journal accepts writes, add K and sent K must land with the same key")
        self.assertEqual(sum(1 for op in ops() if op["r"] == "add" and op["id"] == k["id"]), 1)
        self.assertEqual(self.accepted_keys().count(key), 1, "the CP mock must record one key")


class P6bOfferedIdsAckedFirst(ControlRig):
    def test_offered_ids_acked_first(self):
        # 700 retained ids (a reachable set, inside the 64 + 3 x 256 = 832 bound); the app offers the OLDEST, older than the newest 512. It must be listed.
        lines, order = [], []
        for n in range(700):
            row = item(1000 + n, ("restore.aborted", "restore.stuck", FAILURE)[n % 3])
            order.append(row)
            lines.append(record_line([{"r": "add", "id": row["id"], "type": row["type"], "at": row["at"]}, {"r": "sent", "type": row["type"], "at": row["at"]}]))
        self.preload_journal(lines)
        oldest = order[0]
        self.app.items = [oldest]
        self.app.follow = False
        self.start()
        self.assertTrue(wait_for(lambda: oldest["id"] in ((self.ack() or {}).get("acked") or []), timeout=5),
                        "the offered id older than the newest 512 was not listed (base writes no ACK file)")
        ack = self.ack()
        self.assertEqual(len(ack["acked"]) + len(ack["accepted"]), ACK_IDS_MAX, "exactly 512 distinct ids in total")
        self.assertFalse(set(ack["acked"]) & set(ack["accepted"]), "the lists are disjoint")
        self.assertTrue(all(HEX16.match(i) for i in ack["acked"] + ack["accepted"]))
        self.assertLessEqual(os.path.getsize(self.ack_path), ACK_FILE_MAX_BYTES, "the ACK file is larger than the channel can write or the app can read")
        self.assertEqual(ack["acked"][0], oldest["id"], "ids in the latest app report come first")
        self.assertEqual(ack["control"], 1)


class P7cReassignedKeySentOnlyAfterDurableAdd(ControlRig):
    def test_reassigned_key_sent_only_after_durable_add(self):
        # Rule S (r6-M3 control half). A control failure item F is durable and sent at (FAILURE, T); the app offers its own failure item G at the same
        # (FAILURE, T). Control reassigns G to T+1, and the journal refuses writes: nothing may carry G's key until G's add (with T+1) is durable.
        t = BASE_AT + 777
        f = {"id": "%016x" % 0xF1, "type": FAILURE, "at": t}
        g = {"id": "%016x" % 0x61, "type": FAILURE, "at": t}
        self.preload_journal([record_line([{"r": "add", **f}, {"r": "sent", "type": FAILURE, "at": t}])])
        self.app.items = [g]
        self.fault("fault-journal-erofs")
        self.start()
        wait_for(lambda: len(self.bodies()) >= 8, timeout=6)
        held = [self.keys_of(row) for row in self.bodies()]
        self.assertNotIn((FAILURE, t + 1), [key for keys in held for key in keys], "G went out at T+1 before its add was durable (rule S)")
        self.assertNotIn((FAILURE, t), [key for keys in held for key in keys], "G went out at the colliding key T")
        self.clear("fault-journal-erofs")
        self.assertTrue(wait_for(lambda: (FAILURE, t + 1) in self.accepted_keys(), timeout=8), "G was never delivered at T+1: base never delivers an app item")
        adds = [op for op in journal_state(self.journal)["adds"] if op["id"] == g["id"]]
        self.assertEqual([(op["type"], op["at"]) for op in adds], [(FAILURE, t + 1)], "the add of G carries the reassigned at")
        for row in self.bodies():
            if (FAILURE, t + 1) in self.keys_of(row):
                self.assertIn([g["id"], FAILURE, t + 1], row.get("journal_adds", []), "a body carried (FAILURE, T+1) before G's add with T+1 was durable")


class P17AdvertisementBeforeFirstIntake(ControlRig):
    def test_advertisement_before_first_intake(self):
        self.app.items = [item(3)]
        self.start()
        self.assertTrue(wait_for(lambda: self.app.first_ack is not None, timeout=5), "the control never probed the app")
        first = self.app.first_ack
        self.assertNotIn("absent", first, "at the first probe the ACK file did not exist: the advertisement must be written before the first intake (base writes no ACK file)")
        self.assertEqual(first.get("control"), 1)
        self.assertEqual(first.get("acked"), [])
        self.assertEqual(first.get("accepted"), [])
        self.assertEqual(set(first), {"v", "control", "acked", "accepted"})


class P18DirtyBound(ControlRig):
    def test_dirty_bound_crash_resend_within_cp_window(self):
        # sent appends fail with ENOSPC while the CP accepts. The body capacity is min(MAX_EVENTS, DIRTY_MAX - dirty): at 30 dirty the next body carries
        # at most 2 new extended events, and dirty never exceeds 32. After a SIGKILL every resent key is among the CP mock's 128 newest by seq.
        self.app.items = [item(n) for n in range(1, 41)]
        self.fault("fault-sent-enospc")
        proc = self.start()
        self.assertTrue(wait_for(lambda: len(set(self.accepted_keys())) >= 30, timeout=8), "30 keys were never accepted: base never sends an app item")
        wait_for(lambda: len(self.bodies()) >= 40 and len(set(self.accepted_keys())) >= 32, timeout=8)
        count = len(self.bodies())
        wait_for(lambda: len(self.bodies()) >= count + 6, timeout=5)
        seen, levels = [], []
        for row in self.bodies():
            if row["status"] != "ok":
                continue
            new = [key for key in self.keys_of(row) if key not in seen]
            levels.append((len(seen), len(new)))
            self.assertLessEqual(len(seen) + len(new), DIRTY_MAX, "a body took dirty past 32 (level %d, %d new)" % (len(seen), len(new)))
            seen.extend(new)
        at30 = [new for dirty, new in levels if dirty >= 30]
        self.assertTrue(all(new <= 2 for new in at30), "at 30 dirty a body carried more than 2 new extended events (%r)" % levels)
        self.assertEqual(len(seen), DIRTY_MAX, "the capacity rule must still let dirty reach exactly 32")
        before = self.accepted_keys()
        self.kill(proc)
        self.clear("fault-sent-enospc")
        mark = len(self.bodies())
        self.start()
        wait_for(lambda: len(self.bodies()) >= mark + 4, timeout=6)
        after = [key for row in self.bodies()[mark:] if row["status"] == "ok" for key in self.keys_of(row)]
        window = list(dict.fromkeys(before))[-128:]
        self.assertTrue(after and set(after) & set(before) <= set(window), "a resent key is outside the CP's 128 newest by acceptance order")


class P19ControlFailureSlot(ControlRig):
    def test_control_failure_slot_replaces(self):
        # The CP refuses everything so pending fills; 100 items force several overflows. Pending never passes 63 + 1, exactly one failure entry is
        # pending, and each overflow is a NEW key (nothing folds).
        self.app.items = [item(n) for n in range(1, 101)]
        self.fault("cp-default", "503")
        self.start()
        failure_adds = lambda: [op for op in journal_state(self.journal)["adds"] if op["type"] == FAILURE]
        self.assertTrue(wait_for(lambda: len(failure_adds()) >= 2, timeout=10), "fewer than two failure items were written (base has no journal)")
        pending = journal_state(self.journal)["pending"]
        self.assertLessEqual(len(pending), 64)
        self.assertEqual(len([key for key in pending if key[0] == FAILURE]), 1, "exactly one failure entry may be pending")
        self.assertLessEqual(len([key for key in pending if key[0] != FAILURE]), 63)
        keys = [(op["type"], op["at"]) for op in failure_adds()]
        self.assertEqual(len(keys), len(set(keys)), "an overflow reused a failure key instead of writing a new one")
        ids = [op["id"] for op in failure_adds()]
        self.assertEqual(len(ids), len(set(ids)))
        # accepted while sent is not durable: the failure key still reaches the CP (no folding into an entry already taken)
        self.clear("cp-default")
        self.fault("fault-sent-enospc")
        self.assertTrue(wait_for(lambda: any(key[0] == FAILURE for key in self.accepted_keys()), timeout=8), "no failure key was ever accepted")


class P20PartialAppendRepaired(ControlRig):
    def test_partial_append_repaired_in_process(self):
        a, b = item(11), item(12)
        self.app.items = [a, b]
        self.fault("fault-short-write", "7")
        first = self.start()
        time.sleep(0.5)
        self.assertNotIn(a["id"], (self.ack() or {}).get("acked", []), "nothing may be ACKed while the append is failing")
        self.clear("fault-short-write")
        self.assertTrue(wait_for(lambda: {a["id"], b["id"]} <= set((self.ack() or {}).get("acked") or []), timeout=6),
                        "space returned without a restart but the records were never appended and ACKed (base writes no ACK file)")
        records, size, clean = read_records(self.journal)
        self.assertTrue(clean, "the journal holds a partial line: the failed append was not repaired before the next one")
        self.assertEqual(sorted(op["id"] for rec in records for op in rec if op["r"] == "add"), sorted([a["id"], b["id"]]))
        self.kill(first)
        self.start()
        keys = [(a["type"], a["at"]), (b["type"], b["at"])]
        wait_for(lambda: all(key in self.accepted_keys() for key in keys), timeout=6)
        for key in keys:
            self.assertEqual(self.accepted_keys().count(key), 1, "the ACKed event must reach the CP exactly once")


class P21OverflowRecordCut(ControlRig):
    def test_overflow_record_cut(self):
        # r7: P21 keeps the cut and MU-64 only. The CP refuses everything so 63 entries pend; the 64th item makes the overflow record (drop oldest + add
        # failure). The process is cut one byte short of that record (STALL barrier, bounded 30 s and non-fatal: on timeout the test goes on to its
        # behavioral assertion). After the restart the half record is gone and, once the CP accepts, the old entry or the failure item arrives.
        self.app.items = [item(n) for n in range(1, 66)]
        oldest = (self.app.items[0]["type"], self.app.items[0]["at"])
        self.fault("cp-default", "503")
        self.fault("fault-stall-overflow")
        proc = self.start()
        wait_for(lambda: os.path.exists(self.root + "/barrier-overflow_record_written"), timeout=30)
        self.kill(proc)
        self.clear("fault-stall-overflow")
        self.clear("cp-default")
        self.start()
        self.assertTrue(wait_for(lambda: self.ack() is not None, timeout=5), "no ACK file (base has no journal)")
        self.assertTrue(read_records(self.journal)[2], "the half-written overflow record survived the restart")
        self.assertTrue(wait_for(lambda: oldest in self.accepted_keys() or any(key[0] == FAILURE for key in self.accepted_keys()), timeout=10),
                        "neither the retired entry nor its replacing failure item reached the CP (base never delivers an app item)")


class P21bOverflowAppendFailsNothingRetired(ControlRig):
    def test_overflow_append_fails_nothing_retired(self):
        # r7 (kills MU-15, no crash: SIGKILL would erase a memory-only retirement). 63 entries are pending; the overflow record append raises ENOSPC.
        # The oldest entry must stay pending and be attempted at the CP when advertised, the new item must not be ACKed. When space returns:
        # ONE overflow record, then the failure key.
        first = [item(n) for n in range(1, 64)]
        self.app.items = list(first)
        self.fault("cp-script.json", json.dumps(["ok"]))
        self.fault("cp-default", "503")
        self.start()
        self.assertTrue(wait_for(lambda: len(journal_state(self.journal)["pending"]) >= 63, timeout=10), "63 entries never became pending (base has no journal)")
        oldest = (first[0]["type"], first[0]["at"])
        extra = item(64)
        self.fault("fault-overflow-enospc")
        self.app.items = [extra]
        time.sleep(0.6)
        self.assertNotIn(extra["id"], (self.ack() or {}).get("acked", []), "the new item was ACKed although its overflow record could not be written")
        self.assertIn(oldest, journal_state(self.journal)["pending"], "the oldest entry left pending while the overflow record failed (retired in memory)")
        ops = [op for rec in read_records(self.journal)[0] for op in rec]
        self.assertFalse([op for op in ops if op["r"] == "drop"], "a drop was written although the overflow record failed")
        self.assertTrue(wait_for(lambda: any(oldest in self.keys_of(row) for row in self.bodies()), timeout=8), "the oldest entry never reached the CP mock (base never delivers an app item)")
        self.clear("fault-overflow-enospc")
        self.clear("cp-default")
        overflow = lambda: [rec for rec in read_records(self.journal)[0] if any(op["r"] == "drop" for op in rec) and any(op["r"] == "add" and op["type"] == FAILURE for op in rec)]
        self.assertTrue(wait_for(lambda: len(overflow()) >= 1, timeout=8), "no overflow record once space returned")
        self.assertEqual(len(overflow()), 1, "exactly one overflow record")
        self.assertTrue(wait_for(lambda: any(key[0] == FAILURE for key in self.accepted_keys()), timeout=8), "the failure key never reached the CP")


class P22ChecksumEndsValidPrefix(ControlRig):
    def test_flipped_byte_ends_the_valid_prefix(self):
        manifest = json.loads((RECORDS / "manifest.json").read_text())["flipped-byte.txt"]
        shutil.copyfile(RECORDS / "flipped-byte.txt", self.journal)
        self.start()
        self.assertTrue(wait_for(lambda: self.ack() is not None, timeout=5), "no ACK file (base has no journal load)")
        self.assertTrue(wait_for(lambda: os.path.getsize(self.journal) == manifest["valid_prefix_bytes"], timeout=3),
                        "the journal was not truncated to its valid prefix")
        ack = self.ack()
        listed = set(ack["acked"]) | set(ack["accepted"])
        for later in manifest["ids_after_bad_line"]:
            self.assertNotIn(later, listed, "a record written after the corrupt line must not be loaded")
        self.assertTrue(set(manifest["ids_in_prefix"]) <= listed, "ids of the valid prefix must still be ACKed")
        self.assertEqual(set(manifest["ids_in_prefix"]), set(journal_state(self.journal)["ids"]))


class P23StrictParserOnFixtureBodies(unittest.TestCase):
    def test_strict_parser_on_fixture_bodies(self):
        manifest = json.loads((HEALTH / "manifest.json").read_text())
        names = [name for name in manifest if name.startswith("body-")]
        self.assertTrue(names)
        for name in names:
            expect = manifest[name]
            report = mc.app_report("https://home.example", opener=FakeOpener((HEALTH / name).read_bytes()))
            field = report.get("homeEvents")
            self.assertTrue(report["ok"], name)
            if expect["valid"]:
                self.assertIsNotNone(field, "%s: the strict parser dropped a valid homeEvents field (base has none)" % name)
                self.assertEqual(len(field["items"]), expect["items"], name)
                self.assertEqual(field["outboxDegraded"], expect["outboxDegraded"], name)
            else:
                self.assertFalse(field, "%s: the strict parser kept an invalid homeEvents field" % name)


class GRecordFixturesGuard(unittest.TestCase):
    """GUARD G-VEC (r7 renamed it from P24; passes at base by design): the shared CRC32 line vectors, `done` tombstone vectors included, read the same here as in the node tests."""
    def test_fixture_vectors_read_the_same_way_here_and_in_node(self):
        manifest = json.loads((RECORDS / "manifest.json").read_text())
        for name, expect in manifest.items():
            records, size, clean = read_records(RECORDS / name)
            self.assertEqual(len(records), expect["valid_prefix_lines"], name)
            self.assertEqual(size, expect["valid_prefix_bytes"], name)
            self.assertEqual(clean, expect["clean"], name)


class P24SentRecordsPrefixClosed(ControlRig):
    def test_sent_records_prefix_closed(self):
        # r6-M4. The CP mock accepts K, then L, then M. The harness fails the first two `sent` appends that carry K's key; after every journal fsync it
        # checks that the durable sent keys are a PREFIX of acceptance order and logs any violation (prefix-violations.log). Records are atomic and every
        # `sent` record lists all dirty keys in acceptance order. M is accepted with all `sent` appends failing, then SIGKILL: the restart resends exactly M.
        k, l, m = item(21), item(22), item(23)
        self.fault("fault-sent-key", "%d 2" % k["at"])
        self.app.items = [k]
        proc = self.start()
        self.assertTrue(wait_for(lambda: (k["type"], k["at"]) in self.accepted_keys(), timeout=8), "K was never accepted: base never sends an app item")
        self.app.items = [k, l]
        self.assertTrue(wait_for(lambda: (l["type"], l["at"]) in self.accepted_keys(), timeout=8), "L was never accepted")
        sent_keys = lambda: [(op["type"], op["at"]) for rec in read_records(self.journal)[0] for op in rec if op["r"] == "sent"]
        self.assertTrue(wait_for(lambda: {(k["type"], k["at"]), (l["type"], l["at"])} <= set(sent_keys()), timeout=8), "K and L never became durable sent keys")
        self.fault("fault-sent-enospc")
        self.app.items = [k, l, m]
        self.assertTrue(wait_for(lambda: (m["type"], m["at"]) in self.accepted_keys(), timeout=8), "M was never accepted")
        violations = pathlib.Path(self.root + "/prefix-violations.log")
        self.assertEqual(violations.read_text() if violations.exists() else "", "", "durable sent keys were not a prefix of acceptance order after a fsync")
        self.kill(proc)
        self.clear("fault-sent-enospc")
        mark = len(self.bodies())
        self.start()
        wait_for(lambda: (m["type"], m["at"]) in [key for row in self.bodies()[mark:] if row["status"] == "ok" for key in self.keys_of(row)], timeout=8)
        resent = {key for row in self.bodies()[mark:] if row["status"] == "ok" for key in self.keys_of(row)}
        self.assertEqual(resent, {(m["type"], m["at"])}, "the resent set must equal exactly the non-durable suffix (M)")


class P25AckMaxFitsRealWriter(ControlRig):
    def test_ack_max_fits_real_writer(self):
        # r8 M4. Phase 1 (journal refusing): 512 durable retained ids from earlier (more than the cap, so a per-list cap shows as 544 ids), then the 32 ids of offered-ids.json are offered and accepted from memory
        # (exactly DIRTY_MAX non-durable accepted ids). The REAL atomic_public writes the file: accepted = the 32, acked = 480, 512 in total, disjoint,
        # <= 16,384 bytes (saved to $J5B_ACK_OUT when set: testdata/j5b-ack/max.json). Phase 2: the journal returns; the 32 are in `acked` only, `accepted` is empty.
        offered_ids = json.loads((ACK_DIR / "offered-ids.json").read_text())
        offered = [{"id": i, "type": "restore.aborted", "at": BASE_AT + 5000 + n} for n, i in enumerate(offered_ids)]
        lines = []
        for n in range(512):
            row = item(2000 + n, ("restore.aborted", "restore.stuck", FAILURE)[n % 3])
            lines.append(record_line([{"r": "add", "id": row["id"], "type": row["type"], "at": row["at"]}, {"r": "sent", "type": row["type"], "at": row["at"]}]))
        self.preload_journal(lines)
        self.app.items, self.app.follow = offered, False
        self.fault("fault-journal-erofs")
        self.start()

        def check(ack, where):
            ids = ack["acked"] + ack["accepted"]
            self.assertEqual(len(ids), len(set(ids)), where + ": an id is listed twice")
            self.assertEqual(len(ids), ACK_IDS_MAX, where + ": exactly 512 distinct ids")
            self.assertTrue(all(HEX16.match(i) for i in ids), where)
            self.assertTrue(set(offered_ids) <= set(ids), where + ": an offered id is missing")
            self.assertLessEqual(os.path.getsize(self.ack_path), ACK_FILE_MAX_BYTES, where + ": file above 16,384 bytes")
            self.assertEqual(ack["control"], 1)

        self.assertTrue(wait_for(lambda: set(offered_ids) <= set((self.ack() or {}).get("accepted") or []), timeout=10),
                        "the 32 offered ids never reached `accepted` (base writes no ACK file)")
        ack = self.ack()
        check(ack, "phase 1")
        self.assertEqual((len(ack["accepted"]), len(ack["acked"])), (32, 480), "phase 1 split")
        if os.environ.get("J5B_ACK_OUT"):
            shutil.copyfile(self.ack_path, os.environ["J5B_ACK_OUT"])
        self.clear("fault-journal-erofs")
        self.assertTrue(wait_for(lambda: set(offered_ids) <= set((self.ack() or {}).get("acked") or []), timeout=10), "the offered adds never became durable")
        ack = self.ack()
        check(ack, "phase 2")
        self.assertEqual(ack["accepted"], [], "phase 2: nothing is accepted-only any more")
        self.assertFalse(set(ack["acked"]) & set(ack["accepted"]), "lists disjoint")


class P28CompactionRenameThenDirFsyncFails(ControlRig):
    def test_compaction_rename_then_dir_fsync_fails(self):
        # r8 M3 (rule R). The journal is past the compaction threshold; the directory fsync after the rename raises EIO. X must not be listed in `acked`
        # while the writer is relinking; once the fault ends X is listed, and after a SIGKILL every id ever listed in `acked` has its add in the journal.
        lines = []
        for n in range(1100):
            row = item(8000 + n, ("restore.aborted", "restore.stuck", FAILURE)[n % 3])
            lines.append(record_line([{"r": "add", "id": row["id"], "type": row["type"], "at": row["at"]}, {"r": "sent", "type": row["type"], "at": row["at"]}]))
        self.preload_journal(lines)
        x = item(1)
        self.app.items, self.app.follow = [x], False
        self.fault("fault-dirfsync-after-rename")
        proc = self.start()
        self.assertTrue(wait_for(lambda: os.path.exists(self.root + "/barrier-journal_renamed"), timeout=10), "the journal was never compacted and renamed (base has no journal)")
        time.sleep(0.5)
        self.assertNotIn(x["id"], (self.ack() or {}).get("acked", []), "X was ACKed while the writer was relinking")
        self.clear("fault-dirfsync-after-rename")
        self.assertTrue(wait_for(lambda: x["id"] in ((self.ack() or {}).get("acked") or []), timeout=8), "X was never ACKed after the relink")
        listed = set(self.ack()["acked"])
        self.kill(proc)
        self.assertTrue(listed <= set(journal_state(self.journal)["ids"]), "an id listed in `acked` is missing from the journal after the restart")


class P29NoTakeBeforeAcceptedPublish(ControlRig):
    def test_no_take_before_accepted_publish(self):
        # r8 M2 (rule Q). The journal refuses writes; K is offered and accepted from memory; the ACK write that lists K in `accepted` stalls. While it
        # stalls probes continue, but their responses cannot admit new ids.
        k = item(31)
        self.app.items, self.app.degraded = [k], 1
        self.fault("fault-journal-erofs")
        self.fault("fault-stall-ack")
        self.start()
        self.assertTrue(wait_for(lambda: os.path.exists(self.root + "/barrier-ack_stall"), timeout=10), "K was never accepted from memory (base never sends an app item)")
        time.sleep(0.3)  # a probe already past its check when the flag was set finishes here
        before = self.app.requests
        time.sleep(1.0)
        after = self.app.requests
        pathlib.Path(self.root + "/release-ack_stall").write_text("")
        self.assertGreaterEqual(after - before, 3, "independent probes stopped during the ACK publication stall")
        self.assertTrue(wait_for(lambda: k["id"] in ((self.ack() or {}).get("accepted") or []), timeout=8), "accepted never lists K")


class P26RLoss1ControlHalf(ControlRig):
    """MurageMain r7 ruling 7 (R-loss-1), control half. A distinct event E2 is suppressed (it goes out with E1's key) ONLY when all hold together: same
    kind, same millisecond, E1 memory-only at the control (journal refused), and a whole-unit crash (control killed, the app's copy erased too).
    Dropping any ONE condition must deliver E2 under a different key. PIN of the bound: at base the whole family fails on the missing channel (no app
    item is ever sent); the tests describe the exact bound once the channel exists."""
    T = BASE_AT + 31337

    def run_scenario(self, e2_type="restore.aborted", e2_at=None, memory_only=True, crash=True):
        e1 = {"id": hid("rloss-e1", 1), "type": "restore.aborted", "at": self.T}
        e2 = {"id": hid("rloss-e2", 1), "type": e2_type, "at": self.T if e2_at is None else e2_at}
        self.app.items, self.app.follow = [e1], False
        if memory_only:
            self.fault("fault-journal-erofs")
        proc = self.start()
        self.assertTrue(wait_for(lambda: (e1["type"], e1["at"]) in self.accepted_keys(), timeout=8), "E1 was never accepted: base never sends an app item")
        if crash:
            self.app.items = []  # the app's copy is memory-only too and a whole-unit crash erased it
            self.kill(proc)
            self.clear("fault-journal-erofs")
            self.app.items = [e2]
            self.start()
        else:
            self.app.items = [e1, e2]
            if memory_only:
                time.sleep(0.5)
                self.clear("fault-journal-erofs")
        return e1, e2

    def delivered_for(self, e2, expect_count):
        wait_for(lambda: len([k for k in self.accepted_keys() if k[0] == e2["type"]]) >= expect_count, timeout=8)
        return self.accepted_keys()

    def test_all_conditions_together_suppress(self):
        e1, e2 = self.run_scenario()
        keys = self.delivered_for(e2, 2)
        self.assertEqual(keys.count((e1["type"], self.T)), 2, "with every condition holding E2 must go out under E1's key (the CP then suppresses it)")

    def test_different_kind_delivers(self):
        e1, e2 = self.run_scenario(e2_type="restore.stuck")
        keys = self.delivered_for(e2, 1)
        self.assertIn(("restore.stuck", self.T), keys)
        self.assertEqual(keys.count((e1["type"], self.T)), 1)

    def test_different_millisecond_delivers(self):
        e1, e2 = self.run_scenario(e2_at=self.T + 5)
        keys = self.delivered_for(e2, 2)
        self.assertIn((e2["type"], self.T + 5), keys)
        self.assertEqual(keys.count((e1["type"], self.T)), 1)

    def test_durable_at_control_delivers_under_a_new_key(self):
        e1, e2 = self.run_scenario(memory_only=False)
        keys = self.delivered_for(e2, 2)
        self.assertEqual(keys.count((e1["type"], self.T)), 1, "E1 was durable at the control: E2 must not reuse its key")
        self.assertIn((e1["type"], self.T + 1), keys, "E2 must go out at T+1")

    def test_without_a_crash_delivers_under_a_new_key(self):
        e1, e2 = self.run_scenario(crash=False)
        keys = self.delivered_for(e2, 2)
        self.assertEqual(keys.count((e1["type"], self.T)), 1, "no crash: control still holds E1 and must reassign E2")
        self.assertIn((e1["type"], self.T + 1), keys)


class P27HoldIsNeverSilentControlHalf(ControlRig):
    """MurageMain r7 ruling 8, control half: a hold (outboxDegraded > 0 served by the app) must raise an alert. The seam is the existing failure type:
    control sends a NEW home.event_spool_failed item when the app keeps serving outboxDegraded > 0 over HOLD_PROBES consecutive probes. INTERPRETATION
    to confirm with MurageMain (r7 D-2 says no CP signal is claimed for outbox failures): the ruling requires an alert, and the control is the only
    component with a path to the CP. Kills MU-H1 (hold without the flag or the alert) together with T18 and C8."""
    def test_a_hold_raises_a_failure_item(self):
        self.app.items, self.app.degraded, self.app.follow = [item(1)], 2, False
        self.start()
        self.assertTrue(wait_for(lambda: any(key[0] == FAILURE for key in self.accepted_keys()), timeout=10),
                        "outboxDegraded stayed above 0 over many probes and no failure item reached the CP: a silent hold (base ignores the field)")

    def test_guard_no_hold_no_alert(self):
        self.app.items, self.app.degraded, self.app.follow = [item(1)], 0, False
        self.start()
        wait_for(lambda: len(self.bodies()) >= 12, timeout=6)
        self.assertFalse(any(key[0] == FAILURE for key in self.accepted_keys()), "a failure item was raised without a hold")


class P27bHoldGuardsAndRestart(ControlRig):
    def test_a_single_degraded_probe_raises_nothing(self):
        # two degraded answers at most (any caller), then 0: fewer than 3 consecutive intake probes
        self.app.items, self.app.follow, self.app.degraded_budget = [item(1)], False, 2
        self.start()
        wait_for(lambda: len(self.bodies()) >= 12, timeout=6)
        self.assertFalse(any(key[0] == FAILURE for key in self.accepted_keys()), "a failure item was raised for fewer than three degraded probes")

    def test_a_restart_inside_the_episode_raises_no_second_item(self):
        self.app.items, self.app.degraded, self.app.follow = [item(1)], 2, False
        proc = self.start()
        failures = lambda: [op for op in journal_state(self.journal)["adds"] if op["type"] == FAILURE]
        self.assertTrue(wait_for(lambda: len(failures()) == 1, timeout=10), "no hold item was journaled")
        self.kill(proc)
        mark = len(self.bodies())
        self.start()
        wait_for(lambda: len(self.bodies()) >= mark + 12, timeout=8)
        self.assertEqual(len(failures()), 1, "a second hold item was raised in the same episode after a restart")


class LegacySpoolMigration(ControlRig):
    """DESIGN 8 section 5 (keys): r2/r3 spool files in /data/.murage-events become journal `add` records with the legacy id, and a file is unlinked only after
    its `add` is durable. The r8 app writes none."""
    def legacy_dir(self):
        d = self.root + "/legacy"
        os.makedirs(d, exist_ok=True)
        return d

    def put(self, type_, at):
        path = self.legacy_dir() + "/%s-%d.json" % (type_, at)
        pathlib.Path(path).write_text(json.dumps({"type": type_, "at": at}))
        return path

    @staticmethod
    def lid(type_, at):
        return hashlib.sha256(("legacy\0" + type_ + "\0" + str(at)).encode()).hexdigest()[:16]

    def adds(self):
        return {op["id"]: (op["type"], op["at"]) for rec in read_records(self.journal)[0] for op in rec if op["r"] == "add"}

    def test_legacy_files_migrate_then_unlink(self):
        a, b = self.put("restore.stuck", 1700000000111), self.put("restore.aborted", 1700000000222)
        self.start()
        want = {self.lid("restore.stuck", 1700000000111): ("restore.stuck", 1700000000111),
                self.lid("restore.aborted", 1700000000222): ("restore.aborted", 1700000000222)}
        self.assertTrue(wait_for(lambda: not os.path.exists(a) and not os.path.exists(b), timeout=10), "legacy files were never consumed")
        self.assertEqual({k: v for k, v in self.adds().items() if k in want}, want, "each legacy file needs an add record with the sha256 legacy id")
        self.assertTrue(wait_for(lambda: all(k in self.accepted_keys() for k in want.values()), timeout=8), "the migrated items never reached the CP")
        mark = len(self.bodies())
        wait_for(lambda: len(self.bodies()) >= mark + 6, timeout=8)
        for k in want.values():
            self.assertEqual(self.accepted_keys().count(k), 1, "a migrated item must reach the CP exactly once")

    def test_file_survives_while_journal_refuses_writes(self):
        a = self.put("restore.stuck", 1700000000333)
        self.fault("fault-journal-erofs")
        self.start()
        before = self.app.requests
        wait_for(lambda: self.app.requests > before + 8, timeout=10)
        self.assertTrue(os.path.exists(a), "the file was unlinked although its add is not durable")
        self.clear("fault-journal-erofs")
        self.assertTrue(wait_for(lambda: not os.path.exists(a), timeout=10), "the file was never migrated once the journal accepted writes")
        self.assertIn(self.lid("restore.stuck", 1700000000333), self.adds())
        self.assertEqual(self.accepted_keys().count(("restore.stuck", 1700000000333)), 1, "the item rides once, from memory or the journal, never twice")

    def test_migration_runs_once_per_file(self):
        a = self.put("restore.aborted", 1700000000444)
        proc = self.start()
        self.assertTrue(wait_for(lambda: not os.path.exists(a), timeout=10))
        self.kill(proc)
        self.put("restore.aborted", 1700000000444)  # the same file reappears (a crash between add and unlink)
        self.start()
        self.assertTrue(wait_for(lambda: not os.path.exists(a), timeout=10))
        ids = [op["id"] for rec in read_records(self.journal)[0] for op in rec if op["r"] == "add"]
        self.assertEqual(ids.count(self.lid("restore.aborted", 1700000000444)), 1, "a second add record was written for the same legacy file")




class RestoreFinishedNegotiation(NegotiationBase):
    def test_finished_is_held_for_old_header_then_sent_once_and_acked(self):
        self.enterContext(scoped_ancestors(self.tmp.name))
        nonce = "1234567890abcdef"
        row = {"type": "restore.finished", "at": BASE_AT + 700,
               "id": hashlib.sha256(("restore.finished\0" + nonce).encode()).hexdigest()[:16]}
        parsed = mc.parse_home_events({"v": 1, "items": [row], "outboxDegraded": 0})
        self.assertIsNotNone(parsed, "restore.finished must enter the durable channel")
        self.assertNotIn("restore.finished", mc.LEGACY_TYPES)
        import ast
        harness = ast.parse(HARNESS.read_text())
        advertised = next(ast.literal_eval(node.value) for node in harness.body
                          if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "ADVERTISE" for target in node.targets))
        self.assertEqual(set(advertised.split(",")), set(mc.EXTENDED_EVENT_TYPES))
        self.assertEqual(set(mc.CHANNEL_TYPES), set(mc.EXTENDED_EVENT_TYPES))
        channel = mc.Channel(self.tmp.name + "/home-events.journal", self.tmp.name + "/ack.json", os.getuid())
        self.addCleanup(lambda ch=channel: os.close(ch.fd) if ch.fd >= 0 else None)
        self.context["channel"] = channel
        channel.take(parsed["items"])
        self.assertTrue(channel.publish_ack())
        self.assertIn(row["id"], json.loads(pathlib.Path(channel.ack_path).read_text())["acked"])
        old = FakeCP("new", advertise="restore.aborted,restore.stuck,home.event_spool_failed")
        for _ in range(3):
            self.poll(old)
            self.assertEqual(self.sent_events(old), [], "a CP without the terminal type must receive none")
        new = FakeCP("new", advertise="restore.aborted,restore.stuck,home.event_spool_failed,restore.finished")
        self.poll(new)
        self.assertEqual(self.sent_events(new), [])
        self.poll(new)
        self.assertEqual(self.sent_events(new), [(row["type"], row["at"])])
        self.poll(new)
        self.assertEqual(self.sent_events(new), [])
        self.assertEqual(channel.pending, {})
        channel = mc.Channel(channel.journal, channel.ack_path, os.getuid())
        self.addCleanup(lambda ch=channel: os.close(ch.fd) if ch.fd >= 0 else None)
        self.assertEqual(channel.pending, {})
        self.assertIn(row["at"], channel.sent["restore.finished"])


if __name__ == "__main__":
    unittest.main()
