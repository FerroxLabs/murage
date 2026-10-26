// SPDX-License-Identifier: AGPL-3.0-or-later
// Settings > Storage's attachment list (1.0.3, ATTACHMENT-STORE-DESIGN r7):
// R1.9's renderer half (no attachment bytes are asked for while 1,000 rows
// render and page), L8 and L8b on the rendered page, and the copy rules.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  INDEXING_LINE, isBotPicture, LIST_ROUTE, loadFirst, loadMore, PICTURE_IN_USE_LINE, REMOVE_CONFIRM_LINE, REMOVE_FAILED_LINE, REMOVE_PENDING_LINE, REMOVE_ROUTE,
  REMOVED_LINE, removeFile, STALE_LINE, TRUNCATED_LINE, UNREADABLE_LINE, usedInLine,
  type StorageListAnswer, type StorageListItem, type StorageListPage, type StorageListState, type StorageListTotals,
} from "@/lib/storage-list";
import { StorageListView, type StorageRemoveControls } from "./StorageListView";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
const kinds = ["image", "document", "audio", "video", "other"] as const;
const row = (i: number): StorageListItem => ({
  name: `${i.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000.${["png", "pdf", "mp3", "mp4", "zip"][i % 5]}`,
  bytes: 1000 - i, modifiedAt: 1_700_000_000_000, kind: kinds[i % 5]!,
  usedIn: i % 3 === 0 ? { state: "used", labels: ["Moss"], more: i % 2 === 0 } : i % 3 === 1 ? { state: "unused" } : { state: "unknown" },
});
const totals = (over: Partial<StorageListTotals> = {}): StorageListTotals => ({ count: 1000, bytes: 500_000, other: { count: 0, bytes: 0, unreadable: 0 }, vanished: 0, truncated: false, ...over });

/** A fake server holding 1,000 rows; it records every URL the pager asks for. */
function fakeServer(all: StorageListItem[], over: Partial<StorageListPage> = {}) {
  const urls: string[] = [];
  const get = async (url: string): Promise<StorageListAnswer> => {
    urls.push(url);
    const query = new URL(url, "http://x").searchParams;
    const start = Number(query.get("cursor") ?? 0);
    const limit = Number(query.get("limit"));
    const next = start + limit;
    return { state: "ok", snapshot: "s1", order: "size", items: all.slice(start, next), nextCursor: next < all.length ? String(next) : null, totals: totals(), coverageComplete: true, ...over };
  };
  return { get, urls };
}
const render = (state: StorageListState) => renderToStaticMarkup(createElement(StorageListView, { state, order: "size", onOrder: () => {}, onMore: () => {}, onReload: () => {} }));
const ready = async (over: Partial<StorageListPage> = {}) => {
  const state = await loadFirst(fakeServer([row(1)], over).get, "size");
  expect(state.phase).toBe("ready");
  return state;
};

describe("R1.9: the list asks for no attachment bytes", () => {
  it("1,000 rows render and page with zero requests to any attachment-bytes route", async () => {
    const server = fakeServer(Array.from({ length: 1000 }, (_, i) => row(i)));
    let state = await loadFirst(server.get, "size");
    while (state.phase === "ready" && state.nextCursor) state = await loadMore(server.get, state);
    expect(state.phase === "ready" && state.items).toHaveLength(1000);
    expect(server.urls).toHaveLength(20);
    for (const url of server.urls) expect(url.startsWith(`${LIST_ROUTE}?`), url).toBe(true);
    expect(server.urls.filter(url => /\/api\/(attachments|media)\b/.test(url))).toEqual([]);
    const html = render(state);
    expect(html.match(/data-storage-row/g)).toHaveLength(1000);
    expect(html).not.toMatch(/<img|<video|<audio|<source|<object|<embed|<iframe|srcset|src=|url\(/i);
    expect(html).not.toContain("/api/attachments");
    expect(html).not.toContain("/api/media");
  });

  it("the list's sources reach no byte route and draw no preview", () => {
    for (const file of ["./StorageList.tsx", "./StorageListView.tsx", "../lib/storage-list.ts"]) {
      const source = read(file);
      expect(source, file).not.toMatch(/<img|src=|\/api\/attachments|\/api\/media|saveUrl|clickDownload|fetch\(/);
    }
    // the component's requests: the pager's, to the list route, and Remove's (1.0.4 SL-H), to its route
    expect(read("./StorageList.tsx").match(/api\(/g)).toHaveLength(2);
    expect(read("./StorageList.tsx")).toMatch(/api\(url, \{ method: "POST"/);
  });
});

describe("notices (R1.3, R1.7, R1.8; L8, L8b)", () => {
  const vanishedOnly = /changed while Murage was looking; reload to see them/;
  const unreadableOnly = /could not be examined/;

  it("vanished shows only the reload line; an EACCES entry shows only the not-counted line; both show both", async () => {
    const vanished = render(await ready({ totals: totals({ vanished: 3 }) }));
    expect(vanished).toContain("3 files changed while Murage was looking; reload to see them.");
    expect(vanished).not.toMatch(unreadableOnly);
    const denied = render(await ready({ totals: totals({ other: { count: 0, bytes: 0, unreadable: 2, firstError: "EACCES" } }) }));
    expect(denied).toContain("2 entries in the attachments folder could not be examined (EACCES); they are not counted.");
    expect(denied).not.toMatch(vanishedOnly);
    const both = render(await ready({ totals: totals({ vanished: 1, other: { count: 0, bytes: 0, unreadable: 1, firstError: "EIO" } }) }));
    expect(both).toMatch(vanishedOnly);
    expect(both).toMatch(unreadableOnly);
  });

  it("L8b: the not-counted line never says reload, and the vanished line never carries an error code", async () => {
    const state = await ready({ totals: totals({ vanished: 4, other: { count: 0, bytes: 0, unreadable: 5, firstError: "EACCES" } }) });
    const lines = state.phase === "ready" ? state.notices : [];
    const unreadableLine = lines.find(line => unreadableOnly.test(line))!;
    const vanishedLine = lines.find(line => vanishedOnly.test(line))!;
    expect(unreadableLine.toLowerCase()).not.toContain("reload");
    expect(vanishedLine).not.toMatch(/E[A-Z]{2,}/);
  });

  it("an unreadable folder, a truncated walk, indexing, and a changed list each say so", async () => {
    expect(render(await loadFirst(async () => ({ state: "unreadable", message: UNREADABLE_LINE }), "size"))).toContain(UNREADABLE_LINE);
    expect(render(await ready({ totals: totals({ truncated: true }) }))).toContain(TRUNCATED_LINE);
    expect(render(await ready({ coverageComplete: false }))).toContain(INDEXING_LINE);
    expect(render(await ready())).not.toContain(INDEXING_LINE);
    const stale = await loadFirst(async () => { throw Object.assign(new Error("x"), { status: 409 }); }, "size");
    expect(render(stale)).toContain(STALE_LINE);
    const ok = await ready();
    if (ok.phase !== "ready") throw new Error("not ready");
    const changed = await loadMore(async () => { throw Object.assign(new Error("x"), { status: 409 }); }, { ...ok, nextCursor: "50" });
    expect(render(changed)).toContain(STALE_LINE);
  });

  it("an incomplete walk with no rows never reads as an empty store (Astra build review)", async () => {
    const empty = (over: Partial<StorageListTotals>) => loadFirst(async () => ({ state: "ok", snapshot: "s", order: "size", items: [], nextCursor: null, totals: totals({ count: 0, ...over }), coverageComplete: true }), "size");
    for (const over of [{ truncated: true }, { vanished: 2 }, { other: { count: 0, bytes: 0, unreadable: 1, firstError: "EACCES" } }]) {
      const html = render(await empty(over));
      expect(html).not.toContain("No attachment files yet");
      expect(html).toContain("No attachment files could be listed.");
    }
    expect(render(await empty({}))).toContain("No attachment files yet.");
  });

  it("used in reads plainly", () => {
    expect(usedInLine({ state: "used", labels: ["Moss", "Picture of Fern"], more: true })).toBe("Moss, Picture of Fern and possibly more");
    expect(usedInLine({ state: "unused" })).toBe("Not in any sent message (it may still be in a draft)");
    expect(usedInLine({ state: "unknown" })).toBe("Not checked yet");
  });
});

describe("copy", () => {
  it("no em dashes, and none of the words the copy rules ban", () => {
    for (const file of ["./StorageList.tsx", "./StorageListView.tsx", "../lib/storage-list.ts"]) {
      const source = read(file);
      expect(source, file).not.toContain(String.fromCharCode(0x2014));
      expect(source, file).not.toMatch(new RegExp(`\\b(${["sa" + "fe", "unsa" + "fe", "sa" + "fety"].join("|")})\\b`, "i"));
    }
  });
  it("no Export or thumbnail controls, and no Remove unless this computer offers it (never a Cloud home)", () => {
    const html = render({ phase: "ready", order: "size", snapshot: "s", items: [row(0)], nextCursor: null, notices: [], totals: totals(), loadingMore: false });
    expect(html).not.toMatch(/export|remove|delete|checkbox|thumbnail/i);
    expect(read("./StorageList.tsx")).toMatch(/const removable = !isCloudOrigin\(\)/);
  });
});

// 1.0.4 SL-H: Remove on each row, after a confirm; a bot's picture is refused.
describe("Remove (SL-H)", () => {
  const controls = (over: Partial<StorageRemoveControls> = {}): StorageRemoveControls => ({ confirming: null, removing: null, notice: null, onAsk: () => {}, onCancel: () => {}, onConfirm: () => {}, ...over });
  const picture: StorageListItem = { ...row(4), usedIn: { state: "used", labels: ["Picture of Fern"], more: false } };
  const state = (items: StorageListItem[]): StorageListState => ({ phase: "ready", order: "size", snapshot: "s", items, nextCursor: null, notices: [], totals: totals(), loadingMore: false });
  const view = (items: StorageListItem[], remove: StorageRemoveControls) => renderToStaticMarkup(createElement(StorageListView, { state: state(items), order: "size", onOrder: () => {}, onMore: () => {}, onReload: () => {}, remove }));

  it("offers Remove on each row and disables it, with the reason, on a bot's picture", () => {
    const html = view([row(1), picture], controls());
    expect(html.match(/data-storage-remove="true"/g)).toHaveLength(2);
    expect(html).toMatch(new RegExp(`disabled="" title="${PICTURE_IN_USE_LINE.replace("'", "&#x27;")}"`));
    expect(isBotPicture(picture.usedIn)).toBe(true);
    expect(isBotPicture(row(0).usedIn)).toBe(false);
  });

  it("asks before it removes, and says how it went", () => {
    const confirm = view([row(1)], controls({ confirming: row(1).name }));
    expect(confirm).toContain(REMOVE_CONFIRM_LINE);
    expect(confirm).toContain("data-storage-remove-confirm");
    expect(confirm).toContain("Keep it");
    expect(view([row(1)], controls({ notice: REMOVED_LINE }))).toContain(REMOVED_LINE);
  });

  it("removeFile posts one name to the Remove route and reads every answer", async () => {
    const posted: unknown[] = [];
    const answer = (results: unknown) => async (url: string, body: unknown) => { posted.push([url, body]); return { results } as never; };
    const name = row(1).name;
    expect(await removeFile(answer([{ name, state: "removed" }]), name)).toEqual({ removed: true, line: REMOVED_LINE });
    expect(posted[0]).toEqual([REMOVE_ROUTE, { names: [name] }]);
    expect(await removeFile(answer([{ name, state: "pending" }]), name)).toEqual({ removed: true, line: REMOVE_PENDING_LINE });
    const refused = async () => { throw Object.assign(new Error("x"), { status: 409, body: { results: [{ name, state: "refused", error: PICTURE_IN_USE_LINE }] } }); };
    expect(await removeFile(refused, name)).toEqual({ removed: false, line: PICTURE_IN_USE_LINE });
    expect(await removeFile(async () => { throw new Error("offline"); }, name)).toEqual({ removed: false, line: REMOVE_FAILED_LINE });
  });
});
