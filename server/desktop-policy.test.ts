import { expect, it } from "vitest";
import { requiresDesktopAuthority } from "./desktop-policy.ts";

it("guards owner memory inspection and mutations, including future nested routes", () => {
  for (const method of ["GET","POST","PUT","PATCH","DELETE"]) {
    for (const path of ["/api/memory","/api/memory/promote","/api/memory/records/id/forget"]) {
      expect(requiresDesktopAuthority(method,path)).toBe(true);
    }
  }
  expect(requiresDesktopAuthority("POST","/api/internal/memory/save")).toBe(false);
  expect(requiresDesktopAuthority("POST","/api/memory-other")).toBe(false);
});

it("keeps 0.1.52 workspace-file and media routes desktop-only, except capability byte URLs", () => {
  for (const method of ["GET", "POST"]) {
    for (const path of ["/api/workspace-files", "/api/workspace-files/list", "/api/workspace-files/write", "/api/media", "/api/media/resolve", "/api/media/bytesx"]) {
      expect(requiresDesktopAuthority(method, path), `${method} ${path}`).toBe(true);
    }
  }
  expect(requiresDesktopAuthority("GET", "/api/media/bytes/asset-1")).toBe(false);
  expect(requiresDesktopAuthority("GET", "/api/media/bytes")).toBe(false);
  expect(requiresDesktopAuthority("GET", "/api/workspace-filesx")).toBe(false);
  expect(requiresDesktopAuthority("POST", "/api/internal/resolve-image-reference")).toBe(false);
});

it("requires desktop owner authority for Telegram reconnect retries", () => {
  expect(requiresDesktopAuthority("POST", "/api/telegram/resume")).toBe(true);
});
it("guards the Slack channel namespace without granting adjacent or internal routes", () => {
  for (const method of ["GET", "POST", "PATCH", "PUT", "DELETE"]) for (const path of ["/api/slack", "/api/slack/status", "/api/slack/pair", "/api/slack/resume", "/api/slack/revoke"])
    expect(requiresDesktopAuthority(method, path)).toBe(true);
  expect(requiresDesktopAuthority("GET", "/api/slack-other")).toBe(false);
});

it("guards the first-run checklist, including step routes added later", () => {
  expect(requiresDesktopAuthority("GET","/api/setup")).toBe(true);
  for (const action of ["answer","skip","reopen","something-new"]) {
    expect(requiresDesktopAuthority("POST",`/api/setup/${action}`)).toBe(true);
  }
  expect(requiresDesktopAuthority("POST","/api/setup-other")).toBe(false);
});

it("guards owner team management: rename, members and lead, and delete", () => {
  for (const [method, path] of [["GET", "/api/team-sections"], ["POST", "/api/team-sections/rename"], ["POST", "/api/team-sections/members"], ["POST", "/api/team-sections/delete"]])
    expect(requiresDesktopAuthority(method, path), `${method} ${path}`).toBe(true);
  expect(requiresDesktopAuthority("POST", "/api/team-sectionsx")).toBe(false);
});
