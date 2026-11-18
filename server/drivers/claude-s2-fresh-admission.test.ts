import { afterEach, expect, it } from "vitest";
import { consumingFixture } from "../testing/consuming-fixture.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { createProxyReleaseAuthority } from "../consuming-turn-ingress.ts";
import { admittedMcpMount, createMcpMountAdmission, freshMcpMountAdmission } from "./mcp-mounts.ts";
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const f = consumingFixture(); cleanup.push(f.close);
  const caps = new InternalCapabilities(); caps.begin("B", f.turn.threadId, f.binding.identity.dispatchGeneration);
  const admission = createMcpMountAdmission(f.binding, createProxyReleaseAuthority(caps), "http://127.0.0.1:1");
  return { f, admission };
}
const spec = { command: "isolated", args: [], env: {} };
it("T-S2-FRESH-ADMISSION: disposed generation stays terminal; fresh generation has its own 64 allocations", () => {
  const { f, admission } = fixture();
  const mounts = Array.from({ length: 64 }, () => admittedMcpMount(admission.mount(spec)));
  for (const mount of mounts) mount.ingress.retire();
  admission.dispose();
  const fresh = freshMcpMountAdmission(admission, f.binding);
  expect(fresh).not.toBe(admission);
  for (let i = 0; i < 64; i++) admittedMcpMount(fresh.mount(spec)).ingress.retire();
  expect(mounts.every(m => m.ingress.retired)).toBe(true);
  expect(() => freshMcpMountAdmission(admission, f.binding)).toThrow("MEMORY_CONTEXT_REVOKED");
  // A retired release cannot deliver to any successor sink.
  let written = false;
  expect(() => mounts[0]!.accept('{"jsonrpc":"2.0","id":1,"result":{}}', () => { written = true; })).toThrow();
  expect(written).toBe(false);
  fresh.dispose();
});
it("T-S2-FRESH-ADMISSION-CURRENT: live, wrong and revoked bindings cannot fork", () => {
  const { f, admission } = fixture();
  expect(() => freshMcpMountAdmission(admission, f.binding)).toThrow();
  admission.dispose();
  const other = fixture();
  expect(() => freshMcpMountAdmission(admission, other.f.binding)).toThrow();
  f.replace();
  expect(() => freshMcpMountAdmission(admission, f.binding)).toThrow();
});
it("T-S2-FRESH-ADMISSION-TERMINAL: disposal cannot remount the original generation", () => {
  const { admission } = fixture(); admission.dispose();
  expect(() => admission.mount(spec)).toThrow("MEMORY_CONTEXT_REVOKED");
});
