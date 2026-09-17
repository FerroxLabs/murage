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
