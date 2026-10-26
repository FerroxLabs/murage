#!/usr/bin/python3 -I
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Per-engine outbound allowlist for AI turns (SNI-checking TCP splice proxy).

Runs as the dedicated user murage-egress. The nft output hook (murage-egress.nft)
redirects a turn's tcp/443 to the port of the turn's engine (selected by the
engine group, meta skgid). This proxy reads the TLS ClientHello, checks the SNI
against that engine's allowlist, resolves the name ITSELF (the client's original
destination is never used), refuses non-global addresses, connects to port 443,
replays the ClientHello and splices both ways. No TLS termination, no bytes
logged. Stdlib only.
"""
# Default hosts (egress-allow.json) are vendor-only:
#   claudeAgent: api.anthropic.com, claude.ai, claude.com, platform.claude.com
#     (required API + sign-in hosts; telemetry, updater, mcp-proxy and plugin hosts
#     are deliberately left out) - https://code.claude.com/docs/en/network-config
#     section "Network access requirements".
#   codex: api.openai.com, auth.openai.com, chatgpt.com. OpenAI's Codex docs
#     (https://developers.openai.com/codex/agent-approvals-security) do not enumerate
#     hosts; these come from Codex's ChatGPT sign-in + backend + API-key endpoints
#     and MUST be confirmed on a real VM (watch the refusal log).
#   fuigoAgent: api.fluxrouter.ai (our own router).
# Engines without an entry get nothing; "extra" (owner opt-in) is applied to all.
import asyncio
import ipaddress
import json
import re
import socket
import struct
import sys
import time

# Sorted engine list; port = BASE_PORT + index. murage-egress.nft carries the same
# table (egress-allowlist.test.ts proves they agree; launcher ENGINES is covered too).
ENGINES = ("antigravity", "claudeAgent", "codex", "cursorAgent", "customAcp", "droidAgent", "fuigoAgent", "geminiAgent", "grokAgent", "hermesAgent", "kimiAgent", "opencodeGo", "pi", "qwenAgent")
BASE_PORT = 8810
PORTS = {engine: BASE_PORT + index for index, engine in enumerate(ENGINES)}
# DNS mode (A2): one UDP listener per engine, same sorted order; 5353 (mDNS) is avoided.
# murage-egress.nft redirects a turn's DNS to the port of its engine gid.
DNS_BASE_PORT = 5310
DNS_PORTS = {engine: DNS_BASE_PORT + index for index, engine in enumerate(ENGINES)}
# THE synthetic answer for every allowed name: ordinary global unicast (RIPE 5.0.0.0/8), in no
# special-purpose range, accepted by is_global(). It is never connected to: nft redirects the
# turn's tcp/443 to the engine proxy first. Fixed, never configurable at run time.
DUMMY_ADDRESS = "5.255.0.1"
ALLOWLIST_PATH = "/etc/murage/egress-allow.json"
LISTEN_HOST = "127.0.0.1"
UPSTREAM_PORT = 443
MAX_HELLO = 16384          # whole first TLS record, header included
HELLO_TIMEOUT = 5.0
CONNECT_TIMEOUT = 10.0
RESOLVE_TIMEOUT = 5.0
IDLE_TIMEOUT = 300.0
CHUNK = 65536
MAX_CONNECTIONS = 256      # connections doing work at once
# Accepted sockets are bounded separately: the semaphore alone would let one engine
# park thousands of idle accepted sockets until LimitNOFILE (4096) starves the rest.
# 512 clients + at most 512 upstreams + listeners stays well under it.
MAX_OPEN_PER_ENGINE = 64
MAX_OPEN_TOTAL = 512
EXIT_CONFIG = 78
HOST_RE = re.compile(r"^(?=.{1,253}$)[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*$")
EXT_SNI = 0
EXT_ECH = (0xfe0d, 0xffce)  # encrypted_client_hello (final and draft codepoints)


class Refused(Exception):
    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


class ConfigError(Exception):
    pass


def normalize_host(name):
    """Lowercase, strip one trailing dot, require a plain DNS name (never an IP)."""
    if not isinstance(name, str):
        raise Refused("bad-host")
    host = name.lower()
    if host.endswith("."):
        host = host[:-1]
    if not HOST_RE.match(host):
        raise Refused("bad-host")
    try:
        ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        pass
    else:
        raise Refused("ip-literal")
    if re.fullmatch(r"[0-9.]+", host) or re.fullmatch(r"(0x[0-9a-f]+|[0-9]+)(\.(0x[0-9a-f]+|[0-9]+))*", host):
        raise Refused("ip-literal")
    return host


def parse_sni(data):
    """Return the lowercase SNI of a complete first TLS record holding a ClientHello."""
    if len(data) > MAX_HELLO:
        raise Refused("oversized")
    if len(data) < 5 or data[0] != 0x16 or data[1] != 3:
        raise Refused("not-tls")
    record_len = int.from_bytes(data[3:5], "big")
    if 5 + record_len > MAX_HELLO:
        raise Refused("oversized")
    if len(data) < 5 + record_len:
        raise Refused("truncated")
    body = data[5:5 + record_len]
    try:
        if len(body) < 4 or body[0] != 1:
            raise Refused("not-clienthello")
        hs_len = int.from_bytes(body[1:4], "big")
        if hs_len + 4 > len(body):
            raise Refused("truncated")  # handshake spans records: refuse
        hello = body[4:4 + hs_len]
        pos = 2 + 32
        pos += 1 + hello[pos]                                   # session id
        pos += 2 + int.from_bytes(hello[pos:pos + 2], "big")    # cipher suites
        pos += 1 + hello[pos]                                   # compression
        if pos == len(hello):
            raise Refused("no-sni")
        ext_total = int.from_bytes(hello[pos:pos + 2], "big")
        pos += 2
        if pos + ext_total != len(hello):
            raise Refused("malformed")
        sni = None
        while pos < len(hello):
            if pos + 4 > len(hello):
                raise Refused("malformed")
            ext_type = int.from_bytes(hello[pos:pos + 2], "big")
            ext_len = int.from_bytes(hello[pos + 2:pos + 4], "big")
            ext = hello[pos + 4:pos + 4 + ext_len]
            if len(ext) != ext_len:
                raise Refused("malformed")
            pos += 4 + ext_len
            if ext_type in EXT_ECH:
                raise Refused("ech")  # an outer SNI would not name the real destination
            if ext_type == EXT_SNI:
                if sni is not None:
                    raise Refused("malformed")
                list_len = int.from_bytes(ext[0:2], "big")
                if list_len + 2 != len(ext) or list_len < 3:
                    raise Refused("malformed")
                if ext[2] != 0:
                    raise Refused("malformed")
                name_len = int.from_bytes(ext[3:5], "big")
                if name_len + 5 != len(ext) or name_len == 0:
                    raise Refused("malformed")
                sni = ext[5:5 + name_len]
        if sni is None:
            raise Refused("no-sni")
        try:
            text = sni.decode("ascii")
        except UnicodeDecodeError:
            raise Refused("bad-host")
        return normalize_host(text)
    except (IndexError, ValueError):
        raise Refused("malformed")


def _pattern(value):
    if not isinstance(value, str) or not value or value != value.strip():
        raise ConfigError("allowlist entry must be a non-empty string")
    text = value.lower()
    if text.endswith("."):
        text = text[:-1]
    wildcard = text.startswith("*.")
    base = text[2:] if wildcard else text
    if not HOST_RE.match(base) or "*" in base or re.fullmatch(r"[0-9.]+", base):
        raise ConfigError("allowlist entry is not a host or *.suffix")
    if wildcard and "." not in base:
        raise ConfigError("wildcard needs at least two labels")
    return (wildcard, base)


class Allowlist:
    def __init__(self, engines, extra):
        self.engines = engines
        self.extra = extra

    def allows(self, engine, host):
        for wildcard, base in list(self.engines.get(engine, ())) + list(self.extra):
            if host == base and not wildcard:
                return True
            if wildcard and host.endswith("." + base):
                return True
        return False


def parse_allowlist(text):
    try:
        doc = json.loads(text)
    except ValueError as error:
        raise ConfigError("allowlist is not JSON") from error
    if not isinstance(doc, dict) or not set(doc) <= {"engines", "extra"} or "engines" not in doc:
        raise ConfigError("allowlist must be an object with keys engines (and extra) only")
    if not isinstance(doc["engines"], dict):
        raise ConfigError("engines must be an object")
    engines = {}
    for engine, hosts in doc["engines"].items():
        if engine not in PORTS:
            raise ConfigError("unknown engine in allowlist")
        if not isinstance(hosts, list):
            raise ConfigError("engine hosts must be a list")
        engines[engine] = [_pattern(item) for item in hosts]
    extra = doc.get("extra", [])
    if not isinstance(extra, list):
        raise ConfigError("extra must be a list")
    return Allowlist(engines, [_pattern(item) for item in extra])


def load_allowlist(path=ALLOWLIST_PATH):
    try:
        with open(path, "r", encoding="utf-8") as stream:
            text = stream.read(1 << 20)
    except OSError as error:
        raise ConfigError("allowlist unreadable") from error
    return parse_allowlist(text)


def is_global(address):
    ip = ipaddress.ip_address(address)
    if ip.version == 6 and (ip.ipv4_mapped is not None or ip.sixtofour is not None or ip.teredo is not None):
        return False
    return ip.is_global and not ip.is_multicast


async def default_resolve(host):
    loop = asyncio.get_running_loop()
    infos = await asyncio.wait_for(loop.getaddrinfo(host, UPSTREAM_PORT, type=socket.SOCK_STREAM), RESOLVE_TIMEOUT)
    seen = []
    for info in infos:
        if info[4][0] not in seen:
            seen.append(info[4][0])
    return seen


async def default_connect(address, port):
    return await asyncio.wait_for(asyncio.open_connection(address, port, limit=CHUNK), CONNECT_TIMEOUT)


class RefusalLog:
    """One line per refusal (engine, host, reason), at most one per engine+host per
    window and a global per-minute cap, so a hostile turn cannot flood the journal."""

    def __init__(self, emit=None, clock=time.monotonic, window=60.0, per_minute=30, prefix="egress"):
        self.prefix = prefix
        self.emit = emit or (lambda line: print(line, file=sys.stderr, flush=True))
        self.clock = clock
        self.window = window
        self.per_minute = per_minute
        self.seen = {}
        self.stamps = []

    def refuse(self, engine, host, reason):
        now = self.clock()
        shown = host if isinstance(host, str) and HOST_RE.match(host) else "-"
        key = (engine, shown, reason)
        if now - self.seen.get(key, -1e18) < self.window:
            return False
        self.stamps = [stamp for stamp in self.stamps if now - stamp < 60.0]
        if len(self.stamps) >= self.per_minute:
            return False
        if len(self.seen) > 4096:
            self.seen.clear()
        self.seen[key] = now
        self.stamps.append(now)
        self.emit("%s refused engine=%s host=%s reason=%s" % (self.prefix, engine, shown, reason))
        return True


async def read_hello(reader):
    head = await reader.readexactly(5)
    if head[0] != 0x16 or head[1] != 3:
        raise Refused("not-tls")
    length = int.from_bytes(head[3:5], "big")
    if 5 + length > MAX_HELLO:
        raise Refused("oversized")
    return head + await reader.readexactly(length)


async def pump(source, sink):
    try:
        while True:
            data = await asyncio.wait_for(source.read(CHUNK), IDLE_TIMEOUT)
            if not data:
                break
            sink.write(data)
            await asyncio.wait_for(sink.drain(), IDLE_TIMEOUT)
    except (asyncio.TimeoutError, ConnectionError, OSError, asyncio.IncompleteReadError):
        pass
    finally:
        try:
            if sink.can_write_eof():
                sink.write_eof()
        except (OSError, RuntimeError):
            pass


async def serve_connection(engine, allowlist, reader, writer, resolve=default_resolve, connect=default_connect, log=None, hello_timeout=HELLO_TIMEOUT):
    """Handle one accepted turn connection. Returns the refusal reason or None."""
    host = None
    upstream = None
    try:
        try:
            hello = await asyncio.wait_for(read_hello(reader), hello_timeout)
            host = parse_sni(hello)
            if not allowlist.allows(engine, host):
                raise Refused("not-allowed")
            try:
                addresses = await resolve(host)
            except (OSError, asyncio.TimeoutError):
                raise Refused("resolve-failed")
            usable = [a for a in addresses if is_global(a)]
            if not usable:
                raise Refused("non-global" if addresses else "resolve-failed")
            for address in usable[:4]:
                try:
                    upstream = await connect(address, UPSTREAM_PORT)
                    break
                except (OSError, asyncio.TimeoutError):
                    continue
            if upstream is None:
                raise Refused("connect-failed")
        except (asyncio.TimeoutError, asyncio.IncompleteReadError, ConnectionError):
            raise Refused("hello-timeout-or-short")
        except ValueError:
            raise Refused("malformed")
        up_reader, up_writer = upstream
        up_writer.write(hello)
        await up_writer.drain()
        await asyncio.gather(pump(reader, up_writer), pump(up_reader, writer))
        up_writer.close()
        return None
    except Refused as refusal:
        if log is not None:
            log.refuse(engine, host, refusal.reason)
        return refusal.reason
    finally:
        for stream in ((upstream[1],) if upstream else ()) + (writer,):
            try:
                stream.close()
            except Exception:
                pass


class Admission:
    """Counts accepted client sockets per engine and in total; refuses past the caps."""
    def __init__(self, per_engine=MAX_OPEN_PER_ENGINE, total=MAX_OPEN_TOTAL):
        self.per_engine, self.total, self.open, self.by_engine = per_engine, total, 0, {}

    def enter(self, engine):
        if self.open >= self.total or self.by_engine.get(engine, 0) >= self.per_engine:
            return False
        self.open += 1
        self.by_engine[engine] = self.by_engine.get(engine, 0) + 1
        return True

    def leave(self, engine):
        self.open -= 1
        self.by_engine[engine] -= 1


def make_handler(engine, allowlist, admission, gate, resolve=default_resolve, connect=default_connect, log=None, hello_timeout=HELLO_TIMEOUT):
    async def handler(reader, writer):
        if not admission.enter(engine):
            # Over the cap: close at once, before any read or wait.
            try:
                writer.close()
            except Exception:
                pass
            return
        started = time.monotonic()
        try:
            # The idle (ClientHello) clock runs from accept, including the wait for a work slot.
            try:
                await asyncio.wait_for(gate.acquire(), hello_timeout)
            except asyncio.TimeoutError:
                if log is not None:
                    log.refuse(engine, None, "hello-timeout-or-short")
                writer.close()
                return
            try:
                await serve_connection(engine, allowlist, reader, writer, resolve, connect, log,
                                       hello_timeout=max(0.001, hello_timeout - (time.monotonic() - started)))
            finally:
                gate.release()
        finally:
            admission.leave(engine)
    return handler


async def run(allowlist, log=None, resolve=default_resolve, connect=default_connect, host=LISTEN_HOST):
    log = log or RefusalLog()
    gate = asyncio.Semaphore(MAX_CONNECTIONS)
    admission = Admission()
    servers = []
    for engine, port in PORTS.items():
        handler = make_handler(engine, allowlist, admission, gate, resolve, connect, log)
        servers.append(await asyncio.start_server(handler, host, port, limit=CHUNK, backlog=128))
    await asyncio.gather(*(server.serve_forever() for server in servers))

# ---------------------------------------------------------------------------
# DNS mode (A2). A turn's resolver is redirected by nft to the per-engine UDP port below. The
# forwarder answers SYNTHETICALLY and forwards NOTHING upstream: an allowed name gets the fixed
# DUMMY_ADDRESS (the turn's tcp/443 is redirected to the SNI proxy, which resolves the real
# address itself), every other name gets NXDOMAIN. The verdict is dns_lookup(), which only calls
# normalize_host() and Allowlist.allows(): the same objects the SNI path uses.
# ---------------------------------------------------------------------------
DNS_TTL = 30
DNS_EDNS_SIZE = 1232
DNS_MAX_QUERY = 1232
DNS_RATE = 100.0           # queries per second per engine
DNS_BURST = 200.0
DNS_TOTAL_RATE = 600.0     # all engines together
DNS_TOTAL_BURST = 1200.0
RC_NOERROR, RC_FORMERR, RC_NXDOMAIN, RC_NOTIMP = 0, 1, 3, 4
DNS_LABEL_RE = re.compile(rb"[A-Za-z0-9_-]+")


class DnsFormat(Exception):
    pass


def dns_lookup(allowlist, engine, name):
    """Return (allowed, normalized host or None) for a queried name."""
    try:
        host = normalize_host(name)
    except Refused:
        return False, None
    return allowlist.allows(engine, host), host


def dns_allows(allowlist, engine, name):
    return dns_lookup(allowlist, engine, name)[0]


def _dns_question(packet):
    """Strict parse of exactly one plain question at offset 12: (labels, qtype, qclass, end)."""
    pos = 12
    total = 1
    labels = []
    while True:
        if pos >= len(packet):
            raise DnsFormat()
        size = packet[pos]
        if size == 0:
            pos += 1
            break
        if size > 63:                      # compression pointer or extended label type
            raise DnsFormat()
        label = packet[pos + 1:pos + 1 + size]
        total += size + 1
        if len(label) != size or total > 255 or not DNS_LABEL_RE.fullmatch(label):
            raise DnsFormat()
        labels.append(label.decode("ascii"))
        pos += 1 + size
    if pos + 4 > len(packet):
        raise DnsFormat()
    qtype, qclass = struct.unpack(">HH", packet[pos:pos + 4])
    return labels, qtype, qclass, pos + 4


def _dns_opt(rest):
    """Exactly one well-formed OPT RR (root owner, version 0) must fill `rest`."""
    if len(rest) < 11 or rest[0] != 0 or int.from_bytes(rest[1:3], "big") != 41:
        raise DnsFormat()
    if rest[5] != 0 or rest[6] != 0:       # extended rcode, EDNS version
        raise DnsFormat()
    if len(rest) != 11 + int.from_bytes(rest[9:11], "big"):
        raise DnsFormat()
    options = rest[11:]
    pos = 0
    while pos < len(options):               # skipped, never interpreted; structure must hold
        if pos + 4 > len(options):
            raise DnsFormat()
        pos += 4 + int.from_bytes(options[pos + 2:pos + 4], "big")
        if pos > len(options):
            raise DnsFormat()


def _dns_reply(ident, rd, opcode, rcode, question, answer, opt):
    flags = 0x8000 | (opcode << 11) | rd | 0x0080 | rcode
    out = ident + struct.pack(">HHHHH", flags, 1 if question else 0, 1 if answer else 0, 0, 1 if opt else 0)
    out += question or b""
    if answer:
        out += b"\xc0\x0c" + struct.pack(">HHIH", 1, 1, DNS_TTL, 4) + socket.inet_aton(DUMMY_ADDRESS)
    if opt:
        out += b"\x00" + struct.pack(">HHIH", 41, DNS_EDNS_SIZE, 0, 0)
    return out


def dns_respond(engine, allowlist, packet, log=None):
    """Pure decision: query packet in, reply packet (or None to drop) out. No I/O, no upstream."""
    if len(packet) < 12:
        return None
    ident = packet[:2]
    flags = int.from_bytes(packet[2:4], "big")
    if flags & 0x8000:                      # never answer a response
        return None
    opcode = (flags >> 11) & 15
    rd = flags & 0x0100
    qd, an, ns, ar = struct.unpack(">HHHH", packet[4:12])
    try:
        labels, qtype, qclass, end = _dns_question(packet)
        question = packet[12:end]
    except DnsFormat:
        labels = question = None
    echo = question if qd == 1 else None
    if opcode != 0:
        return _dns_reply(ident, rd, opcode, RC_NOTIMP, None, False, False)
    if qd != 1 or an or ns or ar > 1 or question is None:
        return _dns_reply(ident, rd, 0, RC_FORMERR, echo, False, False)
    rest = packet[end:]
    try:
        if ar == 1:
            _dns_opt(rest)
        elif rest:
            raise DnsFormat()
    except DnsFormat:
        return _dns_reply(ident, rd, 0, RC_FORMERR, echo, False, False)
    opt = ar == 1
    if qclass != 1:
        return _dns_reply(ident, rd, 0, RC_NOTIMP, question, False, opt)
    allowed, host = dns_lookup(allowlist, engine, ".".join(labels))
    if not allowed:
        if log is not None:
            log.refuse(engine, host, "not-allowed" if host else "bad-host")
        return _dns_reply(ident, rd, 0, RC_NXDOMAIN, question, False, opt)
    return _dns_reply(ident, rd, 0, RC_NOERROR, question, qtype == 1, opt)


class TokenBucket:
    def __init__(self, rate, burst, clock=time.monotonic):
        self.rate, self.burst, self.clock = rate, burst, clock
        self.tokens, self.stamp = burst, clock()

    def take(self):
        now = self.clock()
        self.tokens = min(self.burst, self.tokens + (now - self.stamp) * self.rate)
        self.stamp = now
        if self.tokens >= 1.0:
            self.tokens -= 1.0
            return True
        return False


class DnsProtocol(asyncio.DatagramProtocol):
    def __init__(self, engine, allowlist, bucket, shared, log):
        self.engine, self.allowlist, self.bucket, self.shared, self.log = engine, allowlist, bucket, shared, log
        self.transport = None

    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, data, addr):
        if len(data) > DNS_MAX_QUERY or not self.bucket.take() or not self.shared.take():
            return                           # over the cap: drop, never forward
        try:
            reply = dns_respond(self.engine, self.allowlist, data, self.log)
        except Exception:
            return
        if reply is not None:
            self.transport.sendto(reply, addr)

    def error_received(self, exc):
        pass


async def start_dns(allowlist, log=None, host=LISTEN_HOST, ports=None):
    log = log or RefusalLog(prefix="dns")
    shared = TokenBucket(DNS_TOTAL_RATE, DNS_TOTAL_BURST)
    loop = asyncio.get_running_loop()
    transports = []
    for engine, port in (DNS_PORTS if ports is None else ports).items():
        protocol = DnsProtocol(engine, allowlist, TokenBucket(DNS_RATE, DNS_BURST), shared, log)
        transport, _ = await loop.create_datagram_endpoint(lambda: protocol, local_addr=(host, port), family=socket.AF_INET)
        transports.append(transport)
    return transports


async def run_dns(allowlist, log=None, host=LISTEN_HOST):
    await start_dns(allowlist, log, host)
    await asyncio.get_running_loop().create_future()   # serve until the unit stops


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    mode = "sni"
    if argv and argv[0] == "dns":
        mode, argv = "dns", argv[1:]
    path = argv[0] if argv else ALLOWLIST_PATH
    try:
        allowlist = load_allowlist(path)
    except ConfigError as error:
        print("egress %s refuses to start: %s" % ("dns" if mode == "dns" else "proxy", error), file=sys.stderr, flush=True)
        return EXIT_CONFIG
    try:
        asyncio.run(run_dns(allowlist) if mode == "dns" else run(allowlist))
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
