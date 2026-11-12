#!/bin/sh
# r3.3 grant-writer and persistence-sink inventory (Astra r3.2 M4, L1). Read-only; runs no repo code.
# Usage: sh spec/sites.sh [/root/fuigo-builds/orph/_base]
# For every sink pattern: every hit (tests excluded), its enclosing function, nearest route, whether it sits in
# the engine-callable internal block, and (one level) which callers reach the enclosing function and from where.
# The builder's T17s ports this: any hit not in the r3.3 table fails with "classify this writer".
set -u
BASE=${1:-/root/fuigo-builds/orph/_base}
cd "$BASE" || exit 2
echo "base=$(git rev-parse --short HEAD 2>/dev/null)"
python3 -I - "$BASE" <<'PY'
import os, re, subprocess, sys
base = sys.argv[1]
SINKS = [
 ("G1 task allowance", r"taskAllowances\.grant\("),
 ("G2 routine/webhook apply", r"routineRequests!?\.resolve\(|settleAutomationProposal\(|resolveAndSendRoutine\("),
 ("G3 skill apply", r"resolveSkillRequest\(|applyStagedSkillWrite\("),
 ("G4 setup auto-approve predicate", r"fullAccessApprovesSetup\("),
 ("G5 bot level/lead/consent", r"store\.(patchBot|patchTask|setLevelEverywhere|setChiefOfStaff)\("),
 ("G5b bot create/manage", r"store\.createBot\(|\bmanageBot\("),
 ("G6 remembered Always allow", r"rememberAndAnswer\(|rememberGrantAndAnswer\(|planAlwaysAllowSet\("),
 ("G7 alwaysAllow by settings", r"body\.alwaysAllow"),
 ("G8 host-computer consent", r"rememberHostComputerConsent\b|resolveHostComputerConsent\(|hostComputerConsent = |hostComputerConsent: \"allowed\""),
 ("G9 folder trust", r"folderTrust\.remember\(|rememberPickedFolder\("),
 ("G10 routine enable", r"enabled: true|enabled: operation\.action"),
 ("G11 skill enable", r"installPreparedSkill\(|updatePreparedSkill\("),
 ("G12 MCP persistence sink", r"persistMcpServers\(|enableMcpServer\(|cfg\.mcpServers\s*=[^=]|saveMcpServers\("),
 ("G12b connectors", r"composio\w*\.(connect|enable|add|save)\w*\(|connectors\w*\.(enable|add|save|set)\w*\("),
 ("G13 direct engine answers", r"\.respondToRequest\("),
 ("A1 answer minting", r"\banswerRequest\(|\brespondToCard\("),
]
SCOPE = {"G10 routine enable": ["server/routine-requests.ts"]}
def rg(pat, paths):
    r = subprocess.run(["rg", "-P", "-n", "--with-filename", "--no-heading", pat, *paths, "--glob", "!*.test.ts", "--glob", "!**/testing/**"],
                       capture_output=True, text=True)
    out = []
    for l in r.stdout.splitlines():
        f, n, txt = l.split(":", 2)
        out.append((f, int(n), txt))
    return out
cache = {}
def lines(f):
    if f not in cache:
        cache[f] = open(os.path.join(base, f), encoding="utf-8", errors="replace").read().split("\n")
    return cache[f]
idx = lines("server/index.ts")
lo = next(i + 1 for i, l in enumerate(idx) if 'path.startsWith("/api/internal/")' in l)
hi = next(i + 1 for i, l in enumerate(idx) if 'unknown internal endpoint' in l and i + 1 > lo)
print("internal block index.ts:%d-%d (engine-callable)" % (lo, hi))
FN = re.compile(r"^(?:export\s+)?(?:async\s+)?function\s+(\w+)")          # top-level only (column 0)
RT = re.compile(r'method === "(\w+)"(.{0,110})')
def ctx(f, n):
    """(top-level fn, nearest route `if (method === ...)` inside that fn, zone)."""
    L = lines(f); fn = route = None
    for i in range(n - 1, -1, -1):
        m = FN.match(L[i])
        if m:
            fn = (m.group(1), i + 1)
            break
        if route is None:
            r = RT.search(L[i])
            if r:
                rest = re.sub(r"\s+", " ", L[i].strip())
                pm = re.search(r'"(/api/[^"]*)"|path\.match\(/\^?(.{0,60}?)\$?/\)', rest)
                route = (r.group(1) + " " + ((pm.group(1) or pm.group(2)) if pm else rest[:60]), i + 1)
    zone = "ENGINE" if f == "server/index.ts" and lo <= n <= hi else "other"
    return fn, route, zone
engine_reach = []
for name, pat in SINKS:
    hits = rg(pat, SCOPE.get(name, ["server"]))
    print("\n## %s   /%s/   hits=%d" % (name, pat, len(hits)))
    for f, n, txt in hits:
        fn, route, zone = ctx(f, n)
        defn = bool(re.match(r"^\s*(export\s+)?(async\s+)?function\s", txt))
        callers = ""
        if fn and not defn and zone == "other" and route is None:
            ch = rg(r"(?<![.\w])%s\(" % re.escape(fn[0]), ["server"])
            cz = []
            for cf, cn, ct in ch:
                if (cf, cn) == (f, fn[1]) or re.match(r"^\s*(export\s+)?(async\s+)?function\s", ct):
                    continue
                _, croute, czone = ctx(cf, cn)
                cfn = ctx(cf, cn)[0]
                cz.append("%s:%d%s%s" % (cf.replace("server/", ""), cn, "[ENGINE]" if czone == "ENGINE" else "",
                                        ("{" + croute[0] + "}") if croute else ("<" + cfn[0] + ">" if cfn else "")))
                if czone == "ENGINE":
                    engine_reach.append((name, "%s:%d" % (f, n), "via %s:%d" % (cf, cn)))
            callers = " callers=" + (",".join(cz[:12]) + (" +%d" % (len(cz) - 12) if len(cz) > 12 else "") if cz else "none")
        if zone == "ENGINE":
            engine_reach.append((name, "%s:%d" % (f, n), "in internal block"))
        print("%-4s %s:%d  fn=%s route=%s%s%s  | %s" % (
            "DEF" if defn else zone[:3], f.replace("server/", ""), n, "(route handler)" if route else (fn[0] if fn else "-"),
            ("{" + route[0] + "}") if route else "-", "" if not route else "@%d" % route[1], callers, txt.strip()[:110]))
print("\n## ENGINE-REACHABLE SINK SITES (each must be classified in r3.3 section 5)")
for e in engine_reach:
    print("  %-30s %-28s %s" % e)
PY
