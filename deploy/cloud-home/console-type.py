#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Type a login and one command line into a build host server through its authenticated web console.

build host's request_console action returns a wss URL and a VNC password over HTTPS. This helper opens that
WebSocket (TLS, certificate verified), speaks just enough RFB 3.8 to log in with VNC authentication, and
sends key events. It never reads the screen. Standard library only; secrets come from files, never argv.

  console-type.py --url-file F --vnc-pass-file F --root-pass-file F --command-file F [--boot-wait N] [--key-delay S]
"""
import argparse
import base64
import hashlib
import os
import socket
import ssl
import struct
import sys
import time
from urllib.parse import urlsplit

# ---- DES (needed by RFB "VNC authentication"; not in the standard library) -------------------------------------
_IP = [58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8,
       57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3, 61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7]
_FP = [40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31, 38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29,
       36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27, 34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25]
_E = [32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17,
      16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25, 24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1]
_P = [16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10, 2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25]
_PC1 = [57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36,
        63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4]
_PC2 = [14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2,
        41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48, 44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32]
_SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1]
_S = [
    [14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7, 0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8,
     4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0, 15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13],
    [15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10, 3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5,
     0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15, 13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9],
    [10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8, 13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1,
     13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7, 1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12],
    [7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15, 13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9,
     10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4, 3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14],
    [2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9, 14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6,
     4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14, 11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3],
    [12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11, 10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8,
     9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6, 4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13],
    [4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1, 13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6,
     1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2, 6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12],
    [13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7, 1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2,
     7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8, 2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11],
]


def _bits(data, n):
    return [(data[i // 8] >> (7 - i % 8)) & 1 for i in range(n)]


def _perm(bits, table):
    return [bits[i - 1] for i in table]


def _from_bits(bits):
    return bytes(sum(b << (7 - j) for j, b in enumerate(bits[i:i + 8])) for i in range(0, len(bits), 8))


def _subkeys(key8):
    k = _perm(_bits(key8, 64), _PC1)
    c, d = k[:28], k[28:]
    out = []
    for s in _SHIFTS:
        c, d = c[s:] + c[:s], d[s:] + d[:s]
        out.append(_perm(c + d, _PC2))
    return out


def des_encrypt_block(key8, block8):
    """Plain DES ECB encryption of one 8-byte block with an 8-byte key (parity bits ignored)."""
    if len(key8) != 8 or len(block8) != 8:
        raise ValueError("DES needs an 8-byte key and block")
    b = _perm(_bits(block8, 64), _IP)
    left, right = b[:32], b[32:]
    for sk in _subkeys(key8):
        x = [a ^ c for a, c in zip(_perm(right, _E), sk)]
        sbox = []
        for i in range(8):
            chunk = x[i * 6:i * 6 + 6]
            row = (chunk[0] << 1) | chunk[5]
            col = (chunk[1] << 3) | (chunk[2] << 2) | (chunk[3] << 1) | chunk[4]
            v = _S[i][row * 16 + col]
            sbox += [(v >> 3) & 1, (v >> 2) & 1, (v >> 1) & 1, v & 1]
        f = _perm(sbox, _P)
        left, right = right, [a ^ c for a, c in zip(left, f)]
    return _from_bits(_perm(right + left, _FP))


def vnc_response(password, challenge16):
    """RFB VNC authentication: DES-encrypt the 16-byte challenge with the password (8 bytes, each byte bit-reversed)."""
    key = (password.encode("latin-1") + b"\0" * 8)[:8]
    key = bytes(int("{:08b}".format(b)[::-1], 2) for b in key)
    return des_encrypt_block(key, challenge16[:8]) + des_encrypt_block(key, challenge16[8:16])


# ---- WebSocket (RFC 6455 client, binary frames) ----------------------------------------------------------------
# The one host allowed to receive the credentials comes from the operator config (--console-host); there is no default.


class WebSocket:
    def __init__(self, url, insecure_loopback=False, console_host=None):
        u = urlsplit(url)
        if u.scheme == "wss":
            # Only the configured console host gets the rescue root password and the command (Grok kmssign-console-r1 Low).
            if not console_host:
                raise ValueError("no console host is configured; refusing wss")
            if u.hostname != console_host:
                raise ValueError("console URL host is not %s" % console_host)
            port = u.port or 443
            ctx = ssl.create_default_context()
        elif u.scheme == "ws" and insecure_loopback and u.hostname in ("127.0.0.1", "localhost"):
            port = u.port or 80
            ctx = None
        else:
            raise ValueError("console URL must be wss://")
        raw = socket.create_connection((u.hostname, port), timeout=30)
        self.sock = ctx.wrap_socket(raw, server_hostname=u.hostname) if ctx else raw
        # True only for wss:// with a verified certificate. The loopback test switch never sets it.
        self.tls = ctx is not None
        self.loopback_test = ctx is None
        self.buf = b""
        key = base64.b64encode(os.urandom(16)).decode()
        path = (u.path or "/") + (("?" + u.query) if u.query else "")
        req = ("GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\n"
               "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: binary\r\n\r\n" % (path, u.netloc, key))
        self.sock.sendall(req.encode())
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("websocket closed during handshake")
            head += chunk
            if len(head) > 65536:
                raise ConnectionError("websocket handshake too long")
        head, _, rest = head.partition(b"\r\n\r\n")
        lines = head.decode("latin-1").split("\r\n")
        if " 101 " not in lines[0] + " ":
            raise ConnectionError("websocket upgrade refused: " + lines[0])
        accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
        hdrs = {l.split(":", 1)[0].strip().lower(): l.split(":", 1)[1].strip() for l in lines[1:] if ":" in l}
        if hdrs.get("sec-websocket-accept") != accept:
            raise ConnectionError("websocket accept key mismatch")
        self.raw = rest
        self.stream = b""

    def send(self, data):
        mask = os.urandom(4)
        n = len(data)
        head = bytes([0x82])
        if n < 126:
            head += bytes([0x80 | n])
        elif n < 65536:
            head += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            head += bytes([0x80 | 127]) + struct.pack(">Q", n)
        self.sock.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def _need(self, n):
        while len(self.raw) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("websocket closed")
            self.raw += chunk
        out, self.raw = self.raw[:n], self.raw[n:]
        return out

    def _frame(self):
        b0, b1 = self._need(2)
        op, n = b0 & 0x0F, b1 & 0x7F
        if n == 126:
            n = struct.unpack(">H", self._need(2))[0]
        elif n == 127:
            n = struct.unpack(">Q", self._need(8))[0]
        mask = self._need(4) if b1 & 0x80 else None
        data = self._need(n)
        if mask:
            data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        return op, data

    def read(self, n):
        """Exactly n payload bytes of the (binary) message stream."""
        while len(self.stream) < n:
            op, data = self._frame()
            if op in (0, 1, 2):
                self.stream += data
            elif op == 8:
                raise ConnectionError("websocket closed by peer")
            elif op == 9:
                pass  # ping: the console does not need a pong within our short session
        out, self.stream = self.stream[:n], self.stream[n:]
        return out

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


# ---- RFB -------------------------------------------------------------------------------------------------------
class Rfb:
    def __init__(self, ws, password):
        self.ws = ws
        ver = ws.read(12)
        if not ver.startswith(b"RFB 003."):
            raise ConnectionError("not an RFB server")
        ws.send(b"RFB 003.008\n")
        count = ws.read(1)[0]
        if count == 0:
            raise ConnectionError("RFB refused the connection")
        types = list(ws.read(count))
        if 2 in types:
            ws.send(bytes([2]))
            ws.send(vnc_response(password, ws.read(16)))
        elif 1 in types and (ws.tls or ws.loopback_test):
            # build host's web console (seen 2026-10-25) offers only security type 1 (None): the credential is the one-time
            # console URL, fetched with the API token over HTTPS and opened here over certificate-verified TLS.
            ws.send(bytes([1]))
        else:
            raise ConnectionError("RFB server offers no usable security type (offered %s)" % types)
        # RFB 3.8 sends SecurityResult for every security type, None included.
        if struct.unpack(">I", ws.read(4))[0] != 0:
            raise ConnectionError("RFB authentication failed")
        ws.send(bytes([1]))  # ClientInit: shared
        ws.read(2 + 2 + 16)
        ws.read(struct.unpack(">I", ws.read(4))[0])  # desktop name

    def key(self, keysym, down):
        self.ws.send(struct.pack(">BBHI", 4, 1 if down else 0, 0, keysym))


SHIFT_L = 0xFFE1
RETURN = 0xFF0D
_SHIFTED = set('ABCDEFGHIJKLMNOPQRSTUVWXYZ~!@#$%^&*()_+{}|:"<>?')


def type_text(rfb, text, delay):
    for ch in text:
        if ch == "\n":
            rfb.key(RETURN, True)
            rfb.key(RETURN, False)
        else:
            sym = ord(ch)
            if sym < 0x20 or sym > 0x7E:
                raise ValueError("only printable ASCII can be typed")
            shifted = ch in _SHIFTED
            if shifted:
                rfb.key(SHIFT_L, True)
            rfb.key(sym, True)
            rfb.key(sym, False)
            if shifted:
                rfb.key(SHIFT_L, False)
        time.sleep(delay)


# build host's rescue console starts with the German keyboard layout ("active keyboard layout: de", seen 2026-10-25) and
# ships no keymap files, so loadkeys cannot change it. The server maps each key we send to its US position, so for a
# German console we send the US key that sits where the wanted character is on a German keyboard. Only characters
# that need neither AltGr nor the extra 102nd key are typable; | > < are not, so the command is sent inside a
# base64 bootstrap that uses none of them (see bootstrap()).
_DE = {**{c: c for c in "abcdefghijklmnopqrstuvwxABCDEFGHIJKLMNOPQRSTUVWX0123456789 \n"},
       "y": "z", "z": "y", "Y": "Z", "Z": "Y",
       '"': "@", "'": "|", "(": "*", ")": "(", ";": "<", ".": ".", ",": ",", "=": ")", "+": "]",
       "/": "&", "-": "/", ":": ">", "_": "?", "!": "!", "$": "$", "%": "%", "&": "^", "*": "}", "?": "_", "#": "\\"}


def for_layout(text, layout):
    if layout == "us":
        return text
    if layout != "de":
        raise ValueError("unknown keyboard layout")
    bad = sorted({c for c in text if c not in _DE})
    if bad:
        raise ValueError("%d character(s) cannot be typed on the German console" % len(bad))
    return "".join(_DE[c] for c in text)


def bootstrap(command):
    """One shell line, typable on the German console, that runs `command` exactly (it travels as base64)."""
    b64 = base64.b64encode(command.encode()).decode()
    return "python3 -c \"import os,base64;os.system(base64.b64decode('%s').decode())\"" % b64


def read_secret(path):
    with open(path, "r", encoding="utf-8") as fh:
        return fh.read().rstrip("\r\n")


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--url-file", required=True)
    ap.add_argument("--vnc-pass-file", required=True)
    ap.add_argument("--root-pass-file", required=True)
    ap.add_argument("--command-file", required=True)
    ap.add_argument("--boot-wait", type=float, default=45.0)
    ap.add_argument("--step-wait", type=float, default=3.0)
    ap.add_argument("--key-delay", type=float, default=0.03)
    ap.add_argument("--console-host", default="", help="the exact console hostname (required for wss; no default)")
    ap.add_argument("--layout", choices=("de", "us"), default="de", help="the console's keyboard layout at the login prompt")
    args = ap.parse_args(argv)
    url, vnc_pass = read_secret(args.url_file), read_secret(args.vnc_pass_file)
    root_pass, command = read_secret(args.root_pass_file), read_secret(args.command_file)
    for_layout(root_pass + "root", args.layout)  # refuse an untypable password before anything is sent
    ws = WebSocket(url, insecure_loopback=os.environ.get("MURAGE_CONSOLE_TEST_LOOPBACK") == "1", console_host=args.console_host or None)
    try:
        rfb = Rfb(ws, vnc_pass)
        time.sleep(args.boot_wait)
        type_text(rfb, "\n", args.key_delay)
        time.sleep(args.step_wait)
        type_text(rfb, for_layout("root\n", args.layout), args.key_delay)
        time.sleep(args.step_wait)
        type_text(rfb, for_layout(root_pass + "\n", args.layout), args.key_delay)
        time.sleep(args.step_wait)
        line = command if args.layout == "us" else bootstrap(command)
        type_text(rfb, for_layout(line + "\n", args.layout), args.key_delay)
        time.sleep(args.step_wait)
    finally:
        ws.close()
    print("console-type: typed login and command")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except (OSError, ConnectionError, ValueError, ssl.SSLError) as exc:
        print("console-type: FAIL %s" % exc.__class__.__name__ + (": " + str(exc) if "pass" not in str(exc).lower() else ""), file=sys.stderr)
        sys.exit(1)
