import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import type { Store, Message } from "./store.ts";
import { CLAUDE_TURN_IMAGE_FIT, limitTurnImagePaths, TurnImages, turnImageAudience, TURN_IMAGE_UPLOAD_CAP, TURN_IMAGE_UPLOAD_TTL, withoutImageTags, type Shrink } from "./turn-images.ts";
import { TURN_IMAGE_LIMITS } from "../shared/media-assets.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=", "base64");
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeTempDir(root); });
function fixture(shrink?: Shrink | null) {
  const root = mkdtempSync(join(tmpdir(), "murage-turn-images-")); roots.push(root); mkdirSync(join(root, "attachments"));
  const messages = new Map<string, Message[]>();
  const store = { bots: [{ id: "a", threadId: "t", tasks: [{ threadId: "task" }] }, { id: "b", threadId: "u" }],
    groups: [{ threadId: "r", memberIds: ["a"], tasks: [{ threadId: "goal" }] }],
    messagesFor: (thread: string) => messages.get(thread) ?? [],
  } as unknown as Store;
  let now = 0;
  const images = new TurnImages(store, root, () => now, async () => shrink ?? null);
  const file = (bytes = png) => { const path = join(root, "attachments", `${randomUUID()}.png`); writeFileSync(path, bytes); return { path, mime: "image/png" }; };
  const text = (path: string) => `<attached-image path="${path}" />`;
  const append = (thread: string, value: Partial<Message>) => messages.set(thread, [...store.messagesFor(thread), value as Message]);
  return { root, store, images, file, text, append, tick: () => { now += TURN_IMAGE_UPLOAD_TTL; } };
}
it("promotes a bound upload without consuming a failed send and reads exact bytes after persistence/restart", async () => {
  const f = fixture(), saved = f.file(), text = f.text(saved.path);
  f.images.register("t", saved);
  expect(f.images.promote("t", text)).toHaveLength(1);
  const attachments = f.images.promote("t", text);
  f.append("t", { role: "user", text, attachments });
  expect(await new TurnImages(f.store, f.root).read("t", "a", text)).toEqual([{ mimeType: "image/png", data: png.toString("base64") }]);
});
it("rejects prose-only, other-thread, private and expired grants without reading them", async () => {
  const f = fixture(), saved = f.file(), text = f.text(saved.path);
  f.append("t", { role: "user", text });
  await expect(f.images.read("t", "a", text)).rejects.toThrow("Reattach");
  f.images.register("u", saved);
  expect(f.images.promote("t", text)).toEqual([]);
  await expect(f.images.read("t", "a", text)).rejects.toThrow("Reattach");
  f.tick(); expect(f.images.promote("u", text)).toEqual([]);
  const privatePath = join(f.root, "private.png"); writeFileSync(privatePath, png);
  f.append("t", { attachments: [{ kind: "image", path: privatePath, mime: "image/png" }] });
  await expect(f.images.read("t", "a", f.text(privatePath))).rejects.toThrow("Reattach");
});
it("checks exact direct task and room goal membership", async () => {
  const f = fixture();
  expect(turnImageAudience(f.store, "task", "a")).toBe(true);
  expect(turnImageAudience(f.store, "goal", "a")).toBe(true);
  expect(turnImageAudience(f.store, "goal", "b")).toBe(false);
  expect(turnImageAudience(f.store, "missing")).toBe(false);
  const saved = f.file(); f.append("goal", { attachments: [{ kind: "image", ...saved }] });
  expect(await f.images.read("goal", "a", f.text(saved.path))).toHaveLength(1);
  f.store.bots[0]!.hidden = true;
  await expect(f.images.read("goal", "a", f.text(saved.path))).rejects.toThrow("Reattach");
});
it("lets a text-only turn through to an archived bot's own thread and still refuses its images", async () => {
  // Archiving keeps a bot out of rooms and goals, not out of its own direct
  // and webhook turns (routines botState); only image reads are refused.
  const f = fixture(), saved = f.file();
  f.append("t", { attachments: [{ kind: "image", ...saved }] });
  f.store.bots[0]!.hidden = true;
  expect(f.images.promote("t", "status please")).toEqual([]);
  expect(await f.images.read("t", "a", "status please")).toEqual([]);
  expect(() => f.images.promote("t", f.text(saved.path))).toThrow("Reattach");
  await expect(f.images.read("t", "a", f.text(saved.path))).rejects.toThrow("Reattach");
  expect(() => f.images.promote("missing", "status please")).not.toThrow();
});
it("refuses linked files and MIME masquerading, and leaves an oversized image out instead of failing the turn", async () => {
  const f = fixture();
  const link = join(f.root, "attachments", `${randomUUID()}.png`), target = f.file(); symlinkSync(target.path, link);
  f.append("t", { attachments: [{ kind: "image", path: link, mime: "image/png" }] });
  await expect(f.images.read("t", "a", f.text(link))).rejects.toThrow("Reattach");
  const invalid = f.file(Buffer.from("not an image")); f.append("t", { attachments: [{ kind: "image", ...invalid }] });
  await expect(f.images.read("t", "a", f.text(invalid.path))).rejects.toThrow("valid PNG");
  // Over the per-image ceiling with no way to shrink it: left out, named, and
  // the turn goes on. The bytes are never read.
  const large = f.file(); truncateSync(large.path, 10 * 1024 * 1024 + 1); f.append("t", { attachments: [{ kind: "image", ...large }] });
  expect(await f.images.collect("t", "a", f.text(large.path))).toEqual({ images: [], unbound: [], overCount: [], tooLarge: [large.path] });
  expect(await f.images.read("t", "a", f.text(large.path))).toEqual([]);
});
it("bounds pending metadata, releases durable grants and expires abandoned ones", () => {
  const f = fixture();
  for (let index = 0; index < TURN_IMAGE_UPLOAD_CAP; index++) f.images.register("t", { path: join(f.root, "attachments", `${index}.png`), mime: "image/png" });
  expect(() => f.images.register("t", f.file())).toThrow("Too many");
  f.append("t", { attachments: [{ kind: "image", path: join(f.root, "attachments", "0.png"), mime: "image/png" }] });
  expect(() => f.images.register("t", f.file())).not.toThrow();
  f.tick(); expect(() => f.images.register("t", f.file())).not.toThrow();
});
it("collects a bound image and carries an unbound one as a path, reading nothing on the tag's say-so", async () => {
  // A legacy upload made without a thread, or a tag carried in from another
  // thread: Murage wrote the file, but nothing bound it to this conversation.
  const f = fixture(), bound = f.file(), unbound = f.file(Buffer.from("never read"));
  f.append("t", { attachments: [{ kind: "image", ...bound }] });
  const text = `${f.text(bound.path)}\n${f.text(unbound.path)}`;
  const collected = await f.images.collect("t", "a", text);
  expect(collected.images).toEqual([{ mimeType: "image/png", data: png.toString("base64") }]);
  expect(collected.unbound).toEqual([unbound.path]);
  // The bytes of the unbound file were never opened: a file that is not an
  // image at all sails through with no MIME refusal, because no sniff ran.
  expect(JSON.stringify(collected)).not.toContain(Buffer.from("never read").toString("base64"));
  // The turn-refusing form still refuses the same text.
  await expect(f.images.read("t", "a", text)).rejects.toThrow("Reattach");
  // And a turn made only of unbound tags inlines nothing and refuses nothing.
  expect(await f.images.collect("t", "a", f.text(unbound.path))).toEqual({ images: [], unbound: [unbound.path], overCount: [], tooLarge: [] });
});
it("still refuses a forged path that merely looks canonical, from collect as from read", async () => {
  const f = fixture(), real = f.file();
  f.append("t", { attachments: [{ kind: "image", ...real }] });
  // Outside the attachments directory, under a canonical-looking name.
  const outside = join(f.root, `${randomUUID()}.png`); writeFileSync(outside, png);
  await expect(f.images.collect("t", "a", f.text(outside))).rejects.toThrow("Reattach");
  // Traversal into the directory from elsewhere, kept un-normalised: the
  // string comparison in canonical() is what refuses it.
  const traversal = `${f.root}/elsewhere/../attachments/${randomUUID()}.png`;
  await expect(f.images.collect("t", "a", f.text(traversal))).rejects.toThrow("Reattach");
  // A symlink at a canonical name, bound to the conversation, is refused at
  // the file, not waved through as unbound.
  const link = join(f.root, "attachments", `${randomUUID()}.png`); symlinkSync(real.path, link);
  f.append("t", { attachments: [{ kind: "image", path: link, mime: "image/png" }] });
  await expect(f.images.collect("t", "a", f.text(link))).rejects.toThrow("Reattach");
  // Another bot's own thread naming this thread's upload is the cross-thread
  // case: canonical, so not forged, but unbound THERE — carried as a path,
  // never inlined, and still a refusal on the turn-refusing form.
  expect(await f.images.collect("u", "b", f.text(real.path))).toEqual({ images: [], unbound: [real.path], overCount: [], tooLarge: [] });
  await expect(f.images.read("u", "b", f.text(real.path))).rejects.toThrow("Reattach");
  // A thread that is nobody's is not an audience at all, bound or not.
  await expect(f.images.collect("missing", "a", f.text(real.path))).rejects.toThrow("Reattach");
  // A forged path past the per-turn count is left out unread, not refused:
  // its tag leaves the text the bot receives (overCount), so nothing reads it.
  const ten = Array.from({ length: 10 }, () => { const saved = f.file(); f.append("t", { attachments: [{ kind: "image", ...saved }] }); return saved.path; });
  const collected = await f.images.collect("t", "a", [...ten, outside].map(f.text).join("\n"));
  expect(collected.images).toHaveLength(10);
  expect(collected.overCount).toEqual([outside]);
  // Inside the count the same forged path is still refused.
  await expect(f.images.collect("t", "a", [outside, ...ten].map(f.text).join("\n"))).rejects.toThrow("Reattach");
});

// Sean, 2026-09-29: "Attach at most four images per turn." failed the whole
// turn, and Retry sent the same text again. An image limit never fails a turn.
it("inlines the first ten images in order and leaves the rest out, whatever they are, without reading them", async () => {
  const f = fixture();
  const bound = Array.from({ length: 12 }, (_, index) => {
    const saved = f.file(Buffer.concat([png, Buffer.from([index])]));
    f.append("t", { attachments: [{ kind: "image", ...saved }] });
    return saved.path;
  });
  const text = `Look at these\n\n${bound.map(f.text).join("\n\n")}`;
  expect(limitTurnImagePaths(text)).toEqual({ kept: bound.slice(0, 10), overCount: bound.slice(10) });
  const collected = await f.images.collect("t", "a", text);
  expect(collected.images.map(image => Buffer.from(image.data, "base64").at(-1))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  expect(collected).toMatchObject({ unbound: [], overCount: bound.slice(10), tooLarge: [] });
  // read() is the Fuigo form: it refuses only an unbound tag, never a count.
  expect(await f.images.read("t", "a", text)).toHaveLength(10);
  // The same path twice is one image.
  expect(limitTurnImagePaths(`${f.text(bound[0]!)}\n${f.text(bound[0]!)}`)).toEqual({ kept: [bound[0]], overCount: [] });
  expect(TURN_IMAGE_LIMITS.maxCount).toBe(10);
});

it("keeps images in order while they fit the turn's byte budget and leaves the rest out as too large", async () => {
  const f = fixture();
  const big = () => { const saved = f.file(Buffer.concat([png, Buffer.alloc(6 * 1024 * 1024)])); f.append("t", { attachments: [{ kind: "image", ...saved }] }); return saved.path; };
  const small = () => { const saved = f.file(); f.append("t", { attachments: [{ kind: "image", ...saved }] }); return saved.path; };
  // 6 + 6 MB fit the 15 MB budget; the third 6 MB does not, and everything
  // after it is left out too, the small one included: order is kept.
  const paths = [big(), big(), big(), small()];
  const collected = await f.images.collect("t", "a", paths.map(f.text).join("\n"));
  expect(collected.images).toHaveLength(2);
  expect(collected.tooLarge).toEqual(paths.slice(2));
  expect(TURN_IMAGE_LIMITS.maxTotalBytes).toBe(15 * 1024 * 1024);
});

it("shrinks an image that does not fit instead of leaving it out, and keeps one that already fits as it is", async () => {
  const shrunk = Buffer.concat([png, Buffer.from("shrunk")]);
  const calls: Array<{ size: number; maxBytes: number; maxEdge: number }> = [];
  const shrink: Shrink = async (bytes, target) => {
    calls.push({ size: bytes.length, ...target });
    return bytes.length <= target.maxBytes ? "fits" : { bytes: shrunk };
  };
  const f = fixture(shrink);
  const huge = f.file(Buffer.concat([png, Buffer.alloc(12 * 1024 * 1024)])); f.append("t", { attachments: [{ kind: "image", ...huge }] });
  const fine = f.file(); f.append("t", { attachments: [{ kind: "image", ...fine }] });
  const collected = await f.images.collect("t", "a", `${f.text(huge.path)}\n${f.text(fine.path)}`, CLAUDE_TURN_IMAGE_FIT);
  expect(collected.tooLarge).toEqual([]);
  expect(collected.images).toEqual([{ mimeType: "image/png", data: shrunk.toString("base64") }, { mimeType: "image/png", data: png.toString("base64") }]);
  expect(calls[0]).toMatchObject({ maxBytes: CLAUDE_TURN_IMAGE_FIT.targetBytes, maxEdge: 2000 });
  // A shrinker that cannot help leaves an over-ceiling image out, not the turn.
  const g = fixture(async () => null);
  const over = g.file(Buffer.concat([png, Buffer.alloc(4 * 1024 * 1024)])); g.append("t", { attachments: [{ kind: "image", ...over }] });
  expect(await g.images.collect("t", "a", g.text(over.path), CLAUDE_TURN_IMAGE_FIT)).toMatchObject({ images: [], tooLarge: [over.path] });
  // ...and a shrinker whose output is not an image is a refusal, as ever.
  const h = fixture(async () => ({ bytes: Buffer.from("not an image") }));
  const odd = h.file(Buffer.concat([png, Buffer.alloc(4 * 1024 * 1024)])); h.append("t", { attachments: [{ kind: "image", ...odd }] });
  await expect(h.images.collect("t", "a", h.text(odd.path), CLAUDE_TURN_IMAGE_FIT)).rejects.toThrow("valid PNG");
});

it("removes exactly the left-out tags from the text a bot receives", () => {
  const keep = "/d/attachments/a.png", drop = "/d/attachments/b.png";
  const text = `Two\n\n<attached-image path="${keep}" />\n\n<attached-image path="${drop}" />\n<attached-file path="${drop}" />\nquoted <attached-image path="${drop}" /> mid-line stays`;
  expect(withoutImageTags(text, [drop])).toBe(`Two\n\n<attached-image path="${keep}" />\n\n<attached-file path="${drop}" />\nquoted <attached-image path="${drop}" /> mid-line stays`);
  expect(withoutImageTags(text, [])).toBe(text);
});
