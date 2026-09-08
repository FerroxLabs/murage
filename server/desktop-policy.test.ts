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

it("requires desktop owner authority for Telegram reconnect retries", () => {
  expect(requiresDesktopAuthority("POST", "/api/telegram/resume")).toBe(true);
});
