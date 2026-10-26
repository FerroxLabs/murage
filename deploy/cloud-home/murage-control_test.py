#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# The owner-factor capability negotiation (CLOUD-DOOR-OWNER-FACTOR-DESIGN-r3 4.1): app_report reads ownerFactor from the app's
# health body, and machine_request stamps X-Murage-Owner-Factor: 1 on a heartbeat only when it is True.
import importlib.machinery
import importlib.util
import pathlib
import unittest
import urllib.request

# The module file has no .py extension, so give importlib an explicit source loader.
_loader = importlib.machinery.SourceFileLoader("murage_control", str(pathlib.Path(__file__).with_name("murage-control")))
mc = importlib.util.module_from_spec(importlib.util.spec_from_loader("murage_control", _loader))
_loader.exec_module(mc)


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


if __name__ == "__main__":
    unittest.main()
