// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cloudRouteDecision, routeAdmits, routeClass } from "../route-policy.ts";
import { cloudModelSignInMounted } from "./model-signin-api.ts";
import { ENGINE_LOGIN_ENGINES, ENGINE_LOGIN_PATH } from "./engine-login.ts";
import { ENGINE_LOGIN_ENGINES as DESKTOP_ENGINE_LOGIN_ENGINES } from "../../electron/cloud-home-engine-login.mjs";

const path = "/api/engine-login/codex";
describe("engine-login route class", () => {
  it("classifies every relay engine and nothing else", () => {
    expect(routeClass("GET", path)).toBe("engine-login");
    expect(routeClass("GET", "/api/engine-login/claudeAgent")).toBe("engine-login");
    expect(routeClass("GET", "/api/engine-login/grokAgent")).toBe("engine-login");
    expect(routeClass("GET", "/api/engine-login/kimiAgent")).toBe("engine-login");
    expect(routeClass("GET", "/api/engine-login/opencodeGo")).toBe("engine-login");
    expect(routeClass("GET", "/api/engine-login/pi")).not.toBe("engine-login");
  });
  it("requires step-up for every engine the relay accepts (1.0.4 audit 11-1: OpenCode Go skipped it)", () => {
    expect(cloudRouteDecision("GET", "/api/engine-login/opencodeGo", "owner-desktop", {})).toBe("step-up required");
    expect([...ENGINE_LOGIN_ENGINES]).toEqual([...DESKTOP_ENGINE_LOGIN_ENGINES]);
    for (const engine of ENGINE_LOGIN_ENGINES) {
      const enginePath = `/api/engine-login/${engine}`;
      expect(ENGINE_LOGIN_PATH.test(enginePath), engine).toBe(true);
      expect(routeClass("GET", enginePath), engine).toBe("engine-login");
      expect(cloudRouteDecision("GET", enginePath, "owner-desktop", {}), engine).toBe("step-up required");
      expect(cloudRouteDecision("GET", enginePath, "owner-desktop", {}, true), engine).toBe("allow");
      expect(cloudRouteDecision("GET", enginePath, "browser", {}, true), engine).toBe("deny");
    }
  });
  it("admits only the desktop proof outside the cloud gate", () => {
    const nobody = { desktop: false, companion: false, door: false, bot: false };
    expect(routeAdmits("engine-login", { ...nobody, desktop: true })).toBe(true);
    for (const who of ["companion", "door", "bot"] as const) expect(routeAdmits("engine-login", { ...nobody, [who]: true })).toBe(false);
  });
  it("needs an owner-desktop session with step-up on a cloud home", () => {
    expect(cloudRouteDecision("GET", path, "owner-desktop", {})).toBe("step-up required");
    expect(cloudRouteDecision("GET", path, "owner-desktop", {}, true)).toBe("allow");
    for (const scope of ["browser", "owner-phone", "service", "anonymous"] as const) {
      expect(cloudRouteDecision("GET", path, scope, {}), scope).toBe("deny");
      expect(cloudRouteDecision("GET", path, scope, {}, true), `${scope} stepped up`).toBe("deny");
    }
  });
});
describe("model-signin on a cloud home", () => {
  it("is not mounted, and the server assembles it only behind that switch", () => {
    expect(cloudModelSignInMounted()).toBe(false);
    const index = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
    expect(index).toContain("homeSessions && cloudModelSignInMounted() ? createCloudModelSignInApi(");
    expect(index).toContain("const engineLoginRelay = createEngineLoginRelay();");
    expect(index).toContain("|| engineLoginRelay(req, socket, head, url));");
  });
});
