#!/usr/bin/python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Root-only atomic firewall loader and pure browser network inventory checks."""
import importlib.machinery
import importlib.util
import ipaddress
import json
import os
import re
import subprocess

POOL = ipaddress.ip_network("10.253.0.0/16")
POLICY = "/etc/murage-home/murage-egress.nft"
HELPER = "/usr/local/libexec/murage-browser-namespace"
ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C"}


def network_context(system):
    # iproute2 emits linkinfo only with details; otherwise virtual links
    # look like physical Ethernet and cannot be rejected by kind.
    links = system.json("-details", "link", "show")
    routes = system.json("-4", "route", "show", "table", "all")
    addresses = system.json("-4", "address", "show")
    defaults = [r for r in routes if r.get("dst") in {"default", "0.0.0.0/0"}]
    if len(defaults) != 1 or defaults[0].get("table", "main") not in {"main", 254} or any(k in defaults[0] for k in ("multipath", "nexthops", "nhid")):
        raise ValueError("A unique browser default route is required")
    dev = defaults[0].get("dev", "")
    link = next((v for v in links if v.get("ifname") == dev), None)
    if (not link or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,15}", dev)
            or dev == "lo" or dev.startswith("mb") or link.get("link_type") != "ether"
            or link.get("linkinfo", {}).get("info_kind") or not isinstance(link.get("ifindex"), int)):
        raise ValueError("Invalid browser outbound interface")
    owned = set()
    for item in links:
        match = re.fullmatch(r"mbh([0-9a-f]+)", item.get("ifname", ""))
        if match and 1 <= int(match[1], 16) <= 16382 and re.fullmatch(r"murage-browser:[A-Za-z0-9_-]+:[0-9a-f]{32}", item.get("ifalias", "")):
            owned.add(item["ifname"])
    for route in routes:
        destination = route.get("dst", "default")
        if destination in {"default", "0.0.0.0/0"}: continue
        network = ipaddress.ip_network(destination, strict=False)
        if network.overlaps(POOL):
            name = route.get("dev", "")
            if name not in owned:
                raise ValueError("Browser subnet pool overlaps a host route")
            slot = int(name[3:], 16)
            subnet = ipaddress.ip_network((int(POOL.network_address) + slot * 4, 30))
            if not network.subnet_of(subnet):
                raise ValueError("Unexpected browser interface route")
    host_addresses = []
    for address in addresses:
        name = address["ifname"]
        for item in address.get("addr_info", []):
            if item.get("family") != "inet": continue
            local = ipaddress.ip_address(item["local"])
            network = ipaddress.ip_network(f'{local}/{item["prefixlen"]}', strict=False)
            if name in owned:
                subnet = ipaddress.ip_network((int(POOL.network_address) + int(name[3:], 16) * 4, 30))
                if network != subnet or local != subnet[1]:
                    raise ValueError("Unexpected browser interface address")
                continue
            if network.overlaps(POOL):
                raise ValueError("Browser subnet pool overlaps a host address")
            host_addresses.append(str(local))
    return {"dev": dev, "index": link["ifindex"], "addresses": sorted(set(host_addresses))}


def blocks(text):
    """Read only the fixed declarative table/object grammar, not arbitrary nft input."""
    text = re.sub(r"#[^\n]*", "", text)
    position = 0
    while text[position:].strip():
        match = re.match(r"\s*([a-z_]+)\s+([A-Za-z0-9_ ]+)\s*\{", text[position:])
        if not match: raise ValueError("Invalid firewall template")
        begin = position + match.end()
        depth, end = 1, begin
        while depth and end < len(text):
            if text[end] == "{": depth += 1
            elif text[end] == "}": depth -= 1
            end += 1
        if depth: raise ValueError("Invalid firewall template")
        yield match[1], match[2].strip(), text[begin:end-1]
        position = end


def firewall_batch(template, inventory, context, tuples):
    existing = set()
    for entry in inventory.get("nftables", []):
        for kind in ("table", "chain", "set", "limit"):
            item = entry.get(kind)
            if item: existing.add((kind, item.get("family"), item.get("table"), item.get("name")))
    lines = []
    for kind, identity, body in blocks(template):
        family, table = identity.split()
        if kind != "table" or (family, table) not in {("inet", "murage_home"), ("ip", "murage_browser_nat")}:
            raise ValueError("Unexpected firewall table")
        if ("table", family, None, table) not in existing: lines.append(f"add table {family} {table}")
        # Every chain must exist before any rule jumps to it (nft resolves
        # jump targets while applying the batch), so rules follow all chains.
        rules_after = []
        for object_kind, name, definition in blocks(body):
            if object_kind not in {"set", "limit", "chain"}: raise ValueError("Unexpected firewall object")
            present = (object_kind, family, table, name) in existing
            if object_kind != "chain":
                # Never replenish named token buckets or dynamic per-interface meters.
                if not present: lines.append(f"add {object_kind} {family} {table} {name} {{ {definition.strip()} }}")
                continue
            rules = [line.strip() for line in definition.splitlines() if line.strip()]
            declaration = rules.pop(0) if rules and rules[0].startswith("type ") else ""
            if present: lines.append(f"flush chain {family} {table} {name}")
            else: lines.append(f"add chain {family} {table} {name} {{ {declaration} }}")
            rules_after.extend(f"add rule {family} {table} {name} {rule}" for rule in rules)
        lines.extend(rules_after)
    pairs = []
    for host, address in sorted(set(tuples)):
        match = re.fullmatch(r"mbh([0-9a-f]+)", host)
        if not match or not 1 <= int(match[1], 16) <= 16382: raise ValueError("Invalid browser tuple")
        expected = ipaddress.ip_address(int(POOL.network_address) + int(match[1], 16) * 4 + 2)
        if str(expected) != address: raise ValueError("Invalid browser tuple address")
        pairs.append(f'{json.dumps(host)} . {address}')
    for family, table in (("inet", "murage_home"), ("ip", "murage_browser_nat")):
        lines.append(f"flush set {family} {table} browser_active")
        if pairs: lines.append(f"add element {family} {table} browser_active {{ {', '.join(pairs)} }}")
        lines.append(f"flush set {family} {table} browser_outbound")
        lines.append(f"add element {family} {table} browser_outbound {{ {json.dumps(context['dev'])} }}")
    lines.append("flush set inet murage_home browser_host_addresses")
    if context["addresses"]:
        addresses = ", ".join(str(ipaddress.IPv4Address(v)) for v in context["addresses"])
        lines.append(f"add element inet murage_home browser_host_addresses {{ {addresses} }}")
    return ("\n".join(lines) + "\n").encode()


class LinuxSystem:
    def run(self, argv, *, input=None, fds=(), timeout=2):
        return subprocess.run(argv, input=input, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              close_fds=True, pass_fds=tuple(fds), timeout=timeout, env=ENV, check=True).stdout
    def json(self, *args): return json.loads(self.run(["/usr/sbin/ip", "-j", *args]))


def load_firewall(system, template, registry):
    context = network_context(system)
    with registry(context) as tuples:
        inventory = json.loads(system.run(["/usr/sbin/nft", "-j", "list", "ruleset"]))
        batch = firewall_batch(template, inventory, context, tuples)
        # One nft transaction: parsing or application failure keeps the old ruleset.
        system.run(["/usr/sbin/nft", "-f", "-"], input=batch)


def main():
    if os.geteuid() != 0: raise PermissionError("Root firewall loader required")
    loader = importlib.machinery.SourceFileLoader("murage_browser_namespace", HELPER)
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    with open(POLICY, encoding="utf8") as stream:
        load_firewall(LinuxSystem(), stream.read(), module.firewall_registry)


if __name__ == "__main__":
    main()
