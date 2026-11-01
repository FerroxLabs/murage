// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOLIMITS-CODEX-EDIT: both Codex edit routes, the apply_patch hook and the native file-change approval, file the call
// the central contract reads. A patch outside the project is judged by its level like any other edit; only a real key
// path, an unread patch and (below No limits) what the patch takes away keep a card.
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeTempDir } from "../testing/cleanup.ts";
import type { GrantCall } from "../../shared/app-action-grant.ts";
import { autoVerdict, realKeyPaths, type AutoApprover, type AutoContext } from "../auto-approve.ts";
import { classifyAsk, type StopLinePlace } from "../stop-line.ts";
import { codexNativeEditCall, placeEditPaths, readFileChanges, routeDelivery } from "./codex-hook.ts";

const ASK: AutoApprover = {};
const AUTO: AutoApprover = { autoApprove: true };
const FULL: AutoApprover = { autoApprove: true, fullAccess: true };
const NO_LIMITS: AutoApprover = { autoApprove: true, fullAccess: true, noLimits: true };
const LEVELS = [["Ask", ASK], ["Auto", AUTO], ["Full access", FULL], ["No limits", NO_LIMITS]] as const;
const OWNER: Partial<AutoContext> = { fullAccessOrigin: "owner" };
const ROUTINE: Partial<AutoContext> = { fullAccessOrigin: "routine", routineLevel: true, automated: true };

const env = (...body: string[]) => ["*** Begin Patch", ...body, "*** End Patch"].join("\n");
const add = (path: string) => env(`*** Add File: ${path}`, "+hello");
const update = (path: string) => env(`*** Update File: ${path}`, "@@", "-a", "+b");

describe("NOLIMITS-CODEX-EDIT", () => {
  let scratch: string;
  let project: string;
  let home: string;
  let place: StopLinePlace;
  beforeEach(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "codex-edit-")));
    project = join(scratch, "project");
    home = join(scratch, "home");
    mkdirSync(project);
    mkdirSync(join(scratch, "sibling"));
    mkdirSync(home);
    place = { cwd: project, home, roots: [project], knownRecipients: new Set<string>(), realpath: (path: string) => path };
  });
  afterEach(() => removeTempDir(scratch));

  /** The hook route, judged as the server judges the card codex.ts opens. */
  const judged = (call: GrantCall, tool: string, summary: string, realPaths?: string[], localHold?: string) => {
    const stopLine = classifyAsk({ ...call, tool, summary }, place);
    return { stopLine, verdict: (bot: AutoApprover, more: Partial<AutoContext> = OWNER) => autoVerdict(bot, tool, summary, { call, stopLine, ...(realPaths ? { realPaths } : {}), ...(localHold ? { localHold } : {}), ...more }) };
  };
  const hook = (patch: string, cwd = project) => {
    const route = routeDelivery({ tool_name: "apply_patch", tool_input: { input: patch }, tool_use_id: "u1", turn_id: "t1", cwd }, { mounts: [], project, home });
    if (route.route !== "ask") throw new Error(`expected an ask, got ${route.route}`);
    const call: GrantCall = { engine: "codex", toolCall: route.toolCall as GrantCall["toolCall"], ...(route.toolInputMissing ? { inputMissing: route.toolInputMissing } : {}), truncated: false };
    // as the server reads the opened request: the driver's real places, the paths from the turn's folder, the driver's hold
    const real = realKeyPaths(route.toolCall.input, route.filePaths, project, { home });
    return { route, ...judged(call, route.tool, route.summary, real.paths, route.localHold) };
  };
  const native = (changes: unknown, params: Record<string, unknown> = {}, cwd = project) => {
    const read = codexNativeEditCall(params, changes, { project, cwd, home });
    const call: GrantCall = { engine: "codex", ...(read.toolCall ? { toolCall: read.toolCall as GrantCall["toolCall"] } : {}), ...(read.inputMissing ? { inputMissing: read.inputMissing } : {}), truncated: false };
    const real = read.toolCall ? realKeyPaths(read.toolCall.input, read.filePaths, project, { home }) : undefined;
    return { read, ...judged(call, "edit", "edit", real?.paths, read.localHold) };
  };

  describe("a harmless patch outside the project", () => {
    it.each(["Add", "Update"])("%s runs at No limits and at Full access with no card", (kind) => {
      const path = join(scratch, "sibling", "notes.md");
      const c = hook(kind === "Add" ? add(path) : update(path));
      expect(c.stopLine).toBeNull();
      expect(c.verdict(NO_LIMITS)).toMatchObject({ source: "no-limits", approve: expect.any(String) });
      expect(c.verdict(FULL)).toMatchObject({ source: "full-access", approve: expect.any(String) });
    });

    it("a relative path out of the folder reads the same", () => {
      expect(hook(add("../sibling/notes.md")).verdict(NO_LIMITS)).toMatchObject({ source: "no-limits" });
    });

    it("is judged by its level below Full access, never as a call Murage could not read", () => {
      const c = hook(add(join(scratch, "sibling", "notes.md")));
      expect(c.verdict(ASK)).toMatchObject({ approve: null, source: "no-grant" });
      expect(c.verdict(AUTO)).toMatchObject({ source: "auto-mode", approve: expect.any(String) });
    });

    it("the card names the files it touches", () => {
      const path = join(scratch, "sibling", "notes.md");
      expect(hook(add(path)).route).toMatchObject({ summary: path, destinations: [path], toolCall: { name: "edit", input: { paths: [path], cwd: project } } });
    });
  });

  describe("G2: the stop line sees what the patch takes away", () => {
    const outside = () => join(scratch, "sibling", "ledger.csv");

    it("a Delete outside the project stops at Full access and names the file", () => {
      const c = hook(env(`*** Delete File: ${outside()}`));
      expect(c.stopLine).toMatchObject({ kind: "delete" });
      expect(c.stopLine?.what).toContain("ledger.csv");
      expect(c.verdict(FULL)).toMatchObject({ approve: null, source: "stop-line" });
    });

    it("a Move out of an outside file stops at Full access", () => {
      const c = hook(env(`*** Update File: ${outside()}`, `*** Move to: ${join(project, "a.md")}`, "@@", "-a", "+b"));
      expect(c.stopLine?.what).toContain("ledger.csv");
      expect(c.verdict(FULL)).toMatchObject({ approve: null, source: "stop-line" });
    });

    it("a mixed patch is stopped on its delete, whatever else it writes", () => {
      const c = hook(env(`*** Add File: ${join(project, "a.md")}`, "+hi", `*** Delete File: ${outside()}`));
      expect(c.verdict(FULL)).toMatchObject({ approve: null, source: "stop-line" });
    });

    it("No limits lifts it for the owner's own turn and keeps it for a routine", () => {
      const c = hook(env(`*** Delete File: ${outside()}`));
      expect(c.verdict(NO_LIMITS)).toMatchObject({ source: "no-limits" });
      expect(c.verdict(NO_LIMITS, ROUTINE)).toMatchObject({ approve: null, source: "stop-line" });
    });
  });

  describe("a real key path cards at every level", () => {
    const keyed = (patch: string) => {
      const c = hook(patch);
      for (const [label, bot] of LEVELS) expect(c.verdict(bot), label).toMatchObject({ approve: null, source: "sensitive-guard" });
    };
    it.each(["add", "update", "delete", "move"])("%s of ~/.ssh/id_rsa", (kind) => {
      const key = join(home, ".ssh", "id_rsa");
      keyed(kind === "add" ? add(key) : kind === "update" ? update(key) : kind === "delete" ? env(`*** Delete File: ${key}`)
        : env(`*** Update File: ${join(scratch, "sibling", "a")}`, `*** Move to: ${key}`, "@@", "-a", "+b"));
    });

    it("a plain name that a link carries into the key folder", () => {
      mkdirSync(join(home, ".ssh"));
      symlinkSync(join(home, ".ssh"), join(scratch, "sibling", "plain"));
      keyed(add(join(scratch, "sibling", "plain", "config")));
    });

    it("a climb out of a link, from a folder that is not the turn's", () => {
      mkdirSync(join(home, ".ssh", "sub"), { recursive: true });
      const other = join(scratch, "other");
      mkdirSync(other);
      symlinkSync(join(home, ".ssh", "sub"), join(other, "hop"));
      mkdirSync(join(project, "hop"));
      const c = hook(add("hop/../config"), other);
      expect(c.route.localHold).toEqual(expect.any(String));
      for (const [label, bot] of LEVELS) expect(c.verdict(bot), label).toMatchObject({ approve: null, source: "sensitive-guard" });
      const n = native([{ path: "hop/../config", kind: { type: "add" } }], {}, other);
      for (const [label, bot] of LEVELS) expect(n.verdict(bot), label).toMatchObject({ approve: null, source: "sensitive-guard" });
    });

    it("on the native route, with a plain card title", () => {
      const c = native([{ path: join(home, ".aws", "credentials"), kind: { type: "update", move_path: null } }]);
      for (const [label, bot] of LEVELS) expect(c.verdict(bot), label).toMatchObject({ approve: null, source: "sensitive-guard" });
    });
  });

  describe("where an edit really lands", () => {
    it("a climb out of a link inside the project is outside it, whatever the spelling says", () => {
      mkdirSync(join(scratch, "sibling", "sub"));
      symlinkSync(join(scratch, "sibling", "sub"), join(project, "link"));
      const c = hook(add(`${project}/link/../notes.txt`));
      expect(c.route.filePaths).toEqual([join(scratch, "sibling", "notes.txt")]);
      expect(placeEditPaths(["link/../notes.txt"], project, project, home)).toEqual({ real: [join(scratch, "sibling", "notes.txt")], inside: false });
    });

    it("the path keeps its spelling on the card and its real place in filePaths", () => {
      expect(hook(add("../sibling/notes.md")).route).toMatchObject({ summary: "../sibling/notes.md", filePaths: [join(scratch, "sibling", "notes.md")] });
    });
  });

  describe("an unread patch keeps its card at every level", () => {
    it.each(["", "not a patch", "*** Begin Patch\n*** End Patch"])("%j", (patch) => {
      const route = routeDelivery({ tool_name: "apply_patch", tool_input: { input: patch }, tool_use_id: "u1", turn_id: "t1", cwd: project }, { mounts: [], project, home });
      expect(route).toMatchObject({ route: "ask", tool: "edit", toolInputMissing: "patch" });
      if (route.route !== "ask") return;
      const c = judged({ engine: "codex", toolCall: route.toolCall as GrantCall["toolCall"], inputMissing: route.toolInputMissing, truncated: false }, route.tool, route.summary);
      for (const [label, bot] of LEVELS) expect(c.verdict(bot), label).toMatchObject({ approve: null, source: "unread-call" });
    });
  });

  describe("the contract", () => {
    it.each([[{}, "paths"], [{ paths: [] }, "paths"], [{ paths: "a" }, "paths"], [{ paths: ["a", ""] }, "paths[]"], [{ paths: ["a", 1] }, "paths[]"]])("%j is unread", (input, field) => {
      const c = judged({ engine: "codex", toolCall: { name: "edit", input }, truncated: false }, "edit", "edit");
      expect(c.verdict(NO_LIMITS)).toMatchObject({ approve: null, source: "unread-call", rule: `the call does not carry what this tool needs (${field})` });
    });
  });

  describe("claim 2: the native file-change approval", () => {
    it("carries a harmless outside change to the verdict, which No limits answers", () => {
      const path = join(scratch, "sibling", "notes.md");
      const c = native([{ path, kind: { type: "update", move_path: null } }]);
      expect(c.read.toolCall).toEqual({ name: "edit", input: { paths: [path], cwd: project } });
      expect(c.verdict(NO_LIMITS)).toMatchObject({ source: "no-limits" });
      expect(c.verdict(ASK)).toMatchObject({ approve: null, source: "no-grant" });
    });

    it("with no announced change there is nothing to read, so the card stays and says which field", () => {
      const c = native(undefined);
      expect(c.read).toEqual({ inputMissing: "changes" });
      for (const [label, bot] of LEVELS) expect(c.verdict(bot), label).toMatchObject({ approve: null, source: "unread-call" });
    });

    it("a delete and a move's old name each meet the stop line", () => {
      const path = join(scratch, "sibling", "ledger.csv");
      for (const kind of [{ type: "delete" }, "delete", { type: "update", move_path: join(project, "a") }, { type: "update", movePath: join(project, "a") }]) {
        const c = native([{ path, kind }]);
        expect(c.stopLine?.what, JSON.stringify(kind)).toContain("ledger.csv");
        expect(c.verdict(FULL), JSON.stringify(kind)).toMatchObject({ approve: null, source: "stop-line" });
      }
    });

    it("a kind it does not know, or a move that names no path, is unread at every level", () => {
      const path = join(scratch, "sibling", "ledger.csv");
      for (const kind of [undefined, { type: "rename" }, 7, { type: "update", move_path: 17 }, { type: "update", move_path: "" }]) {
        const c = native([{ path, kind }]);
        expect(c.read, JSON.stringify(kind)).toEqual({ inputMissing: "changes" });
        for (const [label, bot] of LEVELS) expect(c.verdict(bot), `${label} ${JSON.stringify(kind)}`).toMatchObject({ approve: null, source: "unread-call" });
      }
    });

    it("an add or an update removes nothing", () => {
      expect(readFileChanges([{ path: "a", kind: "add" }, { path: "b", kind: { type: "update", move_path: null } }])).toEqual({ paths: ["a", "b"], removed: [] });
    });

    it("a move's new name is a path the guards read", () => {
      expect(readFileChanges([{ path: "a", kind: { type: "update", move_path: "/k/.ssh/id_rsa" } }])).toEqual({ paths: ["a", "/k/.ssh/id_rsa"], removed: ["a"] });
    });

    it("the older approval's map of files reads the same", () => {
      expect(readFileChanges({ "/a": { type: "add", content: "" }, "/b": { type: "delete", content: "" } })).toEqual({ paths: ["/a", "/b"], removed: ["/b"] });
    });

    it("a change it cannot read leaves the whole call unread", () => {
      for (const changes of [[], [{}], [{ path: "" }], [{ path: "a", kind: "add" }, null], "a", 3, {}]) expect(readFileChanges(changes), JSON.stringify(changes)).toBeNull();
    });

    it("a root the engine asks to write under is a path the guards read", () => {
      const key = join(home, ".aws", "credentials");
      const c = native([{ path: "a.md", kind: "add" }], { grantRoot: key });
      expect(c.read.toolCall?.input).toMatchObject({ paths: ["a.md", key] });
      expect(c.verdict(NO_LIMITS)).toMatchObject({ approve: null, source: "sensitive-guard" });
    });
  });
});
