#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Tests for console-type.py: DES vectors, and a full login-and-type run against a mock websocket RFB server on loopback."""
import base64
import hashlib
import importlib.util
import os
import pathlib
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import unittest

HERE = pathlib.Path(__file__).resolve().parent
SCRIPT = HERE.parent.parent / "console-type.py"
spec = importlib.util.spec_from_file_location("console_type", SCRIPT)
ct = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ct)


class DesVectors(unittest.TestCase):
    def test_classic_vectors(self):
        # FIPS-style known answers
        self.assertEqual(ct.des_encrypt_block(bytes.fromhex("133457799BBCDFF1"), bytes.fromhex("0123456789ABCDEF")).hex().upper(), "85E813540F0AB405")
        self.assertEqual(ct.des_encrypt_block(bytes.fromhex("0E329232EA6D0D73"), bytes.fromhex("8787878787878787")).hex().upper(), "0000000000000000")
        self.assertEqual(ct.des_encrypt_block(bytes.fromhex("0101010101010101"), bytes.fromhex("95F8A5E5DD31D900")).hex().upper(), "8000000000000000")
        self.assertEqual(ct.des_encrypt_block(bytes.fromhex("0123456789ABCDEF"), bytes.fromhex("4E6F772069732074")).hex().upper(), "3FA40E8A984D4815")

    def test_vnc_response_shape(self):
        out = ct.vnc_response("secret", bytes(range(16)))
        self.assertEqual(len(out), 16)
        self.assertNotEqual(out, ct.vnc_response("Secret", bytes(range(16))))


def recv_exact(conn, n):
    buf = b""
    while len(buf) < n:
        c = conn.recv(n - len(buf))
        if not c:
            raise ConnectionError("closed")
        buf += c
    return buf


class MockConsole(threading.Thread):
    """ws:// server speaking just enough RFB 3.8 with VNC auth; records the key events."""

    def __init__(self, password, types=(1, 2)):
        super().__init__(daemon=True)
        self.password = password
        self.types = bytes(types)
        self.srv = socket.socket()
        self.srv.bind(("127.0.0.1", 0))
        self.srv.listen(1)
        self.port = self.srv.getsockname()[1]
        self.keys = []
        self.auth_ok = False
        self.error = None

    def ws_send(self, conn, data):
        n = len(data)
        head = bytes([0x82]) + (bytes([n]) if n < 126 else bytes([126]) + struct.pack(">H", n))
        conn.sendall(head + data)

    def run(self):
        conn, _ = self.srv.accept()
        try:
            req = b""
            while b"\r\n\r\n" not in req:
                req += conn.recv(4096)
            key = [l.split(b":", 1)[1].strip() for l in req.split(b"\r\n") if l.lower().startswith(b"sec-websocket-key")][0].decode()
            accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
            conn.sendall(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\nSec-WebSocket-Protocol: binary\r\n\r\n" % accept).encode())
            stream = [b""]

            def read(n):
                while len(stream[0]) < n:
                    b0, b1 = recv_exact(conn, 2)
                    ln = b1 & 0x7F
                    if ln == 126:
                        ln = struct.unpack(">H", recv_exact(conn, 2))[0]
                    mask = recv_exact(conn, 4)
                    data = bytes(b ^ mask[i % 4] for i, b in enumerate(recv_exact(conn, ln)))
                    stream[0] += data
                out, stream[0] = stream[0][:n], stream[0][n:]
                return out

            self.ws_send(conn, b"RFB 003.008\n")
            assert read(12) == b"RFB 003.008\n"
            self.ws_send(conn, bytes([len(self.types)]) + self.types)
            chosen = read(1)[0]
            assert chosen in self.types
            if chosen == 2:
                challenge = bytes(range(100, 116))
                self.ws_send(conn, challenge)
                resp = read(16)
                self.auth_ok = resp == ct.vnc_response(self.password, challenge)
            else:
                self.auth_ok = True
            self.ws_send(conn, struct.pack(">I", 0 if self.auth_ok else 1))
            if not self.auth_ok:
                return
            assert read(1) == bytes([1])
            name = b"mock"
            self.ws_send(conn, struct.pack(">HH", 640, 480) + bytes(16) + struct.pack(">I", len(name)) + name)
            while True:
                msg = read(8)
                if msg[0] != 4:
                    break
                self.keys.append((msg[1], struct.unpack(">I", msg[4:8])[0]))
        except Exception as exc:  # noqa: BLE001 - connection end is the normal exit
            self.error = exc
        finally:
            conn.close()
            self.srv.close()


def typed_text(keys):
    out, shift = "", False
    for down, sym in keys:
        if sym == 0xFFE1:
            shift = bool(down)
        elif sym == 0xFF0D and down:
            out += "\n"
        elif down and 0x20 <= sym <= 0x7E:
            out += chr(sym)
    return out, shift


class EndToEnd(unittest.TestCase):
    def run_helper(self, vnc_password, server_password="vncpw", types=(1, 2), layout="us"):
        srv = MockConsole(server_password, types)
        srv.start()
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            (d / "url").write_text("ws://127.0.0.1:%d/console?token=abc" % srv.port)
            (d / "vnc").write_text(vnc_password)
            (d / "root").write_text("Root-Pw_1")
            (d / "cmd").write_text("echo QQ== | base64 -d > /root/.ssh/authorized_keys; printf 'A\\nB' | wc -c")
            env = dict(os.environ, MURAGE_CONSOLE_TEST_LOOPBACK="1")
            r = subprocess.run([sys.executable, "-I", str(SCRIPT), "--url-file", str(d / "url"), "--vnc-pass-file", str(d / "vnc"),
                                "--root-pass-file", str(d / "root"), "--command-file", str(d / "cmd"), "--boot-wait", "0", "--step-wait", "0", "--key-delay", "0",
                                "--layout", layout],
                               capture_output=True, text=True, env=env, timeout=60)
        srv.join(timeout=10)
        return r, srv

    def test_types_login_and_command(self):
        r, srv = self.run_helper("vncpw")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(srv.auth_ok)
        text, shift = typed_text(srv.keys)
        self.assertEqual(text, "\nroot\nRoot-Pw_1\necho QQ== | base64 -d > /root/.ssh/authorized_keys; printf 'A\\nB' | wc -c\n")
        self.assertFalse(shift)
        # uppercase and symbols are sent with Shift held
        events = srv.keys
        i = events.index((1, ord("R")))
        self.assertEqual(events[i - 1], (1, 0xFFE1))
        self.assertEqual(events[i + 2], (0, 0xFFE1))

    def test_prefers_vnc_auth_when_both_are_offered(self):
        r, srv = self.run_helper("not-the-password", types=(1, 2))
        self.assertNotEqual(r.returncode, 0)  # chose type 2, so the wrong password fails rather than falling back to None
        self.assertEqual(srv.keys, [])

    def test_none_only_console_types_login_and_command(self):
        # build host's web console offers only type 1; the one-time wss URL is the credential.
        r, srv = self.run_helper("ignored", types=(1,))
        self.assertEqual(r.returncode, 0, r.stderr)
        text, _ = typed_text(srv.keys)
        self.assertTrue(text.startswith("\nroot\nRoot-Pw_1\n"))

    def test_no_usable_security_type_fails_without_typing(self):
        r, srv = self.run_helper("vncpw", types=(16,))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("no usable security type", r.stderr)
        self.assertEqual(srv.keys, [])

    def test_german_console_gets_the_login_and_a_bootstrap_that_runs_the_exact_command(self):
        # The mock records US key positions; read them back through the German layout.
        r, srv = self.run_helper("ignored", types=(1,), layout="de")
        self.assertEqual(r.returncode, 0, r.stderr)
        sent, _ = typed_text(srv.keys)
        inv = {v: k for k, v in ct._DE.items()}
        seen = "".join(inv[c] for c in sent)
        lines = seen.split("\n")
        self.assertEqual(lines[:3], ["", "root", "Root-Pw_1"])
        boot = lines[3]
        self.assertTrue(boot.startswith('python3 -c "import os,base64;os.system(base64.b64decode(\''), boot)
        b64 = boot.split("'")[1]
        self.assertEqual(base64.b64decode(b64).decode(), "echo QQ== | base64 -d > /root/.ssh/authorized_keys; printf 'A\\nB' | wc -c")
        for bad in "|<>":
            self.assertNotIn(bad, boot)

    def test_german_layout_table(self):
        self.assertEqual(ct.for_layout("yzYZ", "de"), "zyZY")
        line = ct.bootstrap("a | b > c < d; e || f")
        inv = {v: k for k, v in ct._DE.items()}
        self.assertEqual("".join(inv[c] for c in ct.for_layout(line, "de")), line)
        self.assertEqual(len(set(ct._DE.values())), len(ct._DE))  # one key per character, so the reading back is exact
        with self.assertRaises(ValueError):
            ct.for_layout("pipe|", "de")

    def test_untypable_password_is_refused_before_connecting(self):
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            for n, v in (("url", "ws://127.0.0.1:9/x"), ("vnc", "a"), ("root", "pw|x"), ("cmd", "c")):
                (d / n).write_text(v)
            env = dict(os.environ, MURAGE_CONSOLE_TEST_LOOPBACK="1")
            r = subprocess.run([sys.executable, "-I", str(SCRIPT), "--url-file", str(d / "url"), "--vnc-pass-file", str(d / "vnc"),
                                "--root-pass-file", str(d / "root"), "--command-file", str(d / "cmd"), "--boot-wait", "0", "--layout", "de"],
                               capture_output=True, text=True, env=env, timeout=30)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("cannot be typed", r.stderr)
            self.assertNotIn("pw|x", r.stderr + r.stdout)

    def test_wss_to_any_other_host_is_refused_before_connecting(self):
        for url in ("wss://evil.example/console?token=abc", "wss://console.provider.test.evil.example/x"):
            with self.assertRaises(ValueError):
                ct.WebSocket(url, console_host="console.provider.test")

    def test_wss_is_refused_when_no_console_host_is_configured(self):
        for host in (None, ""):
            with self.assertRaises(ValueError) as cm:
                ct.WebSocket("wss://console.provider.test/x", console_host=host)
            self.assertIn("no console host", str(cm.exception))

    def test_wrong_vnc_password_fails_without_typing(self):
        r, srv = self.run_helper("not-the-password")
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(srv.keys, [])
        self.assertNotIn("not-the-password", r.stderr + r.stdout)

    def test_refuses_plain_ws_without_the_test_switch(self):
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            for n, v in (("url", "ws://127.0.0.1:9/x"), ("vnc", "a"), ("root", "b"), ("cmd", "c")):
                (d / n).write_text(v)
            env = {k: v for k, v in os.environ.items() if k != "MURAGE_CONSOLE_TEST_LOOPBACK"}
            r = subprocess.run([sys.executable, "-I", str(SCRIPT), "--url-file", str(d / "url"), "--vnc-pass-file", str(d / "vnc"),
                                "--root-pass-file", str(d / "root"), "--command-file", str(d / "cmd"), "--boot-wait", "0"], capture_output=True, text=True, env=env, timeout=30)
            self.assertNotEqual(r.returncode, 0)


if __name__ == "__main__":
    unittest.main()
