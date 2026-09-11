// F5-T3: what has to be true before a path in a transcript becomes a player.
// The renderer suite runs in node with no DOM, so this file drives the three
// harness questions against a recording fake and pins the path arithmetic.
// Real playback, seeking and pause-on-unmount are proved in a browser by
// src/e2e/media-player.human.spec.ts.
import { beforeEach, describe, expect, it } from "vitest";

import {
  forgetLocalMedia,
  localMedia,
  MEDIA_LIST_MAX_PAGES,
  resolveLocalMedia,
  workspaceParentDirectory,
  workspaceRelativePath,
  type MediaApi,
} from "./media-resolve";

const ROOT = "/Users/sean/.murage/workspaces/research";
const SCOPE = { botId: "research", threadId: "task-7" };
const REVISION = "r1.WPkMkm7wYRMFdPk0qK1Lp6dRr7v3WkQ9m0kq0k0k0k0";

const asset = (over: Record<string, unknown> = {}) => ({
  id: "ma1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  scope: { serverId: "local", ...SCOPE },
  source: "workspace",
  kind: "audio",
  name: "take-2.wav",
  mime: "audio/wav",
  bytes: 90_044,
  revision: REVISION,
  availability: "ready",
  capabilities: { preview: true, download: true, open: false, reveal: false, imageReference: false },
  ...over,
});

const entry = (name: string, over: Record<string, unknown> = {}) => ({
  name, relativePath: `outputs/${name}`, kind: "file", state: "local", bytes: 90_044, revision: REVISION, ...over,
});

interface Call { path: string; init?: RequestInit }

/** A harness that answers the three questions. Each answer is a function so a
 * test can refuse one step without restating the others. */
function harness(answers: {
  root?: unknown;
  list?: (call: number, cursor: string | null) => unknown;
  resolve?: unknown;
  throwOn?: "root" | "list" | "resolve";
}): { api: MediaApi; calls: Call[] } {
  const calls: Call[] = [];
  let listCalls = 0;
  const api: MediaApi = async (path, init) => {
    calls.push({ path, ...(init ? { init } : {}) });
    if (path.startsWith("/api/workspace-files/root")) {
      if (answers.throwOn === "root") throw Object.assign(new Error("no workspace"), { status: 409 });
      return answers.root ?? { scope: SCOPE, state: "ready", label: "Research", displayPath: ROOT, managed: true };
    }
    if (path.startsWith("/api/workspace-files/list")) {
      if (answers.throwOn === "list") throw Object.assign(new Error("gone"), { status: 409 });
      const cursor = new URL(path, "http://x").searchParams.get("cursor");
      return answers.list ? answers.list(listCalls++, cursor) : { entries: [entry("take-2.wav")], incomplete: false };
    }
    if (path === "/api/media/resolve") {
      if (answers.throwOn === "resolve") throw Object.assign(new Error("unavailable"), { status: 404 });
      return answers.resolve ?? { asset: asset(), url: "/api/media/bytes/ma1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA?cap=mc1.x.y", expiresAt: 1 };
    }
    throw new Error(`unexpected route ${path}`);
  };
  return { api, calls };
}

const AUDIO = `${ROOT}/outputs/take-2.wav`;

beforeEach(() => forgetLocalMedia());

describe("which paths could even be this conversation's file", () => {
  it("accepts a file strictly inside the root the server reported", () => {
    expect(workspaceRelativePath(ROOT, `${ROOT}/outputs/take-2.wav`)).toBe("outputs/take-2.wav");
    expect(workspaceRelativePath(`${ROOT}/`, `${ROOT}/take.wav`)).toBe("take.wav");
    expect(workspaceRelativePath(ROOT, `${ROOT}/a/b/c/take.wav`)).toBe("a/b/c/take.wav");
  });

  it("refuses the root itself, its siblings and anything above it", () => {
    for (const path of [ROOT, `${ROOT}/`, `${ROOT}-backup/take.wav`, "/Users/sean/take.wav", "/take.wav", ""]) {
      expect(workspaceRelativePath(ROOT, path), path).toBeNull();
    }
  });

  it("refuses traversal, hidden segments and the private names the server hides", () => {
    for (const path of [`${ROOT}/../take.wav`, `${ROOT}/outputs/../../take.wav`, `${ROOT}/.ssh/id_rsa`, `${ROOT}/outputs/./take.wav`, `${ROOT}//take.wav`]) {
      const relative = workspaceRelativePath(ROOT, path);
      expect(relative === null || !relative.split("/").some(part => part.startsWith(".") || part === ""), path).toBe(true);
    }
    expect(workspaceRelativePath(ROOT, `${ROOT}/../take.wav`)).toBeNull();
    expect(workspaceRelativePath(ROOT, `${ROOT}/.hidden/take.wav`)).toBeNull();
  });

  it("matches Windows paths the way Windows does, and POSIX paths the way POSIX does", () => {
    expect(workspaceRelativePath("C:\\Users\\Sean\\desk", "c:/users/sean/desk/Take.WAV")).toBe("Take.WAV");
    expect(workspaceRelativePath("C:\\Users\\Sean\\desk", "C:\\Users\\Sean\\desk\\out\\take.wav")).toBe("out/take.wav");
    expect(workspaceRelativePath("/home/sean/desk", "/home/Sean/desk/take.wav")).toBeNull();
  });

  it("names the directory a file lives in", () => {
    expect(workspaceParentDirectory("outputs/take-2.wav")).toBe("outputs");
    expect(workspaceParentDirectory("a/b/c.wav")).toBe("a/b");
    expect(workspaceParentDirectory("take.wav")).toBe("");
  });
});

describe("asking the harness before playing anything", () => {
  it("resolves a workspace file to pinned bytes and a capability URL", async () => {
    const { api, calls } = harness({});
    const result = await resolveLocalMedia({ scope: SCOPE, absolutePath: AUDIO }, api);
    expect(result).toMatchObject({ state: "ready", url: expect.stringContaining("/api/media/bytes/") });
    expect(calls.map(call => call.path.split("?")[0])).toEqual([
      "/api/workspace-files/root", "/api/workspace-files/list", "/api/media/resolve",
    ]);
    const body = JSON.parse(String(calls[2]!.init!.body));
    expect(body).toEqual({ ref: { source: "workspace", scope: SCOPE, relativePath: "outputs/take-2.wav", revision: REVISION } });
  });

  it("never sends the absolute path anywhere, in any request", async () => {
    const { api, calls } = harness({});
    await resolveLocalMedia({ scope: SCOPE, absolutePath: AUDIO }, api);
    for (const call of calls) {
      expect(decodeURIComponent(call.path)).not.toContain(ROOT);
      expect(String(call.init?.body ?? "")).not.toContain(ROOT);
    }
  });

  it("stops at the first question when the conversation has no dedicated workspace", async () => {
    for (const root of [
      { scope: SCOPE, state: "no-dedicated-workspace", label: "Research", managed: false },
      { scope: SCOPE, state: "remote", label: "Research", managed: false },
      { scope: SCOPE, state: "ready", label: "Research", managed: true },
    ]) {
      const { api, calls } = harness({ root });
      expect(await resolveLocalMedia({ scope: SCOPE, absolutePath: AUDIO }, api)).toEqual({ state: "unavailable" });
      expect(calls).toHaveLength(1);
    }
    const refused = harness({ throwOn: "root" });
    expect(await resolveLocalMedia({ scope: SCOPE, absolutePath: AUDIO }, refused.api)).toEqual({ state: "unavailable" });
    expect(refused.calls).toHaveLength(1);
  });

  it("stops at the first question for a path that is not inside the workspace", async () => {
    const { api, calls } = harness({});
    expect(await resolveLocalMedia({ scope: SCOPE, absolutePath: "/Users/sean/Music/private.mp3" }, api)).toEqual({ state: "unavailable" });
    expect(calls).toHaveLength(1);
  });

  it("stops at discovery when the name is absent, a link or a directory", async () => {
    for (const list of [
      () => ({ entries: [], incomplete: false }),
      () => ({ entries: [entry("take-2.wav", { kind: "link", revision: undefined })], incomplete: false }),
      () => ({ entries: [entry("take-2.wav", { kind: "directory", revision: undefined })], incomplete: false }),
      () => ({ entries: [entry("take-2.wav", { revision: undefined, state: "missing" })], incomplete: false }),
    ]) {
      const { api, calls } = harness({ list });
      expect(await resolveLocalMedia({ scope: SCOPE, absolutePath: AUDIO }, api)).toEqual({ state: "unavailable" });
      expect(calls).toHaveLength(2);
    }
    const refused = harness({ throwOn: "list" });
    expect(await resolveLocalMedia({ scope: SCOPE, absolutePath: AUDIO }, refused.api)).toEqual({ state: "unavailable" });
    expect(refused.calls).toHaveLength(2);
  });

  it("follows discovery's own pages, and gives up rather than walking a huge folder", async () => {
    const paged = harness({
      list: (call) => call === 0
        ? { entries: [entry("other.wav")], cursor: "l1.next", incomplete: true }
        : { entries: [entry("take-2.wav")], incomplete: false },
    });
    expect(await resolveLocalMedia({ scope: SCOPE, absolutePath: AUDIO }, paged.api)).toMatchObject({ state: "ready" });
    expect(paged.calls.filter(call => call.path.startsWith("/api/workspace-files/list"))).toHaveLength(2);

    const endless = harness({ list: () => ({ entries: [entry("other.wav")], cursor: "l1.next", incomplete: true }) });
    expect(await resolveLocalMedia({ scope: SCOPE, absolutePath: AUDIO }, endless.api)).toEqual({ state: "unavailable" });
    expect(endless.calls.filter(call => call.path.startsWith("/api/workspace-files/list"))).toHaveLength(MEDIA_LIST_MAX_PAGES);
  });

  it("repeats the harness's own reason when the file is there but will not play", async () => {
    const cases = [
      ["missing", "missing"], ["changed", "changed"], ["denied", "denied"], ["unsupported", "unsupported"],
    ] as const;
    for (const [availability, reason] of cases) {
      const { api } = harness({ resolve: { asset: asset({ availability }) } });
      forgetLocalMedia();
      expect(await resolveLocalMedia({ scope: SCOPE, absolutePath: AUDIO }, api)).toMatchObject({ state: "unplayable", reason });
    }
  });

  it("treats a ready asset with no URL as unplayable rather than guessing one", async () => {
    const { api } = harness({ resolve: { asset: asset(), url: "" } });
    expect(await resolveLocalMedia({ scope: SCOPE, absolutePath: AUDIO }, api)).toMatchObject({ state: "unplayable" });
  });

  it("leaves images, documents and nonsense answers to their own surfaces", async () => {
    for (const resolve of [
      { asset: asset({ kind: "image", mime: "image/png" }), url: "/api/media/bytes/x?cap=y" },
      { asset: asset({ kind: "file", mime: "application/octet-stream" }), url: "/api/media/bytes/x?cap=y" },
      { asset: null },
      {},
    ]) {
      const { api } = harness({ resolve });
      forgetLocalMedia();
      expect(await resolveLocalMedia({ scope: SCOPE, absolutePath: AUDIO }, api)).toEqual({ state: "unavailable" });
    }
    const refused = harness({ throwOn: "resolve" });
    expect(await resolveLocalMedia({ scope: SCOPE, absolutePath: AUDIO }, refused.api)).toEqual({ state: "unavailable" });
  });
});

describe("one answer per file, shared", () => {
  it("asks once for a path however many cards render it", async () => {
    const { api, calls } = harness({});
    const request = { scope: SCOPE, absolutePath: AUDIO };
    const [first, second, third] = await Promise.all([localMedia(request, api), localMedia(request, api), localMedia(request, api)]);
    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(calls).toHaveLength(3);
    expect(await localMedia(request, api)).toBe(first);
    expect(calls).toHaveLength(3);
  });

  it("asks again once the answer is old, or when it is dropped", async () => {
    const { api, calls } = harness({});
    const request = { scope: SCOPE, absolutePath: AUDIO };
    await localMedia(request, api, 1_000);
    await localMedia(request, api, 61_500);
    expect(calls).toHaveLength(6);
    forgetLocalMedia(request);
    await localMedia(request, api, 61_500);
    expect(calls).toHaveLength(9);
  });

  it("keeps conversations apart: the same path in another thread is asked again", async () => {
    const { api, calls } = harness({});
    await localMedia({ scope: SCOPE, absolutePath: AUDIO }, api);
    await localMedia({ scope: { botId: SCOPE.botId, threadId: "task-8" }, absolutePath: AUDIO }, api);
    expect(calls).toHaveLength(6);
  });

  it("answers unavailable rather than rejecting when the harness itself breaks", async () => {
    const broken: MediaApi = async () => { throw new Error("harness down"); };
    await expect(localMedia({ scope: SCOPE, absolutePath: AUDIO }, broken)).resolves.toEqual({ state: "unavailable" });
  });
});
