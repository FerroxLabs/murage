import assert from "node:assert/strict";
import { test } from "node:test";

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
