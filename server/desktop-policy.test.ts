import { expect, it } from "vitest";
import { requiresDesktopAuthority } from "./desktop-policy.ts";

it("guards owner memory inspection and mutations, including future nested routes", () => {
  for (const method of ["GET","POST","PUT","PATCH","DELETE"]) {
    for (const path of ["/api/memory","/api/memory/promote","/api/memory/records/id/forget"]) {
      expect(requiresDesktopAuthority(method,path)).toBe(true);
    }
  }
  expect(requiresDesktopAuthority("POST","/api/internal/memory/save")).toBe(false);
  // 0.1.61 deny by default: a route nobody classified is desktop-only.
  expect(requiresDesktopAuthority("POST","/api/memory-other")).toBe(true);
});

it("keeps 0.1.52 workspace-file and media routes desktop-only, except capability byte URLs", () => {
  for (const method of ["GET", "POST"]) {
    for (const path of ["/api/workspace-files", "/api/workspace-files/list", "/api/workspace-files/write", "/api/media", "/api/media/resolve", "/api/media/bytesx"]) {
      expect(requiresDesktopAuthority(method, path), `${method} ${path}`).toBe(true);
    }
  }
  expect(requiresDesktopAuthority("GET", "/api/media/bytes/asset-1")).toBe(false);
  expect(requiresDesktopAuthority("GET", "/api/media/bytes")).toBe(false);
  expect(requiresDesktopAuthority("GET", "/api/workspace-filesx")).toBe(true);
  expect(requiresDesktopAuthority("POST", "/api/internal/resolve-image-reference")).toBe(false);
});

it("requires desktop owner authority for Telegram reconnect retries", () => {
  expect(requiresDesktopAuthority("POST", "/api/telegram/resume")).toBe(true);
});
it("guards the Slack channel namespace without granting adjacent or internal routes", () => {
  for (const method of ["GET", "POST", "PATCH", "PUT", "DELETE"]) for (const path of ["/api/slack", "/api/slack/status", "/api/slack/pair", "/api/slack/resume", "/api/slack/revoke"])
    expect(requiresDesktopAuthority(method, path)).toBe(true);
  expect(requiresDesktopAuthority("GET", "/api/slack-other")).toBe(true);
});

it("guards the first-run checklist, including step routes added later", () => {
  expect(requiresDesktopAuthority("GET","/api/setup")).toBe(true);
  for (const action of ["answer","skip","reopen","something-new"]) {
    expect(requiresDesktopAuthority("POST",`/api/setup/${action}`)).toBe(true);
  }
  expect(requiresDesktopAuthority("POST","/api/setup-other")).toBe(true);
});

it("leaves a call's two routes to the call routes, which scope them to the bots a phone can see", () => {
  for (const path of ["/api/bots/bot_1/voice-host", "/api/bots/bot_1/call-note"]) {
    expect(requiresDesktopAuthority("POST", path), path).toBe(false);
  }
});

it("guards owner team management: rename, members and lead, and delete", () => {
  for (const [method, path] of [["GET", "/api/team-sections"], ["POST", "/api/team-sections/rename"], ["POST", "/api/team-sections/members"], ["POST", "/api/team-sections/delete"]])
    expect(requiresDesktopAuthority(method, path), `${method} ${path}`).toBe(true);
  expect(requiresDesktopAuthority("POST", "/api/team-sectionsx")).toBe(true);
});

// 0.1.61 (contract 4.2): the routes the denylist missed are desktop-only now,
// and a route added without a class is too.
it("closes what the old denylist left open", () => {
  for (const [method, path] of [["GET", "/api/decisions"], ["GET", "/api/flux-connection"], ["POST", "/api/flux-connection/test"], ["GET", "/api/team-map"], ["GET", "/api/cli-candidates"], ["POST", "/api/a-route-added-tomorrow"]])
    expect(requiresDesktopAuthority(method, path), `${method} ${path}`).toBe(true);
  for (const [method, path] of [["GET", "/api/health"], ["GET", "/api/bots"], ["POST", "/api/bots/b1/messages"], ["GET", "/api/inbox"], ["GET", "/api/media/bytes/asset-1"]])
    expect(requiresDesktopAuthority(method, path), `${method} ${path}`).toBe(false);
});

it("keeps the image model check and the image library owner-only", () => {
  for (const [method, path] of [["POST", "/api/images/probe"], ["GET", "/api/images/library"], ["POST", "/api/images/prompt-blocks"], ["GET", "/api/images/prompt-blocks/b1"],
    ["DELETE", "/api/images/prompt-blocks/b1"], ["DELETE", "/api/images/reference-packs/p1"], ["GET", "/api/images/settings"]] as const) {
    expect(requiresDesktopAuthority(method, path), `${method} ${path}`).toBe(true);
  }
  expect(requiresDesktopAuthority("POST", "/api/internal/generate-image")).toBe(false);
});
