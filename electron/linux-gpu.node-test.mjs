import assert from "node:assert/strict";
import { test } from "node:test";

import * as linuxGpu from "./linux-gpu.mjs";
import { linuxDisablesGpu, linuxGpuDecision } from "./linux-gpu.mjs";

const only = (...paths) => (p) => paths.includes(p);

test("the proprietary NVIDIA driver keeps software rendering", () => {
  assert.equal(linuxDisablesGpu({ env: {}, exists: only("/proc/driver/nvidia/version") }), true);
  assert.equal(linuxDisablesGpu({ env: {}, exists: only("/sys/module/nvidia") }), true);
  assert.equal(linuxGpuDecision({ env: {}, exists: only("/sys/module/nvidia") }).reason, "NVIDIA driver loaded");
});

test("nouveau keeps software rendering", () => {
  assert.equal(linuxDisablesGpu({ env: {}, exists: only("/sys/module/nouveau") }), true);
  assert.equal(linuxGpuDecision({ env: {}, exists: only("/sys/module/nouveau") }).reason, "nouveau driver loaded");
});

test("Intel, AMD and other drivers use the GPU", () => {
  assert.equal(linuxDisablesGpu({ env: {}, exists: only() }), false);
  assert.equal(linuxDisablesGpu({ env: {}, exists: only("/sys/module/i915", "/sys/module/amdgpu") }), false);
});

test("MURAGE_LINUX_GPU overrides detection either way", () => {
  assert.equal(linuxDisablesGpu({ env: { MURAGE_LINUX_GPU: "off" }, exists: only() }), true);
  assert.equal(linuxDisablesGpu({ env: { MURAGE_LINUX_GPU: "on" }, exists: only("/sys/module/nvidia") }), false);
  assert.equal(linuxDisablesGpu({ env: { MURAGE_LINUX_GPU: "on" }, exists: only("/sys/module/nouveau") }), false);
  assert.equal(linuxDisablesGpu({ env: { MURAGE_LINUX_GPU: " OFF " }, exists: only() }), true);
  assert.equal(linuxDisablesGpu({ env: { MURAGE_LINUX_GPU: "On" }, exists: only("/sys/module/nvidia") }), false);
});

test("an unknown override value falls back to detection", () => {
  assert.equal(linuxDisablesGpu({ env: { MURAGE_LINUX_GPU: "maybe" }, exists: only("/sys/module/nvidia") }), true);
  assert.equal(linuxDisablesGpu({ env: { MURAGE_LINUX_GPU: "" }, exists: only() }), false);
});

test("the upstream variable name has no effect", () => {
  assert.equal(linuxDisablesGpu({ env: { OMB_LINUX_GPU: "on" }, exists: only("/sys/module/nvidia") }), true);
});

test("detection never touches the filesystem when the override decides", () => {
  const exists = () => { throw new Error("must not probe"); };
  assert.equal(linuxDisablesGpu({ env: { MURAGE_LINUX_GPU: "off" }, exists }), true);
  assert.equal(linuxDisablesGpu({ env: { MURAGE_LINUX_GPU: "on" }, exists }), false);
});

test("Plasma Wayland disables the noisy color manager and preserves other flags", () => {
  const switches = new Map([["disable-features", "ExistingFeature"]]);
  const commandLine = {
    getSwitchValue: name => switches.get(name),
    appendSwitch: (name, value) => switches.set(name, value),
  };
  linuxGpu.configureWaylandColorManager?.(commandLine, { XDG_SESSION_TYPE: "x11", XDG_CURRENT_DESKTOP: "KDE" });
  assert.equal(switches.get("disable-features"), "ExistingFeature");
  linuxGpu.configureWaylandColorManager?.(commandLine, { XDG_SESSION_TYPE: "wayland", XDG_CURRENT_DESKTOP: "GNOME" });
  assert.equal(switches.get("disable-features"), "ExistingFeature");
  const plasma = { XDG_SESSION_TYPE: "wayland", XDG_CURRENT_DESKTOP: "KDE" };
  linuxGpu.configureWaylandColorManager?.(commandLine, plasma);
  linuxGpu.configureWaylandColorManager?.(commandLine, plasma);
  assert.equal(switches.get("disable-features"), "ExistingFeature,WaylandWpColorManagerV1");
});
