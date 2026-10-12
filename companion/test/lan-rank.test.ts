// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Behaviour adapted from OpenMausBot #2262 (Apache-2.0).
import type { NetworkInterfaceInfo } from "node:os";
import { expect, it } from "vitest";
import { lanAddresses } from "../src/listener.ts";

const v4 = (address: string): NetworkInterfaceInfo[] =>
  [{ address, netmask: "255.255.255.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: false, cidr: `${address}/24` }];

it("puts the Wi-Fi address of a Windows PC ahead of WSL and Hyper-V adapters", () => {
  expect(lanAddresses({
    "vEthernet (WSL)": v4("172.19.96.1"),
    "vEthernet (Default Switch)": v4("172.28.64.1"),
    "VirtualBox Host-Only Network": v4("192.168.56.1"),
    "Wi-Fi": v4("192.168.1.23"),
  })[0]).toBe("192.168.1.23");
});

it("ranks Linux physical interfaces ahead of docker and libvirt bridges", () => {
  expect(lanAddresses({ docker0: v4("172.17.0.1"), virbr0: v4("192.168.122.1"), "br-1a2b3c": v4("172.18.0.1"), wlp2s0: v4("10.0.0.5") })).toEqual(["10.0.0.5", "172.17.0.1", "192.168.122.1", "172.18.0.1"]);
});

it("keeps macOS en0 first and still lists tunnels last", () => {
  expect(lanAddresses({ utun3: v4("100.101.102.103"), bridge100: v4("192.168.64.1"), en0: v4("192.168.1.10") })[0]).toBe("192.168.1.10");
});

it("ranks an unrecognized adapter between physical and virtual", () => {
  expect(lanAddresses({ "Hotspot Adapter": v4("192.168.137.1"), "vEthernet (WSL)": v4("172.19.96.1"), Ethernet: v4("192.168.0.9") })).toEqual(["192.168.0.9", "192.168.137.1", "172.19.96.1"]);
});
