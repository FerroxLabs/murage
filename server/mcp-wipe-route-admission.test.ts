// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { consumingSinkEntry, registeredInternalRoute } from "./consuming-sink-inventory.ts";
import { registerConsumingDescriptor } from "./consuming-turn-response.ts";

it("admits only a registered MCP metadata POST and retains live membership on every response descriptor", () => {
  let active = true;
  const registry = { project: () => false, email: () => false, mcp: (name: string) => active && name === "approved",
    delegation: () => false, box: () => false };
  const path = "/api/internal/mcp-remote/approved/wipe-metadata";
  expect(registeredInternalRoute("POST", path, registry)).toBe(true);
  const descriptors = (["headers", "body", "chunk"] as const).map(mode => registerConsumingDescriptor(`POST ${path}:${mode}`, mode));
  for (const descriptor of descriptors) {
    expect(consumingSinkEntry(descriptor.id, descriptor.mode)?.provenanceProducer).toBe("localJson");
    expect(descriptor.isRegistered?.()).toBe(true);
  }
  for (const method of ["GET", "PUT", "DELETE", "PATCH"]) expect(registeredInternalRoute(method, path, registry)).toBe(false);
  for (const wrong of ["/api/internal/mcp-remote/unknown/wipe-metadata", `${path}/extra`, `${path}/`,
    "/api/internal/mcp-remote/approved/other", "/api/internal/mcp-remote/approved%2Fother/wipe-metadata"]) {
    expect(registeredInternalRoute("POST", wrong, registry)).toBe(false);
  }
  active = false;
  expect(registeredInternalRoute("POST", path, registry)).toBe(false);
  for (const descriptor of descriptors) expect(descriptor.isRegistered?.()).toBe(false);
});
