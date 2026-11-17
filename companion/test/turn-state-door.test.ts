import { describe, expect, it } from "vitest";
import { browserProofHeaders, denyReason, deviceProofHeaders, doorForwardHeaders, needsLaunchProof } from "../src/routes.ts";

const token = "a".repeat(64);
const routes = [
  ["GET", "/api/bots/b1/turn-state"],
  ["DELETE", "/api/bots/b1/queue/q1"],
  ["DELETE", "/api/groups/g1/queue/q1"],
  ["POST", "/api/bots/b1/send-actions"],
  ["POST", "/api/groups/g1/send-actions"],
] as const;

describe("DOOR-1 turn receipts and actions", () => {
  for (const [method, path] of routes) {
    it(`${method} ${path} reaches the owner door with proof`, () => {
      for (const surface of ["device", "browser"] as const) {
        expect(denyReason({ method, path, surface, authenticated: true })).toBeNull();
        expect(denyReason({ method, path, surface, authenticated: false })?.status).toBe(401);
        const headers = surface === "device" ? deviceProofHeaders : browserProofHeaders;
        expect(headers(method, path, token)).toEqual({ "x-murage-companion-token": token });
        expect(headers(method, path, undefined)).toEqual({});
        expect(headers(method, path, "invalid")).toEqual({});
      }
      expect(needsLaunchProof(method, path)).toBe(true);
    });
  }
  it("LEGACY-CAP: broad Stop keeps the existing authenticated door proof", () => {
    const path = "/api/bots/b1/interrupt";
    for (const surface of ["device", "browser"] as const) {
      expect(denyReason({method:"POST",path,surface,authenticated:true})).toBeNull();
      expect(denyReason({method:"POST",path,surface,authenticated:false})?.status).toBe(401);
    }
    expect(doorForwardHeaders(token)).toEqual({"x-murage-door-token":token});
    expect(deviceProofHeaders("POST",path,token)).toEqual({});
    expect(browserProofHeaders("POST",path,token)).toEqual({});
  });
  it("does not widen the method, id or suffix allowlist", () => {
    for (const path of ["/api/bots/b1/turn-state/extra", "/api/groups/g1/send-actions/extra", "/api/bots/b%2f1/turn-state"]) {
      expect(denyReason({ method: "GET", path, surface: "device", authenticated: true })).not.toBeNull();
    }
    expect(denyReason({ method: "PUT", path: routes[0][1], surface: "device", authenticated: true })).not.toBeNull();
  });
});
