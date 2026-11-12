import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { removeTempDir } from "../testing/cleanup.ts";
const model = vi.hoisted(() => ({ platform: "linux", events: [] as string[], directories: new Set<number>(), fail: "" }));
vi.mock("node:os", async original => ({ ...await original<typeof import("node:os")>(), platform: () => model.platform }));
vi.mock("node:fs", async original => {
  const real = await original<typeof import("node:fs")>();
  return { ...real,
    openSync: (...args: Parameters<typeof real.openSync>) => {
      const dir = real.existsSync(args[0]) && real.statSync(args[0]).isDirectory();
      if (dir && model.platform === "win32") throw Object.assign(new Error("Windows directory handle"), { code: "EPERM" });
      const fd = real.openSync(...args);
      if (dir) model.directories.add(fd); else model.directories.delete(fd);
      return fd;
    },
    writeFileSync: (...args: Parameters<typeof real.writeFileSync>) => { model.events.push("write"); return real.writeFileSync(...args); },
    fsyncSync: (fd: number) => {
      const event = model.directories.has(fd) ? "directory-sync" : "file-sync";
      model.events.push(event);
      if (model.fail === event || (model.fail === "post-publish" && model.events.includes("publish"))) throw new Error("barrier failed");
      real.fsyncSync(fd);
    },
    linkSync: (...args: Parameters<typeof real.linkSync>) => { model.events.push("publish"); real.linkSync(...args); },
  };
});
import { HeldRequest } from "./held-request.ts";
import { operationSpec } from "./operations/registry.ts";
import { prepareOpportunityRecovery, saveOpportunityPlan } from "./opportunity-recovery-plan.ts";
const directories: string[] = [];
afterEach(() => { model.platform = "linux"; model.fail = ""; for (const dir of directories.splice(0)) removeTempDir(dir); });
for (const platform of ["win32", "linux", "darwin"]) it(`RV5 ${platform}: plan flushes before and after immutable publication`, async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "hl-plan-platform-")); directories.push(dir);
  const spec = operationSpec("opportunities.update")!;
  const held = HeldRequest.freeze(spec, { path: "/opportunities/opp_A", resource: "opportunities:opportunity:opp_A", body: { kind: "json", value: { name: "Reviewed" } } }, { locationId: "loc_fixture_01" });
  await prepareOpportunityRecovery(held, "loc_fixture_01", { read: async () => { throw new Error("unexpected read"); } });
  model.platform = platform; model.events = [];
  expect(() => saveOpportunityPlan(dir, "approval", held)).not.toThrow();
  expect(model.events.slice(0, 3)).toEqual(["write", "file-sync", "publish"]);
  expect(model.events.slice(3)).toContain("file-sync");
  if (platform === "win32") expect(model.events).not.toContain("directory-sync");
  else expect(model.events).toContain("directory-sync");
  expect(fs.readdirSync(dir).filter(p => p.endsWith(".tmp"))).toEqual([]);
  expect(() => saveOpportunityPlan(dir, "approval", held)).not.toThrow();
  for (const fail of ["file-sync", "post-publish", ...(platform === "win32" ? [] : ["directory-sync"])]) {
    model.fail = fail; model.events = [];
    expect(() => saveOpportunityPlan(dir, `failure-${fail}`, held)).toThrow("barrier failed");
  }
});
