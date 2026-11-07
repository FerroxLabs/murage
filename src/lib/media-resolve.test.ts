// F5-T3: what has to be true before a path in a transcript becomes a player.
// The renderer suite runs in node with no DOM, so this file drives the three
// harness questions against a recording fake and pins the path arithmetic.
// Real playback, seeking and pause-on-unmount are proved in a browser by
// src/e2e/media-player.human.spec.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  retryLocalMedia, refreshLocalMedia, imageRecoveryOwner, localMediaCounts, conversationWorkspaceRoot, subscribeLocalMedia, retainLocalMediaGeneration,
  conversationLinkPath,
  forgetLocalMedia,
  localMedia,
  MEDIA_LIST_MAX_PAGES,
  resolveLocalMedia,
  workspaceParentDirectory,
  workspaceRelativePath,
  type MediaApi,
} from "./media-resolve";

const ROOT = "/Users/alex/.murage/workspaces/research";
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
    const params = new URL(path, "http://x").searchParams;
    const scope = { botId: params.get("botId")!, threadId: params.get("threadId")! };
    if (path.startsWith("/api/workspace-files/root")) {
      if (answers.throwOn === "root") throw Object.assign(new Error("no workspace"), { status: 409 });
      return answers.root ?? { scope, state: "ready", label: "Research", displayPath: ROOT, managed: true };
    }
    if (path.startsWith("/api/workspace-files/list")) {
      if (answers.throwOn === "list") throw Object.assign(new Error("gone"), { status: 409 });
      const cursor = new URL(path, "http://x").searchParams.get("cursor");
      return { scope, directory: params.get("directory") ?? "", directoryRevision: "d1.test", ...(answers.list ? answers.list(listCalls++, cursor) as object : { entries: [entry("take-2.wav")], incomplete: false }) };
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
    for (const path of [ROOT, `${ROOT}/`, `${ROOT}-backup/take.wav`, "/Users/alex/take.wav", "/take.wav", ""]) {
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
      expect(await resolveLocalMedia({ scope: SCOPE, absolutePath: AUDIO }, api)).toEqual({ state: "unavailable", why: root.state === "remote" ? "remote" : root.state === "no-dedicated-workspace" ? "outside" : "unanswered" });
      expect(calls).toHaveLength(1);
    }
    const refused = harness({ throwOn: "root" });
    expect(await resolveLocalMedia({ scope: SCOPE, absolutePath: AUDIO }, refused.api)).toEqual({ state: "unavailable", why: "unanswered" });
    expect(refused.calls).toHaveLength(1);
  });

  it("stops at the first question for a path that is not inside the workspace", async () => {
    const { api, calls } = harness({});
    expect(await resolveLocalMedia({ scope: SCOPE, absolutePath: "/Users/alex/Music/private.mp3" }, api)).toEqual({ state: "unavailable", why: "outside" });
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
      expect(await resolveLocalMedia({ scope: SCOPE, absolutePath: AUDIO }, api)).toEqual({ state: "unavailable", why: "not-listed" });
      expect(calls).toHaveLength(2);
    }
    const refused = harness({ throwOn: "list" });
    expect(await resolveLocalMedia({ scope: SCOPE, absolutePath: AUDIO }, refused.api)).toEqual({ state: "unavailable", why: "unanswered" });
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

    const endless = harness({ list: (page) => ({ entries: [entry("other.wav")], cursor: `l1.next${page}`, incomplete: true }) });
    expect(await resolveLocalMedia({ scope: SCOPE, absolutePath: AUDIO }, endless.api)).toEqual({ state: "unavailable", why: "unanswered" });
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
      { asset: null },
      {},
    ]) {
      const { api } = harness({ resolve });
      forgetLocalMedia();
      expect(await resolveLocalMedia({ scope: SCOPE, absolutePath: AUDIO }, api)).toEqual({ state: "unavailable", why: "unanswered" });
    }
    const refused = harness({ throwOn: "resolve" });
    expect(await resolveLocalMedia({ scope: SCOPE, absolutePath: AUDIO }, refused.api)).toEqual({ state: "unavailable", why: "unanswered" });
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
    await expect(localMedia({ scope: SCOPE, absolutePath: AUDIO }, broken)).resolves.toEqual({ state: "unavailable", why: "unanswered" });
  });
});

describe("where a relative link in a reply points", () => {
  // The root answer is cached per conversation, so each case uses its own.
  let n = 0;
  const scope = () => ({ botId: "research", threadId: `link-${++n}` });
  /** A conversation folder at ROOT whose listed directories hold these files. */
  const withDirectories = (directories: Record<string, string[]>): MediaApi => async path => {
    const params = new URL(path, "http://x").searchParams;
    const scope = { botId: params.get("botId")!, threadId: params.get("threadId")! };
    if (path.startsWith("/api/workspace-files/root")) return { scope, state: "ready", label: "Research", displayPath: ROOT, managed: true };
    if (path.startsWith("/api/workspace-files/list")) {
      const directory = new URL(path, "http://x").searchParams.get("directory") ?? "";
      return { scope, directory, directoryRevision: "d1.test", entries: (directories[directory] ?? []).map(name => entry(name, { relativePath: `${directory}/${name}` })), incomplete: false };
    }
    throw new Error(`unexpected route ${path}`);
  };

  it("opens the file the bot saved under outputs/ when it is there", async () => {
    const api = withDirectories({ "outputs/reports": ["today.md"] });
    expect(await conversationLinkPath(scope(), "reports/today.md", api)).toBe(`${ROOT}/outputs/reports/today.md`);
  });

  it("reads the link against the conversation folder when outputs/ has no such file", async () => {
    const api = withDirectories({ reports: ["today.md"] });
    expect(await conversationLinkPath(scope(), "reports/today.md", api)).toBe(`${ROOT}/reports/today.md`);
  });

  it("does not add outputs/ twice to a link that already starts with it", async () => {
    const api = withDirectories({ "outputs/outputs": ["x.md"] });
    expect(await conversationLinkPath(scope(), "outputs/x.md", api)).toBe(`${ROOT}/outputs/x.md`);
  });

  it("falls back to the conversation folder when the listing fails, and gives nothing without a folder", async () => {
    const failing = harness({ throwOn: "list" }).api;
    expect(await conversationLinkPath(scope(), "reports/today.md", failing)).toBe(`${ROOT}/reports/today.md`);
    const noRoot = harness({ throwOn: "root" }).api;
    expect(await conversationLinkPath(scope(), "reports/today.md", noRoot)).toBeNull();
  });

  it("keeps a Windows folder's backslashes", async () => {
    const windowsRoot = "C:\\Users\\me\\.murage\\workspaces\\research\\threads\\t1";
    const api: MediaApi = async path => {
      const params = new URL(path, "http://x").searchParams;
      const scope = { botId: params.get("botId")!, threadId: params.get("threadId")! };
      if (path.startsWith("/api/workspace-files/root")) return { scope, state: "ready", label: "Research", displayPath: windowsRoot, managed: true };
      const directory = new URL(path, "http://x").searchParams.get("directory");
      return { scope, directory, directoryRevision: "d1.test", entries: directory === "outputs/reports" ? [entry("today.md", { relativePath: "outputs/reports/today.md" })] : [], incomplete: false };
    };
    expect(await conversationLinkPath(scope(), "reports/today.md", api)).toBe(`${windowsRoot}\\outputs\\reports\\today.md`);
  });
});

describe("D-LOCAL-IMAGE typed discovery and shared recovery", () => {
  const request = { scope: SCOPE, absolutePath: AUDIO };
  it("R31-DISC distinguishes truncation, bad pages and repeated cursors from absence", async () => {
    for (const page of [{ entries: [], incomplete: true }, { entries: [], incomplete: "false" }, { entries: [], incomplete: false, directory: "other" }, { entries: [], incomplete: false, scope: { ...SCOPE, threadId: "wrong" } }, { entries: [], incomplete: true, cursor: "same" }]) {
      forgetLocalMedia(); const h = harness({ list: () => page });
      expect(await localMedia(request, h.api)).toEqual({ state: "unavailable", why: "unanswered" });
      expect(h.calls.some(call => call.path === "/api/media/resolve")).toBe(false);
    }
  });
  it("R31-ROOT keeps no-workspace, remote and unavailable distinct", async () => {
    for (const [state, why] of [["no-dedicated-workspace", "outside"], ["remote", "remote"], ["unavailable", "unanswered"]]) {
      forgetLocalMedia(); const h = harness({ root: { scope: SCOPE, state } });
      expect(await localMedia(request, h.api)).toEqual({ state: "unavailable", why }); expect(h.calls).toHaveLength(1);
    }
  });
  it("R31-EPOCH/R32-PLAYER joins old-generation replacements without rearming images", async () => {
    const h = harness({}), image = imageRecoveryOwner();
    const first = await localMedia(request, h.api); expect(first.state).toBe("ready"); if (first.state !== "ready") throw Error();
    const [second, same] = await Promise.all([refreshLocalMedia(request, first.generation, "error", image, h.api), refreshLocalMedia(request, first.generation, "error", { kind: "player" }, h.api)]);
    expect(second).toBe(same); expect(h.calls).toHaveLength(6); if (second.state !== "ready") throw Error();
    expect(await refreshLocalMedia(request, first.generation, "late", image, h.api)).toBe(second);
    expect(await refreshLocalMedia(request, second.generation, "error", image, h.api)).toEqual({ state: "exhausted" }); expect(h.calls).toHaveLength(6);
    let current = second;
    for (let i = 0; i < 4; i++) { const next = await refreshLocalMedia(request, current.generation, "player", { kind: "player" }, h.api); if (next.state !== "ready") throw Error(); expect(next.generation).toBeGreaterThan(current.generation); current = next; }
    expect(h.calls).toHaveLength(18); expect(image.spent).toBe(true);
  });
  it("R2-G4/A13 returns 257 pending owners without spinning, bounded by four chains", async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const api: MediaApi = async () => { await gate; throw Error("down"); };
    const pending = Array.from({ length: 257 }, (_, i) => localMedia({ scope: { botId: "b", threadId: String(i) }, relativePath: "p.png" }, api));
    expect(localMediaCounts().active).toBe(4); expect(localMediaCounts().queued).toBe(253);
    release(); await Promise.all(pending); expect(localMediaCounts().eligible).toBeLessThanOrEqual(256);
  });
  it("R2-A5 times out discovery after exactly 15000 ms", async () => {
    vi.useFakeTimers();
    try {
      let done = false; const pending = localMedia(request, () => new Promise(() => {})).then(value => { done = true; return value; });
      await vi.advanceTimersByTimeAsync(14999); expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1); expect(await pending).toEqual({ state: "unavailable", why: "unanswered" });
    } finally { vi.useRealTimers(); }
  });
});

it("R31-DISC-parent-proof and R2-A3 select paths only after proven absence and join aliases", async () => {
  const calls: string[] = [];
  let missing = false, unreadable = false;
  const api: MediaApi = async (path, init) => {
    calls.push(path);
    const q = new URL(path, "http://x").searchParams, directory = q.get("directory") ?? "";
    if (path.startsWith("/api/workspace-files/root")) return { scope: SCOPE, state: "ready", displayPath: ROOT };
    if (path.startsWith("/api/workspace-files/list")) {
      if (directory === "outputs" && unreadable) throw Object.assign(Error(), { status: 404 });
      const entries = directory === "" ? (missing ? [entry("take-2.wav", { relativePath: "take-2.wav" })] : [entry("outputs", { kind: "directory", revision: undefined, relativePath: "outputs" })]) : [entry("take-2.wav")];
      return { scope: SCOPE, directory, directoryRevision: "d1.test", entries, incomplete: false };
    }
    return { asset: asset(), url: "/api/media/bytes/x?cap=y", expiresAt: Date.now() + 600000, ref: JSON.parse(String(init?.body)).ref };
  };
  const absolute = { scope: SCOPE, absolutePath: AUDIO }, relative = { scope: SCOPE, relativePath: "take-2.wav" };
  const [a, b, c] = await Promise.all([localMedia(absolute, api), localMedia(relative, api), localMedia({ scope: SCOPE, relativePath: "outputs/take-2.wav" }, api)]);
  expect(a).toBe(b); expect(b).toBe(c); expect(a).toMatchObject({ state: "ready", relativePath: "outputs/take-2.wav" });
  expect(calls.filter(path => path === "/api/media/resolve")).toHaveLength(1);
  if (a.state !== "ready") throw Error();
  const fresh = await refreshLocalMedia(absolute, a.generation, "error", imageRecoveryOwner(), api);
  expect(await refreshLocalMedia(relative, a.generation, "late", imageRecoveryOwner(), api)).toBe(fresh);
  expect(calls.filter(path => path === "/api/media/resolve")).toHaveLength(2);
  forgetLocalMedia(); calls.length = 0; unreadable = true;
  expect(await localMedia(relative, api)).toEqual({ state: "unavailable", why: "unanswered" });
  expect(calls.filter(path => path === "/api/media/resolve")).toHaveLength(0);
  forgetLocalMedia(); calls.length = 0; missing = true;
  expect(await localMedia(relative, api)).toMatchObject({ state: "ready", relativePath: "take-2.wav" });
  expect(calls.some(path => new URL(path, "http://x").searchParams.get("directory") === "outputs")).toBe(false);
});


it("T2 client module recreation discards cached capability and begins with root", async () => {
  const h = harness({}), request = { scope: SCOPE, absolutePath: AUDIO };
  await localMedia(request, h.api); expect(h.calls).toHaveLength(3);
  vi.resetModules(); const fresh = await import('./media-resolve');
  await fresh.localMedia(request, h.api); expect(h.calls).toHaveLength(6);
  expect(h.calls[3]?.path).toContain('/api/workspace-files/root?');
});

it.each(['root', '', 'outputs', 'outputs/notes', 'resolve'])('R2-A5 crash at %s is unanswered without fallback authority', async stage => {
  const calls: string[] = [];
  const api: MediaApi = async path => {
    const url = new URL(path, 'http://fixture'), dir = url.searchParams.get('directory') ?? '';
    const current = path.includes('/root?') ? 'root' : path.includes('/list?') ? dir : 'resolve'; calls.push(current);
    if (current === stage) throw Error('Isolated harness unavailable');
    if (current === 'root') return { scope: SCOPE, state: 'ready', displayPath: ROOT };
    if (current === 'resolve') return { asset: asset(), url: '/api/media/bytes/x?cap=y', expiresAt: Date.now() + 600000 };
    const name = dir === '' ? 'outputs' : dir === 'outputs' ? 'notes' : 'take-2.wav';
    return { scope: SCOPE, directory: dir, directoryRevision: 'd1.test', incomplete: false, entries: [entry(name, { relativePath: dir ? `${dir}/${name}` : name, ...(name === 'take-2.wav' ? {} : { kind: 'directory', revision: undefined }) })] };
  };
  expect(await localMedia({ scope: SCOPE, relativePath: 'notes/take-2.wav' }, api)).toEqual({ state: 'unavailable', why: 'unanswered' });
  expect(calls.at(-1)).toBe(stage); expect(calls.filter(x => x === '')).toHaveLength(stage === 'root' ? 0 : 1);
});
it('R2-G4 settled successful entries are finite and retain no more than 256 unreferenced results', async () => {
  const api: MediaApi = async path => {
    const url = new URL(path, 'http://fixture'), scope = { botId: url.searchParams.get('botId')!, threadId: url.searchParams.get('threadId')! };
    if (path.includes('/root?')) return { scope, state: 'ready', displayPath: ROOT };
    if (path.includes('/list?')) return { scope, directory: 'outputs', directoryRevision: 'd1.test', incomplete: false, entries: [entry('take-2.wav')] };
    return { asset: asset(), url: '/api/media/bytes/x?cap=y', expiresAt: Date.now() + 600000 };
  };
  const values = await Promise.all(Array.from({ length: 257 }, (_, i) => localMedia({ scope: { botId: 'b', threadId: String(i) }, absolutePath: AUDIO }, api)));
  expect(values.every(value => value.state === 'ready')).toBe(true); expect(localMediaCounts().eligible).toBe(256);
});

it('F2 hung shared conversation root releases all discovery chains at the deadline', async () => {
  vi.useFakeTimers();
  try {
    const root = conversationWorkspaceRoot(SCOPE, () => new Promise(() => {}));
    const requests = Array.from({ length: 4 }, (_, i) => localMedia({ scope: SCOPE, absolutePath: AUDIO + i }, () => new Promise(() => {})));
    await vi.advanceTimersByTimeAsync(15000);
    expect(await Promise.all(requests)).toEqual(Array(4).fill({ state: 'unavailable', why: 'unanswered' }));
    expect(localMediaCounts().active).toBe(0);
    expect(await root).toBeNull();
    expect(await localMedia({ scope: { ...SCOPE, threadId: 'later' }, absolutePath: AUDIO }, harness({}).api)).toMatchObject({ state: 'ready' });
  } finally { vi.useRealTimers(); }
});

it.each(['image', 'audio'])('F3 resolves %s beside an unaddressable server entry', async kind => {
  const h = harness({ list: () => ({ entries: [entry('notes:old', { kind: 'other', state: 'unsupported', revision: undefined }), entry('take-2.wav')], incomplete: false }), resolve: { asset: asset({ kind }), url: '/api/media/bytes/x?cap=y' } });
  expect(await localMedia({ scope: SCOPE, absolutePath: AUDIO }, h.api)).toMatchObject({ state: 'ready', asset: { kind } });
});

it('F4 settled aliases read the current canonical replacement on remount', async () => {
  const h = harness({}), a = { scope: SCOPE, absolutePath: AUDIO };
  // Absolute aliases also cover alternate textual spellings without another parent fixture.
  const alias = { ...a, absolutePath: AUDIO + '/' };
  const first = await localMedia(a, h.api); expect(await localMedia(alias, h.api)).toBe(first);
  if (first.state !== 'ready') throw Error();
  const next = await refreshLocalMedia(a, first.generation, 'player', { kind: 'player' }, h.api);
  expect(await localMedia(alias, h.api)).toBe(next);
  expect(h.calls.filter(c => c.path === '/api/media/resolve')).toHaveLength(2);
});

it('F5 publication and eviction work stays constant with retained conversation history', async () => {
  const measure = async (history: number) => {
    forgetLocalMedia(); const h = harness({}), stops: Array<() => void> = [];
    const request = (i: number) => ({ scope: { ...SCOPE, threadId: String(i) }, absolutePath: AUDIO });
    for (let i = 0; i < history; i++) { stops.push(subscribeLocalMedia(request(i), () => {})); await localMedia(request(i), h.api); }
    for (let i = history; i < history + 256; i++) await localMedia(request(i), h.api);
    const current = await localMedia(request(0), h.api); if (current.state !== 'ready') throw Error();
    let work = 0;
    const undo: Array<() => void> = [];
    for (const prototype of [Map.prototype, Set.prototype]) for (const key of [Symbol.iterator, 'values', 'keys', 'entries']) {
      const original = (prototype as any)[key];
      Object.defineProperty(prototype, key, { configurable: true, writable: true, value: function(this: any, ...args: any[]) {
        const iterator = original.apply(this, args);
        return { next(...args: any[]) { const item = iterator.next(...args); if (!item.done) work++; return item; }, [Symbol.iterator]() { return this; } };
      } });
      undo.push(() => Object.defineProperty(prototype, key, { configurable: true, writable: true, value: original }));
    }
    let publication: number, eviction: number;
    try {
      await refreshLocalMedia(request(0), current.generation, 'player', { kind: 'player' }, h.api); publication = work; work = 0;
      await localMedia(request(history + 256), h.api); eviction = work;
    } finally { undo.forEach(restore => restore()); stops.forEach(stop => stop()); }
    return { publication, eviction };
  };
  const short = await measure(8), long = await measure(512);
  process.stdout.write('F5 collection visits ' + JSON.stringify({ short, long }) + '\n');
  expect(long).toEqual(short);
  expect(long.publication).toBeLessThanOrEqual(short.publication + 8);
  expect(long.eviction).toBeLessThanOrEqual(short.eviction + 8);
  expect(long.publication).toBeLessThan(64); expect(long.eviction).toBeLessThan(64);
});

it('F9 replacement records survive only while their generation has consumers', async () => {
  const h = harness({}), request = { scope: SCOPE, absolutePath: AUDIO };
  const unsubscribe = subscribeLocalMedia(request, () => {});
  let current = await localMedia(request, h.api); if (current.state !== 'ready') throw Error();
  const first = current, releaseFirst = retainLocalMediaGeneration(first);
  let release = retainLocalMediaGeneration(current);
  for (let i = 0; i < 30; i++) {
    const next = await refreshLocalMedia(request, current.generation, 'player', { kind: 'player' }, h.api);
    if (next.state !== 'ready') throw Error();
    release(); release = retainLocalMediaGeneration(next); current = next;
    expect(localMediaCounts(request).replacements).toBe(1);
  }
  releaseFirst(); release(); unsubscribe();
  expect(localMediaCounts(request).replacements).toBe(0);
  const calls = h.calls.length;
  expect(await refreshLocalMedia(request, first.generation, 'late', { kind: 'player' }, h.api)).toBe(current);
  expect(h.calls).toHaveLength(calls);
});

it('F4 remounts join a canonical replacement while discovery is still pending', async () => {
  const h = harness({}), request = { scope: SCOPE, absolutePath: AUDIO }, alias = { ...request, absolutePath: AUDIO + '/' };
  let hold = false, release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const api: MediaApi = async (path, init) => { if (hold && path.includes('/root?')) await gate; return h.api(path, init); };
  const first = await localMedia(request, api); await localMedia(alias, api); if (first.state !== 'ready') throw Error();
  hold = true; const pending = refreshLocalMedia(request, first.generation, 'player', { kind: 'player' }, api);
  let settled = false; const remount = localMedia(alias, api).then(value => { settled = true; return value; });
  try { for (let i = 0; i < 20; i++) await Promise.resolve(); expect(settled).toBe(false); }
  finally { release(); }
  expect(await remount).toBe(await pending);
});


it.each(['refresh', 'retry'] as const)('discovery failure survives %s and both image alias remounts', async action => {
  for (const failure of ['not-listed', 'remote', 'root', 'list'] as const) {
    forgetLocalMedia();
    const answers: Parameters<typeof harness>[0] = {
      list: () => ({ entries: [entry('picture.png')], incomplete: false }),
      resolve: { asset: asset({ kind: 'image', name: 'picture.png', mime: 'image/png' }), url: '/api/media/bytes/image?cap=old' },
    };
    const h = harness(answers), request = { scope: SCOPE, absolutePath: `${ROOT}/outputs/picture.png` };
    const alias = { ...request, absolutePath: request.absolutePath + '/' };
    const first = await localMedia(request, h.api);
    expect(first).toMatchObject({ state: 'ready', asset: { kind: 'image' } });
    expect(await localMedia(alias, h.api)).toBe(first);
    if (first.state !== 'ready') throw Error('Expected ready image');
    if (failure === 'not-listed') answers.list = () => ({ entries: [], incomplete: false });
    else if (failure === 'remote') answers.root = { scope: SCOPE, state: 'remote' };
    else answers.throwOn = failure;
    const expected = { state: 'unavailable', why: failure === 'root' || failure === 'list' ? 'unanswered' : failure };
    const result = action === 'refresh'
      ? await refreshLocalMedia(request, first.generation, 'image-error', imageRecoveryOwner(), h.api)
      : await retryLocalMedia(request, h.api);
    expect(result, failure).toEqual(expected);
    const calls = h.calls.length;
    expect.soft(await localMedia(request, h.api), failure + ' original alias').toEqual(expected);
    expect.soft(await localMedia(alias, h.api), failure + ' second alias').toEqual(expected);
    expect(h.calls, failure + ' cached remount').toHaveLength(calls);
    expect(h.calls.filter(call => call.path === '/api/media/resolve'), failure).toHaveLength(1);
  }
});

it('cancelled queued retry preserves the subscribed alias until a real discovery failure', async () => {
  const h = harness({}), a = { scope: SCOPE, absolutePath: AUDIO };
  const b = { ...a, absolutePath: AUDIO + '/' };
  const first = await localMedia(a, h.api);
  expect(first.state).toBe('ready');
  expect(await localMedia(b, h.api)).toBe(first);
  const listenerA = vi.fn(), listenerB = vi.fn();
  const unsubscribeA = subscribeLocalMedia(a, listenerA);
  const unsubscribeB = subscribeLocalMedia(b, listenerB);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const blockers = Array.from({ length: 4 }, (_, i) => localMedia(
    { scope: { botId: 'queue-blocker', threadId: String(i) }, absolutePath: AUDIO },
    async () => { await gate; throw Error('isolated blocker'); },
  ));
  try {
    expect(localMediaCounts().active).toBe(4);
    const failed = harness({ throwOn: 'list' });
    const retry = retryLocalMedia(a, failed.api);
    expect(localMediaCounts().queued).toBe(1);
    unsubscribeA();
    expect(await retry).toEqual({ state: 'unavailable', why: 'unanswered' });
    expect(localMediaCounts().queued).toBe(0);
    expect(failed.calls).toHaveLength(0);
    expect.soft(await localMedia(b, h.api)).toBe(first);
    expect.soft(listenerB).not.toHaveBeenCalled();
    expect(listenerA).not.toHaveBeenCalled();
    release();
    await Promise.all(blockers);
    const failure = await retryLocalMedia(b, failed.api);
    expect(failure).toEqual({ state: 'unavailable', why: 'unanswered' });
    expect(failed.calls.map(call => call.path.split('?')[0])).toEqual(['/api/workspace-files/root', '/api/workspace-files/list']);
    expect(listenerB).toHaveBeenLastCalledWith(failure);
    expect.soft(listenerB).toHaveBeenCalledTimes(1);
    expect(await localMedia(b, h.api)).toBe(failure);
  } finally {
    release();
    await Promise.all(blockers);
    unsubscribeA(); unsubscribeB();
  }
});
