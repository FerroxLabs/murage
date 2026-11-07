// SPDX-License-Identifier: AGPL-3.0-or-later
// CHROME-PANEL-AVATAR: the side panel's bot card gets the bound bot's own picture as a small data URL.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createPanelAvatars, isPanelAvatar, loadPanelAvatarEncode, PANEL_AVATAR_ENCODE_MS, PANEL_AVATAR_JOBS, PANEL_AVATAR_MAX_CHARS, PANEL_AVATAR_QUEUE, PANEL_AVATAR_RECHECK_MS, PANEL_AVATAR_SIDE, panelAvatarId, type PanelAvatarEncode } from "./browser-extension-panel-avatar.ts";

import { sharpPanelAvatar } from "./browser-extension-panel-avatar-encoder.ts";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const WEBP = Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1");
const fakeEncode = (out: Buffer | null = WEBP): (() => Promise<PanelAvatarEncode>) => async () => async () => out;

// A stored picture the tests can change: its bytes, removal marker, and a disk that fails for a while.
const disk = (bytes: Buffer | null = PNG) => {
  const d = { bytes, removed: false, fail: false, stamp: 1, probes: 0, reads: 0 };
  return Object.assign(d, {
    probe: async () => { d.probes++; return d.fail ? { state: "error" as const } : d.removed || !d.bytes ? { state: "removed" as const } : { state: "ok" as const, stamp: String(d.stamp) }; },
    read: async () => { d.reads++; return d.fail ? { state: "error" as const } : d.removed || !d.bytes ? { state: "gone" as const } : { state: "ok" as const, bytes: d.bytes, version: d.bytes.toString("hex") }; },
  });
};
const URL_OF = (out: Buffer) => `data:image/webp;base64,${out.toString("base64")}`;
// An encoder whose output names its input, so a new picture is a new data URL.
const echoEncode = (): (() => Promise<PanelAvatarEncode>) => async () => async bytes => Buffer.concat([WEBP, bytes]);

describe("panel avatars", () => {
  it("T2: cold reads await production and changed versions invalidate", async () => {
    const d=disk(); const a=createPanelAvatars({probe:d.probe,read:d.read,encode:echoEncode()});
    const bot={avatarUrl:"/api/attachments/a.png",avatarCrop:"circle"};
    const first=await a.get(bot); expect(first).toMatchObject({kind:"picture"});
    d.bytes=Buffer.concat([PNG,Buffer.from("new")]);d.stamp++;
    const second=await a.get(bot);expect(second).toMatchObject({kind:"picture"});expect(second).not.toEqual(first);
    d.removed=true;expect(await a.get(bot)).toEqual({kind:"none"});
    d.removed=false;d.fail=true;expect(await a.get(bot)).toEqual({kind:"unknown"});
    d.fail=false;expect(await a.get(bot)).toMatchObject({kind:"picture"});
  });
  it("T2: encoder exceptions are retryable, undecodable bytes are cached",async()=>{
    const d=disk();let calls=0;const a=createPanelAvatars({probe:d.probe,read:d.read,encode:async()=>async()=>{if(++calls===1)throw Error("encoder");return WEBP;}});
    const bot={avatarUrl:"/api/attachments/a.png",avatarCrop:"circle"};
    expect(await a.get(bot)).toEqual({kind:"unknown"});expect(await a.get(bot)).toMatchObject({kind:"picture"});expect(calls).toBe(2);
    const b=createPanelAvatars({probe:d.probe,read:d.read,encode:fakeEncode(null)});expect(await b.get(bot)).toEqual({kind:"none"});
  });
  it("only a base64 WebP, PNG or JPEG data URL within the cap passes", () => {
    expect(isPanelAvatar("data:image/webp;base64,AAAA")).toBe(true);
    for (const bad of [undefined, 5, "", "/api/attachments/a.png", "data:image/svg+xml;base64,AAAA", "data:image/png,<svg>", "data:image/png;base64,AA AA", "javascript:alert(1)", `data:image/png;base64,${"A".repeat(PANEL_AVATAR_MAX_CHARS)}`]) expect(isPanelAvatar(bad)).toBe(false);
  });
  it("the resizer refuses bytes whose format sharp does not confirm, and more than one frame", async () => {
    const fake = (meta: object) => sharpPanelAvatar((() => ({ metadata: async () => meta, rotate() { return this; }, resize() { return this; }, webp() { return this; }, toBuffer: async () => WEBP })) as never);
    expect(await fake({ format: "png", width: 10, height: 10 })(PNG, 72)).toBe(WEBP);
    expect(await fake({ format: "svg", width: 10, height: 10 })(PNG, 72)).toBeNull();
    expect(await fake({ format: "png", width: 10, height: 10, pages: 3 })(PNG, 72)).toBeNull();
    expect(await fake({ format: "png", width: 10, height: 10 })(Buffer.from("<svg/>"), 72)).toBeNull();
  });
  it("with the real resizer, a large detailed picture becomes a 72 px WebP well inside the cap", async () => {
    const sharp = createRequire(fileURLToPath(import.meta.resolve("@huggingface/transformers")))("sharp");
    const side = 1024; const raw = Buffer.alloc(side * side * 3); for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) >>> 24;
    const png: Buffer = await sharp(raw, { raw: { width: side, height: side, channels: 3 } }).png().toBuffer();
    const encode = await loadPanelAvatarEncode(); expect(encode).not.toBeNull();
    const avatars = createPanelAvatars({ probe: async () => ({ state: "ok", stamp: "1" }), read: async () => ({ state: "ok", bytes: png, version: "v" }), encode: async () => encode });
    const bot = { avatarUrl: "/api/attachments/noisy.png", avatarCrop: "circle" };
    await avatars.warm(bot);
    const result = await avatars.get(bot); expect(result).toMatchObject({ kind: "picture" }); if (result.kind !== "picture") throw Error("missing picture"); const url = result.dataUrl; expect(isPanelAvatar(url)).toBe(true); expect(url.length).toBeLessThanOrEqual(PANEL_AVATAR_MAX_CHARS);
    const meta = await sharp(Buffer.from(url.split(",")[1], "base64")).metadata();
    expect(meta).toMatchObject({ format: "webp", width: PANEL_AVATAR_SIDE, height: PANEL_AVATAR_SIDE });
  });
});

afterEach(()=>{vi.useRealTimers();loadPanelAvatarEncode.recycle?.();});
it("T19b: encoder deadline recycles and frees the slot; late output is never cached",async()=>{
 vi.useFakeTimers();const d=disk();let resolve!: (v:Buffer)=>void;let calls=0;
 const encode=Object.assign(async()=>async()=>{if(++calls===1)return new Promise<Buffer>(r=>{resolve=r;});return WEBP;},{recycle:vi.fn()});
 const avatars=createPanelAvatars({probe:d.probe,read:d.read,encode});const bot={avatarUrl:"/api/attachments/a.png",avatarCrop:"circle"};
 const first=avatars.get(bot);await vi.advanceTimersByTimeAsync(PANEL_AVATAR_ENCODE_MS ?? 20_000);expect(await first).toEqual({kind:"unknown"});expect(encode.recycle).toHaveBeenCalledTimes(1);
 expect(await avatars.get({...bot,avatarUrl:"/api/attachments/b.png"})).toMatchObject({kind:"picture"});resolve(Buffer.from("late"));await Promise.resolve();expect(await avatars.get(bot)).toMatchObject({kind:"picture",dataUrl:URL_OF(WEBP)});expect(calls).toBe(3);
});
it("T2: mascot, missing image and GIF never send a picture",async()=>{const d=disk();const a=createPanelAvatars({probe:d.probe,read:d.read,encode:fakeEncode()});for(const bot of [{},{avatarUrl:"/api/attachments/a.png",avatarCrop:"mascot"},{avatarUrl:"https://example.com/a.png"}])expect(await a.get(bot)).toEqual({kind:"none"});expect(d.reads).toBe(0);});
it('I9: an age-expired same-stamp hit is served while refreshing its content version',async()=>{
 let now=0;const d=disk();const a=createPanelAvatars({probe:d.probe,read:d.read,encode:echoEncode(),now:()=>now});const bot={avatarUrl:'/api/attachments/a.png',avatarCrop:'circle'};
 const first=await a.get(bot);expect(first).toMatchObject({kind:'picture'});if(first.kind!=='picture')throw Error('missing');expect(first.id).toBe(panelAvatarId(first.dataUrl));
 d.bytes=Buffer.concat([PNG,Buffer.from('change')]);now=PANEL_AVATAR_RECHECK_MS;
 expect(await a.get(bot)).toEqual(first);await a.warm(bot);expect(await a.get(bot)).not.toEqual(first);
});
it('I9: queue overflow is unknown and retries after bounded production drains',async()=>{
 let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});const d=disk();const a=createPanelAvatars({probe:d.probe,read:d.read,encode:async()=>async()=>{await gate;return WEBP;}});
 const bots=Array.from({length:PANEL_AVATAR_JOBS+PANEL_AVATAR_QUEUE+1},(_,i)=>({avatarUrl:`/api/attachments/a${i}.png`,avatarCrop:'circle'}));
 const jobs=bots.map(bot=>a.get(bot));expect(await jobs.at(-1)).toEqual({kind:'unknown'});release();await Promise.all(jobs);expect(await a.get(bots.at(-1)!)).toMatchObject({kind:'picture'});
});

it('T2: missing files and GIF bytes produce none without caching decoder errors',async()=>{
 const d=disk(null);const encode=vi.fn(sharpPanelAvatar((()=>{throw Error('GIF must be refused before sharp');}) as never));
 const a=createPanelAvatars({probe:d.probe,read:d.read,encode:async()=>encode});const bot={avatarUrl:'/api/attachments/a.png',avatarCrop:'circle'};
 expect(await a.get(bot)).toEqual({kind:'none'});expect(encode).not.toHaveBeenCalled();
 d.bytes=Buffer.from('GIF89a');d.stamp++;expect(await a.get(bot)).toEqual({kind:'none'});expect(await a.get(bot)).toEqual({kind:'none'});expect(encode).toHaveBeenCalledTimes(1);
});
