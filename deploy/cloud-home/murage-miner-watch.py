#!/usr/bin/python3 -I
# SPDX-License-Identifier: AGPL-3.0-or-later
"""CPU-mining heuristic for a Murage Cloud home (B5 abuse control).

Samples /proc every SAMPLE_S seconds. A process that is not on our engine/system list and keeps
>= BUSY_PCT of one core for SUSTAIN_S seconds is flagged. It never alerts directly: it drops
{"type":"abuse.mining_suspected","at":<ms>} as a file in /var/lib/murage-home/events/ and the heartbeat carries it to
the control plane. A process whose name is a well-known miner is flagged on the first sample. It never kills anything: a customer's
own legitimate build must not be destroyed by a heuristic; a human reviews the flag.
"""
import json, os, sys, time

SAMPLE_S = 30
SUSTAIN_S = 600
BUSY_PCT = 90.0
EVENTS = "/var/lib/murage-home/events"
ALLOW_FILE = "/etc/murage-home/miner-watch-allow.json"
KNOWN_MINERS = {"xmrig", "xmr-stak", "minerd", "cpuminer", "cgminer", "bfgminer", "ethminer", "nbminer", "t-rex", "lolminer",
                "kryptex", "nanominer", "srbminer", "cpuminer-opt", "ccminer", "moneroocean"}
# Engines (egress-allow.json keys), the Murage server and its helpers, and ordinary system work.
DEFAULT_ALLOW = {"node", "claude", "codex", "cursor-agent", "fuigo", "gemini", "grok", "kimi", "opencode", "python3", "pasta", "bwrap",
                 "chrome", "chromium", "chrome-headless", "caddy", "cloudflared", "systemd", "systemd-journal", "apt", "apt-get",
                 "dpkg", "unattended-upgr", "cryptsetup", "kworker", "ksoftirqd", "murage-egress-proxy", "murage-control"}


def load_allow(path=ALLOW_FILE):
    allow = set(DEFAULT_ALLOW)
    try:
        with open(path) as f:
            allow |= {str(x).lower() for x in json.load(f).get("allow", [])}
    except (OSError, ValueError):
        pass
    return allow


def read_procs(proc="/proc"):
    """{pid: (name, utime+stime ticks)} for every readable process."""
    out = {}
    for pid in os.listdir(proc):
        if not pid.isdigit():
            continue
        try:
            with open("%s/%s/stat" % (proc, pid)) as f:
                data = f.read()
            name = data[data.index("(") + 1:data.rindex(")")]
            rest = data[data.rindex(")") + 2:].split()
            out[int(pid)] = (name.lower(), int(rest[11]) + int(rest[12]))
        except (OSError, ValueError, IndexError):
            continue
    return out


class Watch:
    """Pure state machine: feed it (now, procs) samples, it returns newly flagged processes."""

    def __init__(self, allow, hz=100, sustain_s=SUSTAIN_S, busy_pct=BUSY_PCT):
        self.allow, self.hz, self.sustain_s, self.busy_pct = allow, hz, sustain_s, busy_pct
        self.last = None
        self.busy_since = {}
        self.flagged = set()

    def sample(self, now, procs):
        flags = []
        if self.last is not None:
            dt = now - self.last[0]
            for pid, (name, ticks) in procs.items():
                prev = self.last[1].get(pid)
                if prev is None or prev[0] != name or dt <= 0:
                    self.busy_since.pop(pid, None)
                    continue
                pct = (ticks - prev[1]) / self.hz / dt * 100.0
                if pct >= self.busy_pct and name not in self.allow:
                    since = self.busy_since.setdefault(pid, now - dt)
                    if now - since >= self.sustain_s and pid not in self.flagged:
                        self.flagged.add(pid)
                        flags.append({"pid": pid, "name": name, "reason": "sustained_cpu", "seconds": int(now - since), "cpu_pct": round(pct, 1)})
                else:
                    self.busy_since.pop(pid, None)
        for pid, (name, _) in procs.items():
            if name in KNOWN_MINERS and pid not in self.flagged:
                self.flagged.add(pid)
                flags.append({"pid": pid, "name": name, "reason": "known_miner", "seconds": 0, "cpu_pct": 0})
        for pid in list(self.busy_since):
            if pid not in procs:
                del self.busy_since[pid]
        self.last = (now, procs)
        return flags


def write_event(pid, now_ms=None, events=EVENTS):
    """One small file per detection, written atomically (dot-prefixed temp name, then rename)."""
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    os.makedirs(events, mode=0o755, exist_ok=True)
    name = "abuse.mining_suspected-%d-%d.json" % (now_ms, pid)
    tmp = os.path.join(events, "." + name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump({"type": "abuse.mining_suspected", "at": now_ms}, f)
    os.replace(tmp, os.path.join(events, name))
    return name


def selftest():
    w = Watch({"node"}, hz=100, sustain_s=600)
    t = 0
    procs = lambda ticks: {10: ("kworker", 1), 20: ("a.out", ticks), 30: ("node", ticks)}
    assert w.sample(t, procs(0)) == []
    flagged = []
    for i in range(1, 25):
        t += 30
        flagged += w.sample(t, procs(i * 30 * 100))  # 100% of a core every interval
    assert [f["name"] for f in flagged] == ["a.out"], flagged  # node is on the list; kworker idle
    assert flagged[0]["reason"] == "sustained_cpu" and flagged[0]["seconds"] >= 600
    # A burst shorter than the window is not flagged, and the clock resets when it stops.
    w = Watch(set(), hz=100, sustain_s=600)
    w.sample(0, {5: ("make", 0)})
    assert w.sample(30, {5: ("make", 3000)}) == []
    assert w.sample(60, {5: ("make", 3000)}) == []
    assert 5 not in w.busy_since
    # 50% load never counts.
    w = Watch(set(), hz=100, sustain_s=60)
    w.sample(0, {5: ("x", 0)})
    for i in range(1, 10):
        assert w.sample(i * 30, {5: ("x", i * 1500)}) == []
    # Known miner names flag at once; a recycled pid with another name resets accounting.
    w = Watch(set())
    assert w.sample(0, {7: ("xmrig", 0)})[0]["reason"] == "known_miner"
    w = Watch(set(), sustain_s=30)
    w.sample(0, {9: ("a", 0)}); w.sample(30, {9: ("b", 99999)})
    assert 9 not in w.busy_since
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        ev = os.path.join(d, "events")
        name = write_event(42, 1234567890123, ev)
        assert os.listdir(ev) == [name], os.listdir(ev)  # no temp file left behind
        assert json.load(open(os.path.join(ev, name))) == {"type": "abuse.mining_suspected", "at": 1234567890123}
    print("selftest ok")


def main():
    hz = os.sysconf("SC_CLK_TCK")
    watch = Watch(load_allow(), hz=hz)
    while True:
        for flag in watch.sample(time.monotonic(), read_procs()):
            write_event(flag["pid"])
        time.sleep(SAMPLE_S)


if __name__ == "__main__":
    selftest() if "--selftest" in sys.argv else main()
