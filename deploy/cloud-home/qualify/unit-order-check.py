#!/usr/bin/python3 -I
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Boot ordering check for the home image: proves the start transaction has no ordering cycle.

systemd breaks an ordering cycle at boot by deleting one job of the cycle, and it picks a different job on different
boots. A cycle between murage-backup-authorize.service and cloud-final.service once deleted cloud-final, so cloud-init
runcmd never ran. This script rebuilds the ordering graph from the unit files under a root (the real image at build
time, or a copy in a container or a test fixture) and fails if any transaction it checks contains a cycle.

What it models, from systemd.unit(5) and systemd.special(7):
  - explicit After=/Before=, Wants=/Requires=/Requisite=/BindsTo=/Upholds=, RequiresMountsFor=, drop-ins (name.d/*.conf),
    .wants/ and .requires/ directories (what `systemctl enable` and generators create), aliases and masks;
  - default dependencies: services/sockets/paths/timers/mounts order after sysinit.target (services after basic.target),
    and a target orders itself after every unit it pulls in unless that unit has DefaultDependencies=no or the target
    is already ordered before it;
  - cloud-init's generator, which links cloud-init.target into multi-user.target.wants at boot (it runs only at boot,
    so it is emulated here when cloud-init.target exists).
Checked transactions: the default target, plus every local unit (under /etc/systemd/system) started on its own, which
is how a .path or .timer trigger or a manual start enqueues it.

Usage: unit-order-check.py [--root DIR] [--target UNIT] [--dot FILE]
Exit 0: no cycle. Exit 1: a cycle, printed as "ordering cycle (starting U): a -> b -> ... -> a" where "a -> b" means
a starts before b. Exit 2: usage or load error.
"""
import os
import sys

UNIT_DIRS = ["etc/systemd/system", "run/systemd/generator.early", "run/systemd/system", "run/systemd/generator",
             "usr/local/lib/systemd/system", "usr/lib/systemd/system", "lib/systemd/system", "run/systemd/generator.late"]
PULL = ("Wants", "Requires", "Requisite", "BindsTo", "Upholds")
KEYS = set(PULL) | {"After", "Before", "DefaultDependencies", "RequiresMountsFor"}

class Units:
    def __init__(self, root):
        self.root = root.rstrip("/") or "/"
        self.dirs = []
        seen = set()
        for rel in UNIT_DIRS:
            path = os.path.join(self.root, rel)
            if os.path.isdir(path):
                real = os.path.realpath(path)
                if real not in seen:  # /lib is a symlink to /usr/lib on merged-/usr systems
                    seen.add(real)
                    self.dirs.append(path)
        self.cache = {}

    def inside(self, link, base):
        target = os.readlink(link)
        if target.startswith("/"):
            return os.path.join(self.root, target.lstrip("/"))
        return os.path.normpath(os.path.join(base, target))

    def find(self, name):
        """(canonical name, fragment path or None, masked) for a unit name, following alias symlinks."""
        for _ in range(16):
            for d in self.dirs:
                path = os.path.join(d, name)
                if not os.path.lexists(path):
                    continue
                if os.path.islink(path):
                    target = os.readlink(path)
                    if target == "/dev/null":
                        return name, None, True
                    resolved = self.inside(path, d)
                    alias = os.path.basename(resolved)
                    if alias != name:  # an alias such as default.target -> graphical.target
                        name = alias
                        break
                    if os.path.isfile(resolved):
                        return name, resolved, False
                    continue
                if os.path.isfile(path):
                    return name, path, False
            else:
                if "@." not in name and "@" in name:  # instance unit: fall back to its template
                    prefix, rest = name.split("@", 1)
                    template = prefix + "@" + rest[rest.index("."):] if "." in rest else None
                    if template:
                        _, fragment, masked = self.find(template)
                        return name, fragment, masked
                return name, None, False
        return name, None, False

    def load(self, name):
        if name in self.cache:
            return self.cache[name]
        canonical, fragment, masked = self.find(name)
        if canonical != name:
            unit = self.load(canonical)
            self.cache[name] = unit
            return unit
        unit = {"name": name, "loaded": fragment is not None and not masked, "masked": masked,
                "DefaultDependencies": True, **{k: [] for k in KEYS - {"DefaultDependencies"}}}
        self.cache[name] = unit
        if not unit["loaded"]:
            return unit
        files = [fragment]
        for d in self.dirs:
            dropin = os.path.join(d, name + ".d")
            if os.path.isdir(dropin):
                files += [os.path.join(dropin, f) for f in sorted(os.listdir(dropin)) if f.endswith(".conf")]
        for path in files:
            parse(path, unit)
        for d in self.dirs:
            for kind, key in ((".wants", "Wants"), (".requires", "Requires")):
                linkdir = os.path.join(d, name + kind)
                if os.path.isdir(linkdir):
                    unit[key] += sorted(os.listdir(linkdir))
        return unit

def parse(path, unit):
    section = None
    with open(path, encoding="utf-8", errors="replace") as stream:
        lines = stream.read().replace("\\\n", " ").splitlines()
    for line in lines:
        line = line.strip()
        if not line or line[0] in "#;":
            continue
        if line.startswith("["):
            section = line.strip("[]")
            continue
        if section != "Unit" or "=" not in line:
            continue
        key, value = (part.strip() for part in line.split("=", 1))
        if key not in KEYS:
            continue
        if key == "DefaultDependencies":
            unit[key] = value.lower() in ("1", "yes", "true", "on")
        elif not value:
            unit[key] = []  # an empty assignment resets the list
        else:
            unit[key] += [word for word in value.split() if "%" not in word]

def mount_unit(path):
    path = path.strip("/")
    return ("-".join(path.split("/")) if path else "-") + ".mount"

def suffix(name):
    return name.rsplit(".", 1)[-1]

def graph(units, roots, cloud_init_generator):
    """Transaction closure from roots, and its ordering edges (a -> b means a starts before b)."""
    members, queue = set(), list(roots)
    while queue:
        name = units.load(queue.pop()).get("name")
        if name in members:
            continue
        unit = units.load(name)
        if not unit["loaded"]:
            continue
        members.add(name)
        pulled = [n for key in PULL for n in unit[key]]
        pulled += [mount_unit(p) for p in unit["RequiresMountsFor"]]
        if unit["DefaultDependencies"] and suffix(name) in ("service", "socket", "path", "timer"):
            pulled.append("sysinit.target")
            if suffix(name) == "service":
                pulled.append("basic.target")
        if cloud_init_generator and name == "multi-user.target" and units.load("cloud-init.target")["loaded"]:
            pulled.append("cloud-init.target")
        queue += [units.load(n)["name"] for n in pulled]
    before = {name: set() for name in members}
    def order(a, b):
        a, b = units.load(a)["name"], units.load(b)["name"]
        if a in members and b in members and a != b:
            before[a].add(b)
    for name in members:
        unit = units.load(name)
        for other in unit["After"]:
            order(other, name)
        for other in unit["Before"]:
            order(name, other)
        for path in unit["RequiresMountsFor"]:
            order(mount_unit(path), name)
        if unit["DefaultDependencies"]:
            kind = suffix(name)
            if kind in ("service", "socket", "path", "timer"):
                order("sysinit.target", name)
            if kind == "service":
                order("basic.target", name)
            if kind == "timer":
                order(name, "timers.target")
            if kind == "path":
                order(name, "paths.target")
            if kind == "socket":
                order(name, "sockets.target")
            if kind == "mount":
                order("local-fs-pre.target", name)
                order(name, "local-fs.target")
    for name in members:  # targets last: their default After= is skipped when an explicit Before= already exists
        unit = units.load(name)
        if suffix(name) != "target" or not unit["DefaultDependencies"]:
            continue
        pulled = [n for key in PULL for n in unit[key]]
        if cloud_init_generator and name == "multi-user.target":
            pulled.append("cloud-init.target")
        for other in pulled:
            o = units.load(other)
            if o["loaded"] and o["DefaultDependencies"] and o["name"] in members and o["name"] not in before[name]:
                order(o["name"], name)
    return members, before

def cycles(before):
    """Every strongly connected component with more than one unit, each as one concrete cycle."""
    index, low, stack, on, found, counter = {}, {}, [], set(), [], [0]
    sys.setrecursionlimit(100000)
    def visit(v):
        index[v] = low[v] = counter[0]; counter[0] += 1
        stack.append(v); on.add(v)
        for w in sorted(before[v]):
            if w not in index:
                visit(w); low[v] = min(low[v], low[w])
            elif w in on:
                low[v] = min(low[v], index[w])
        if low[v] == index[v]:
            component = []
            while True:
                w = stack.pop(); on.discard(w); component.append(w)
                if w == v:
                    break
            if len(component) > 1:
                found.append(path_in(sorted(component), before))
    for v in sorted(before):
        if v not in index:
            visit(v)
    return found

def path_in(component, before):
    members, start = set(component), component[0]
    parents, queue = {start: None}, [start]
    while queue:
        v = queue.pop(0)
        for w in sorted(before[v]):
            if w == start:
                cycle = [w]
                while v is not None:
                    cycle.append(v); v = parents[v]
                return list(reversed(cycle))
            if w in members and w not in parents:
                parents[w] = v; queue.append(w)
    return component + [start]

def main(argv):
    root, target, dot, generator = "/", "default.target", None, True
    args = list(argv)
    while args:
        flag = args.pop(0)
        if flag == "--root" and args:
            root = args.pop(0)
        elif flag == "--target" and args:
            target = args.pop(0)
        elif flag == "--dot" and args:
            dot = args.pop(0)
        elif flag == "--no-cloud-init-generator":
            generator = False
        else:
            print(__doc__.strip().split("\n\n")[-1], file=sys.stderr)
            return 2
    units = Units(root)
    if not units.load(target)["loaded"]:
        print("unit-order-check: %s not found under %s" % (target, root), file=sys.stderr)
        return 2
    local = os.path.join(units.root, "etc/systemd/system")
    roots = [[target]]
    if os.path.isdir(local):
        roots += [[f] for f in sorted(os.listdir(local)) if not os.path.islink(os.path.join(local, f))
                  and os.path.isfile(os.path.join(local, f)) and suffix(f) in ("service", "mount", "path", "timer", "socket", "target")]
    failed, reported, checked = False, set(), 0
    for group in roots:
        members, before = graph(units, group, generator)
        checked += 1
        if dot and group[0] == target:
            with open(dot, "w") as stream:
                stream.write("digraph boot {\n")
                for a in sorted(before):
                    for b in sorted(before[a]):
                        stream.write('  "%s" -> "%s";\n' % (a, b))
                stream.write("}\n")
        for cycle in cycles(before):
            key = frozenset(cycle)
            if key in reported:
                continue
            reported.add(key); failed = True
            print("ordering cycle (starting %s): %s" % (units.load(group[0])["name"], " -> ".join(cycle)))
    if failed:
        return 1
    print("unit-order-check: no ordering cycle in %d transactions (default target %s)" % (checked, units.load(target)["name"]))
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
