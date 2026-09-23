// Upstream #1568: a screenshot is whatever is on that computer's screen, so
// no browser or proxy may keep a copy of the response.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sendScreenshot } from "./screenshot-response.ts";

describe("screenshot responses", () => {
  it("are JSON the client can read and never stored", () => {
    let head: { status: number; headers: Record<string, string> } | undefined;
    let sent = "";
    const res = {
      writeHead(status: number, headers: Record<string, string>) { head = { status, headers }; return this; },
      end(data: string) { sent = data; return this; },
    };
    sendScreenshot(res as never, { png: "iVBORw0KGgo=", format: "png" });
    expect(head).toEqual({ status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    expect(JSON.parse(sent)).toEqual({ png: "iVBORw0KGgo=", format: "png" });
  });

  it("carry every Box, VPS and Local VM screenshot route", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");
    // Each capture a route answers with must go out through sendScreenshot.
    for (const capture of ["containerComputerScreenshot(undefined, undefined, SHARED_LOCAL_VM_TARGET)", "containerComputerScreenshot(undefined, undefined, target)", "vps.vpsComputerScreenshot(cfg, botId)", "box.screenshotBox(cfg, botId)"]) {
      const at = source.indexOf(capture);
      expect(at, capture).toBeGreaterThan(-1);
      const statement = source.slice(source.lastIndexOf("return ", at), at);
      expect(statement, capture).toContain("sendScreenshot(res");
    }
    expect(source).not.toMatch(/json\(res, 200, (?:\{\s*image: )?await (?:containerComputerScreenshot|vps\.vpsComputerScreenshot|box\.screenshotBox)/);
  });
});
