#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Fuigo's FluxRouter base and the no-silent-hang pins (CLOUD-FLUX-ROUTER-BASE, revised after GrokBuild).
# A staging image swaps api.fluxrouter.ai for api-staging.fluxrouter.ai in source and in egress-allow.json, but not
# in the Fuigo binary, so the server names the base (FUIGO_API_BASE_URL / FUIGO_MODELS_BASE_URL) and the launcher
# lets it through only when it points at the ONE host the image's fuigoAgent egress list allows. Stdlib only, builds
# nothing: run as `python3 -I -B murage-turn-launch_test.py`.
import importlib.util
import json
import pathlib
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("murage_turn_launch", str(HERE / "murage-turn-launch.py"))
launcher = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(launcher)

PROD_BASE = "https://api.fluxrouter.ai/v1"
STAGING_BASE = "https://api-staging.fluxrouter.ai/v1"


class EgressList:
    """A temporary installed egress list, shaped like deploy/cloud-home/egress-allow.json."""

    def __init__(self, fuigo_hosts):
        doc = json.loads((HERE / "egress-allow.json").read_text(encoding="utf-8"))
        doc["engines"]["fuigoAgent"] = fuigo_hosts
        self._dir = tempfile.TemporaryDirectory()
        self.path = str(pathlib.Path(self._dir.name) / "egress-allow.json")
        pathlib.Path(self.path).write_text(json.dumps(doc), encoding="utf-8")

    def __enter__(self):
        return self.path

    def __exit__(self, *exc):
        self._dir.cleanup()


def check(env, hosts=("api.fluxrouter.ai",), route=None):
    with EgressList(list(hosts)) as path:
        launcher.check_fuigo_base_env("fuigoAgent", env, {"route": route}, egress_path=path)


def both(value):
    return {name: value for name in launcher.FUIGO_BASE_ENV}


class FuigoBaseCheck(unittest.TestCase):
    def refused(self, env, reason, hosts=("api.fluxrouter.ai",), route=None):
        with self.assertRaises(launcher.Refusal) as caught:
            check(env, hosts, route)
        message = str(caught.exception)
        self.assertIn(reason, message)
        # Name and reason only, never the value.
        for value in env.values():
            self.assertNotIn(value, message)

    def test_prod_host_on_the_prod_list(self):
        check(both(PROD_BASE))
        check(both("https://api.fluxrouter.ai:443/v1"))

    def test_staging_host_on_a_staging_list(self):
        check(both(STAGING_BASE), hosts=("api-staging.fluxrouter.ai",))

    def test_each_name_is_checked_on_its_own(self):
        for name in launcher.FUIGO_BASE_ENV:
            self.refused({name: "http://api.fluxrouter.ai/v1"}, name + " is not allowed: not https")

    def test_refuses_http(self):
        self.refused(both("http://api.fluxrouter.ai/v1"), "not https")

    def test_refuses_userinfo(self):
        self.refused(both("https://user:fixture-secret" + "@" + "api.fluxrouter.ai/v1"), "carries userinfo")
        self.refused(both("https://api.fluxrouter.ai@evil.example/v1"), "carries userinfo")

    def test_refuses_loopback_and_ip_literals(self):
        self.refused(both("https://127.0.0.1/v1"), "an IP literal")
        self.refused(both("https://127.0.0.1:8799/v1"), "an IP literal")
        self.refused(both("https://[::1]/v1"), "an IP literal")
        self.refused(both("https://5.255.0.1/v1"), "an IP literal")
        self.refused(both("https://localhost/v1"), "loopback")

    def test_refuses_port_8443(self):
        self.refused(both("https://api.fluxrouter.ai:8443/v1"), "port is not 443")

    def test_refuses_a_lookalike(self):
        self.refused(both("https://api.fluxrouter.ai.evil.com/v1"), "host is not the image's Flux host")
        self.refused(both("https://evilapi.fluxrouter.ai/v1"), "host is not the image's Flux host")

    def test_refuses_a_mismatched_host(self):
        # A prod base on a staging image (the proven hang) and a staging base on a prod image.
        self.refused(both(PROD_BASE), "host is not the image's Flux host", hosts=("api-staging.fluxrouter.ai",))
        self.refused(both(STAGING_BASE), "host is not the image's Flux host")

    def test_refuses_a_query_or_fragment(self):
        self.refused(both("https://api.fluxrouter.ai/v1?x=1"), "malformed")
        self.refused(both("https://api.fluxrouter.ai/v1#x"), "malformed")

    def test_refuses_when_the_egress_list_has_no_single_exact_host(self):
        for hosts in ([], ["api.fluxrouter.ai", "api-staging.fluxrouter.ai"], ["*.fluxrouter.ai"]):
            with self.subTest(hosts=hosts):
                self.refused(both(PROD_BASE), "exactly one Flux host", hosts=hosts)

    def test_refuses_when_the_egress_list_is_missing(self):
        with tempfile.TemporaryDirectory() as empty:
            with self.assertRaises(launcher.Refusal):
                launcher.check_fuigo_base_env("fuigoAgent", both(PROD_BASE), {"route": None}, egress_path=empty + "/missing.json")

    def test_never_widens_the_egress_list(self):
        with EgressList(["api.fluxrouter.ai"]) as path:
            before = pathlib.Path(path).read_bytes()
            with self.assertRaises(launcher.Refusal):
                launcher.check_fuigo_base_env("fuigoAgent", both("https://evil.example/v1"), {"route": None}, egress_path=path)
            self.assertEqual(pathlib.Path(path).read_bytes(), before)

    def test_no_names_and_other_engines_pass(self):
        check({})
        launcher.check_fuigo_base_env("opencodeGo", both("http://evil.example"), {"route": None}, egress_path="/nonexistent")

    def test_a_routed_turn_binds_the_names_to_its_own_route(self):
        route = {"baseUrl": "http://127.0.0.1:49999/v1"}
        check(both("http://localhost:49999/v1"), route=route)
        check(both("http://127.0.0.1:49999/v1"), route=route)
        self.refused(both("https://api.fluxrouter.ai/v1"), "not the route's base", route=route)

    def test_a_keyed_flux_turn_with_no_base_is_judged_on_fuigos_compiled_default(self):
        self.assertEqual(launcher.FUIGO_COMPILED_BASE, PROD_BASE)
        check({"FUIGO_API_KEY": "fixture-key"})
        # A staging image whose Fuigo would fall back to the prod host refuses instead of hanging.
        with self.assertRaises(launcher.Refusal) as caught:
            check({"FUIGO_API_KEY": "fixture-key"}, hosts=("api-staging.fluxrouter.ai",))
        self.assertIn("FUIGO_API_BASE_URL is missing", str(caught.exception))
        self.assertIn("host is not the image's Flux host", str(caught.exception))
        # Named, it passes; keyless and routed spawns send nothing to Flux on the default.
        check({"FUIGO_API_KEY": "fixture-key", "FUIGO_API_BASE_URL": STAGING_BASE}, hosts=("api-staging.fluxrouter.ai",))
        check({}, hosts=("api-staging.fluxrouter.ai",))
        # A routed turn always names both bases (FUIGO-ROUTED-BASE-LOWS a), so a bare keyed route refuses.
        self.refused({"FUIGO_API_KEY": "fixture-key"}, "FUIGO_API_BASE_URL is missing on a routed turn",
                     hosts=("api-staging.fluxrouter.ai",), route={"baseUrl": "https://x.example/v1"})

    def test_a_routed_turn_needs_both_base_names(self):
        # FUIGO-ROUTED-BASE-LOWS a: the server sets both; a missing one would dial Fuigo's compiled default.
        route = {"baseUrl": "http://127.0.0.1:49999/v1"}
        for key in ({}, {"FUIGO_API_KEY": "fixture-key"}):
            with self.subTest(key=key):
                self.refused(dict(key), "FUIGO_API_BASE_URL is missing on a routed turn", route=route)
                self.refused({**key, "FUIGO_API_BASE_URL": route["baseUrl"]}, "FUIGO_MODELS_BASE_URL is missing on a routed turn", route=route)
                self.refused({**key, "FUIGO_MODELS_BASE_URL": route["baseUrl"]}, "FUIGO_API_BASE_URL is missing on a routed turn", route=route)
                self.refused({**key, "FUIGO_API_BASE_URL": route["baseUrl"], "FUIGO_MODELS_BASE_URL": "http://127.0.0.1:50000/v1"},
                             "FUIGO_MODELS_BASE_URL is not allowed: not the route's base", route=route)
                check({**key, **both(route["baseUrl"])}, route=route)

    def test_an_off_flux_route_drops_every_flux_key(self):
        # FUIGO-ROUTED-BASE-LOWS b: defense in depth behind provider-routing.ts applyProviderRoute.
        keys = {"FUIGO_API_KEY": "k1", "FUIGO_CODE_API_KEY": "k2", "FLUX_API_KEY": "k3", "flux_api_key": "k4"}
        for base, hosts in (("http://127.0.0.1:49999/v1", ("api.fluxrouter.ai",)),
                            ("https://api.openai.example/v1", ("api.fluxrouter.ai",)),
                            ("https://api.fluxrouter.ai/v1", ("api-staging.fluxrouter.ai",)),
                            ("https://api.fluxrouter.ai/v1", ())):
            with self.subTest(base=base, hosts=hosts):
                env = {**keys, **both(base), "MURAGE_PROVIDER_API_KEY": "route-key"}
                with EgressList(list(hosts)) as path:
                    dropped = launcher.check_fuigo_base_env("fuigoAgent", env, {"route": {"baseUrl": base}}, egress_path=path)
                self.assertEqual(sorted(dropped), sorted(keys))
                self.assertEqual(env, {**both(base), "MURAGE_PROVIDER_API_KEY": "route-key"})
        # The route on the image's own Flux host keeps the names (nothing to protect them from).
        env = {"FUIGO_API_KEY": "k1", **both(PROD_BASE)}
        with EgressList(["api.fluxrouter.ai"]) as path:
            self.assertEqual(launcher.check_fuigo_base_env("fuigoAgent", env, {"route": {"baseUrl": PROD_BASE}}, egress_path=path), [])
        self.assertEqual(env["FUIGO_API_KEY"], "k1")

    def test_a_blank_key_is_keyless_for_the_default_check(self):
        # FUIGO-ROUTED-BASE-LOWS c: a whitespace-only key sends nothing to Flux, like no key.
        for key in ("", "   ", "\t"):
            with self.subTest(key=key):
                check({"FUIGO_API_KEY": key}, hosts=("api-staging.fluxrouter.ai",))

    def test_the_repo_list_is_the_prod_list(self):
        self.assertEqual(launcher.fuigo_flux_host(str(HERE / "egress-allow.json")), "api.fluxrouter.ai")


class FuigoNoSilentHangPins(unittest.TestCase):
    # Equal to the desktop lane's values (FUIGO-NO-SILENT-HANG r3); asserted as literals until its TS constants land.
    ALWAYS = {"FUIGO_MAX_RETRIES": "3", "FUIGO_CONNECT_TIMEOUT_SECS": "15", "FUIGO_COMPACTION_WALL_CLOCK_SECS": "300"}
    KEYED = {"FUIGO_UNCHARGED_401_PARK": "0"}
    HOME = "/data/engine-homes/fuigoAgent"
    SCRATCHES = ((), ("/data/engine-homes/fuigoAgent/native/provider-turns/fuigoAgent-0123456789ab",))

    def test_values_match_the_desktop_pins(self):
        self.assertEqual({k: launcher.ENGINE_ENV_PIN["fuigoAgent"][k] for k in self.ALWAYS}, {"FUIGO_MAX_RETRIES": "3", "FUIGO_CONNECT_TIMEOUT_SECS": "15", "FUIGO_COMPACTION_WALL_CLOCK_SECS": "300"})
        self.assertEqual(launcher.FUIGO_KEYED_PIN, {"FUIGO_UNCHARGED_401_PARK": "0"})
        self.assertNotIn("FUIGO_UNCHARGED_401_PARK", launcher.ENGINE_ENV_PIN["fuigoAgent"])

    def test_a_keyed_turn_gets_every_pin_over_the_callers_values(self):
        proposal = {"FUIGO_MAX_RETRIES": "99", "FUIGO_CONNECT_TIMEOUT_SECS": "600", "FUIGO_UNCHARGED_401_PARK": "1",
                    "fuigo_uncharged_401_park": "1", "FUIGO_API_KEY": "fixture-key", "FUIGO_API_BASE_URL": PROD_BASE}
        for scratch in self.SCRATCHES:
            env, _dropped = launcher.engine_environment("fuigoAgent", self.HOME, proposal, scratch)
            for name, value in {**self.ALWAYS, **self.KEYED}.items():
                self.assertEqual(env[name], value, name)
            self.assertNotIn("fuigo_uncharged_401_park", env)
            self.assertEqual(env["FUIGO_API_BASE_URL"], PROD_BASE)

    def test_the_compaction_wall_clock_pin_beats_a_shell_or_owner_value(self):
        for value in ("0", "900"):
            for key in ("fixture-key", None):
                proposal = {"FUIGO_COMPACTION_WALL_CLOCK_SECS": value, "fuigo_compaction_wall_clock_secs": value}
                if key:
                    proposal["FUIGO_API_KEY"] = key
                for scratch in self.SCRATCHES:
                    with self.subTest(value=value, key=key, scratch=scratch):
                        env, _dropped = launcher.engine_environment("fuigoAgent", self.HOME, proposal, scratch)
                        self.assertEqual([(k, v) for k, v in env.items() if k.upper() == "FUIGO_COMPACTION_WALL_CLOCK_SECS"],
                                         [("FUIGO_COMPACTION_WALL_CLOCK_SECS", "300")])

    def test_a_login_turn_keeps_fuigos_park(self):
        for key in (None, "", "   "):
            proposal = {"FUIGO_MAX_RETRIES": "99", "FUIGO_UNCHARGED_401_PARK": "0", "Fuigo_Uncharged_401_Park": "0"}
            if key is not None:
                proposal["FUIGO_API_KEY"] = key
            for scratch in self.SCRATCHES:
                with self.subTest(key=key, scratch=scratch):
                    env, _dropped = launcher.engine_environment("fuigoAgent", self.HOME, proposal, scratch)
                    for name, value in self.ALWAYS.items():
                        self.assertEqual(env[name], value, name)
                    self.assertEqual([k for k in env if k.upper() == "FUIGO_UNCHARGED_401_PARK"], [])
                    # FUIGO-ROUTED-BASE-LOWS c: a blank key is absent everywhere, the child included.
                    self.assertNotIn("FUIGO_API_KEY", env)
                    if key is not None:
                        self.assertIn("FUIGO_API_KEY", _dropped)

    def test_pins_reach_only_fuigo(self):
        env, _dropped = launcher.engine_environment("opencodeGo", "/data/engine-homes/opencodeGo", {**self.ALWAYS, **self.KEYED, "FUIGO_API_KEY": "k"})
        for name in {**self.ALWAYS, **self.KEYED}:
            self.assertNotIn(name, env)


if __name__ == "__main__":
    unittest.main()
