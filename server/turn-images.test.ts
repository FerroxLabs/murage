import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import type { Store, Message } from "./store.ts";
import { TurnImages, turnImageAudience, TURN_IMAGE_UPLOAD_CAP, TURN_IMAGE_UPLOAD_TTL } from "./turn-images.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=", "base64");
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeTempDir(root); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "murage-turn-images-")); roots.push(root); mkdirSync(join(root, "attachments"));
  const messages = new Map<string, Message[]>();
  const store = { bots: [{ id: "a", threadId: "t", tasks: [{ threadId: "task" }] }, { id: "b", threadId: "u" }],
    groups: [{ threadId: "r", memberIds: ["a"], tasks: [{ threadId: "goal" }] }],
    messagesFor: (thread: string) => messages.get(thread) ?? [],
  } as unknown as Store;
  let now = 0;
  const images = new TurnImages(store, root, () => now);
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
it("refuses linked files, MIME masquerading and per-image/count/aggregate overflow", async () => {
  const f = fixture();
  const link = join(f.root, "attachments", `${randomUUID()}.png`), target = f.file(); symlinkSync(target.path, link);
  f.append("t", { attachments: [{ kind: "image", path: link, mime: "image/png" }] });
  await expect(f.images.read("t", "a", f.text(link))).rejects.toThrow("Reattach");
  const invalid = f.file(Buffer.from("not an image")); f.append("t", { attachments: [{ kind: "image", ...invalid }] });
  await expect(f.images.read("t", "a", f.text(invalid.path))).rejects.toThrow("valid PNG");
  const large = f.file(); truncateSync(large.path, 10 * 1024 * 1024 + 1); f.append("t", { attachments: [{ kind: "image", ...large }] });
  await expect(f.images.read("t", "a", f.text(large.path))).rejects.toThrow("20 MB");
  await expect(f.images.read("t", "a", Array.from({ length: 5 }, () => f.text(f.file().path)).join("\n"))).rejects.toThrow("four");
  const many = Array.from({ length: 3 }, () => { const saved = f.file(Buffer.concat([png, Buffer.alloc(7 * 1024 * 1024)])); f.append("t", { attachments: [{ kind: "image", ...saved }] }); return saved; });
  await expect(f.images.read("t", "a", many.map(item => f.text(item.path)).join("\n"))).rejects.toThrow("20 MB");
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
  expect(await f.images.collect("t", "a", f.text(unbound.path))).toEqual({ images: [], unbound: [unbound.path] });
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
  expect(await f.images.collect("u", "b", f.text(real.path))).toEqual({ images: [], unbound: [real.path] });
  await expect(f.images.read("u", "b", f.text(real.path))).rejects.toThrow("Reattach");
  // A thread that is nobody's is not an audience at all, bound or not.
  await expect(f.images.collect("missing", "a", f.text(real.path))).rejects.toThrow("Reattach");
  // Five tags, bound or not, is over the per-turn count before anything is read.
  await expect(f.images.collect("t", "a", Array.from({ length: 5 }, () => f.text(f.file().path)).join("\n"))).rejects.toThrow("four");
});
