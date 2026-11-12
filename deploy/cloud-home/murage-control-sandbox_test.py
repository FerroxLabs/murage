#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Reads the REAL murage-control.service and holds murage-control to it. The Flux delivery shipped with two bugs a tmp-dir unit test could
# not see: a chown to the supervisor's uid (the unit drops every capability, so chown fails EPERM) and a pending record under
# /var/lib/murage-home (read-only under ProtectSystem=strict). This test fails if the code writes a path the unit does not make
# writable, or calls something the unit's empty CapabilityBoundingSet takes away. The container proof in
# deploy/cloud-home/qualify/murage-control-sandbox-proof.sh runs the same handoff under a real capability-less, read-only root.
import importlib.machinery
import importlib.util
import pathlib
import re
import unittest

HERE = pathlib.Path(__file__).parent
SOURCE = (HERE / "murage-control").read_text()
UNIT = (HERE / "murage-control.service").read_text()
_loader = importlib.machinery.SourceFileLoader("murage_control_sb", str(HERE / "murage-control"))
mc = importlib.util.module_from_spec(importlib.util.spec_from_loader("murage_control_sb", _loader))
_loader.exec_module(mc)


def directives():
    out = {}
    in_service = False
    for line in UNIT.splitlines():
        line = line.strip()
        if line.startswith("["):
            in_service = line == "[Service]"
        elif in_service and line and not line.startswith("#") and "=" in line:
            name, value = line.split("=", 1)
            out.setdefault(name, []).append(value)
    return out


def writable_roots():
    d = directives()
    roots = [v.lstrip("-") for v in d.get("ReadWritePaths", [])]
    roots += ["/run/" + v for v in d.get("RuntimeDirectory", [])]
    roots += ["/var/lib/" + v for v in d.get("StateDirectory", [])]
    return roots


def under(path, roots):
    return any(path == r or path.startswith(r.rstrip("/") + "/") for r in roots)


class UnitMatchesTheCode(unittest.TestCase):
    def test_strict_and_capability_free(self):
        d = directives()
        self.assertEqual(d["ProtectSystem"], ["strict"])
        self.assertEqual(d["CapabilityBoundingSet"], [""])
        self.assertEqual(d["AmbientCapabilities"], [""])

    def test_every_path_the_poller_writes_is_writable_under_the_unit(self):
        roots = writable_roots()
        written = {
            "flux hand-off key": mc.FLUX_DELIVERY + "/" + mc.FLUX_DELIVERY_FILE,
            "flux hand-off dir": mc.FLUX_DELIVERY,
            "flux receipt removal": mc.FLUX_DELIVERY + "/" + mc.FLUX_RECEIPT_FILE,
            "flux pending ack": mc.FLUX_PENDING_ACK,
            "public snapshots": mc.PUBLIC + "/state.json",
            "clock_ahead refusal": mc.UI_REJECTED,
            "probe namespace mark": mc.PROBE_REFRESH_MARK,
        }
        for name, path in written.items():
            self.assertTrue(under(path, roots), name + " " + path + " is not under any writable path " + repr(roots))
        # Anything under the read-only home state may only be listed here if the unit names it writable.
        for name in ("FLUX_PENDING_ACK", "UI_REJECTED", "FLUX_DELIVERY"):
            self.assertFalse(getattr(mc, name).startswith(mc.STATE + "/"), name)

    def test_writes_to_the_data_volume_stay_in_the_probe_directory(self):
        self.assertTrue(under(mc.DATA_PROBE_DIR + "/.murage-health-x", writable_roots()))
        self.assertFalse(under(mc.DATA_MOUNT + "/other", writable_roots()))

    def test_the_code_needs_no_capability_the_unit_drops(self):
        # CAP_CHOWN (chown to another uid; chgrp to a group the process is not in), CAP_SETUID/SETGID, CAP_DAC_OVERRIDE, CAP_MKNOD, CAP_KILL,
        # CAP_SYS_CHROOT and CAP_FOWNER are all unavailable. The only ownership call allowed is chgrp(-1, gid) to the supplementary group.
        for match in re.finditer(r"os\.(?:l?chown|fchown)\((.*)\)\s*$", SOURCE, re.M):
            args = [a.strip() for a in match.group(1).split(",")]
            self.assertEqual(args[-2], "-1", match.group(0))
            self.assertIn("gid", args[-1], match.group(0))
        for banned in ("os.setuid", "os.setgid", "os.setgroups", "os.setresuid", "os.chroot", "os.mknod", "os.mkfifo", "os.kill(", "os.killpg",
                       "os.setxattr", "os.utime", "ctypes", "os.chflags"):
            self.assertNotIn(banned, SOURCE, banned)

    def test_the_group_the_poller_chgrps_to_is_one_the_unit_gives_it(self):
        self.assertIn("murage", directives().get("SupplementaryGroups", []))
        self.assertIn("os.chown(directory, -1, group_gid)", SOURCE)
        # build-image.sh makes the supervisor's group (useradd --system murage) and records it as identity.json "gid".
        build = (HERE / "build-image.sh").read_text()
        self.assertRegex(build, r"useradd --system[^\n]*\bmurage\b")
        self.assertIn('"gid":%s', build)


if __name__ == "__main__":
    unittest.main()
