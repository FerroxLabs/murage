// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
/**
 * The bot's picture for the Murage for Chrome side panel (CHROME-PANEL-AVATAR, 1.0.18).
 *
 * The side panel is a chrome-extension:// page. It cannot load /api/attachments (that needs the app's session, and the
 * extension holds no host permission), but its CSP sets no img-src, so a data: URL draws. The app makes a small square
 * WebP data URL, at most PANEL_AVATAR_MAX_CHARS characters, for the bound bot only, and names it with a short id. The
 * service sends a separate cosmetic operation after bind only when the extension does not hold that id yet, so a status costs a few bytes per binding, not the picture.
 *
 * The cache is keyed on the attachment's content version (readAttachment's size and digest). Before every reuse one async
 * look at the removal marker and the file's identity (size, inode, times) says the picture is still the same file: a
 * removed picture sends nothing at once, and a changed file is read again. Only "no picture" and "not decodable" for one
 * version are kept; a disk that cannot answer is never cached and is retried on the next ask. One picture is made at a
 * time, with a short queue; past it a request is refused and retried later. The mascot sends nothing: the panel keeps its
 * letter. GIF pictures stay letter-only for now (rasterFormat refuses GIF).
 */
import { fork, type ChildProcess } from "node:child_process";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";
import { createHash } from "node:crypto";
import { botAvatarProfile } from "../shared/bot-avatar.ts";

export const PANEL_AVATAR_MAX_CHARS = 16_384;
/** Twice the panel's 36 px circle, for sharp edges on a high-density screen. */
export const PANEL_AVATAR_SIDE = 72;
export const PANEL_AVATAR_MAKE_MS = 20_000;
/** Compatibility name; the deadline now covers the entire make. */
export const PANEL_AVATAR_ENCODE_MS = PANEL_AVATAR_MAKE_MS;
const CACHE_LIMIT = 32;
/** Pictures made at once, and how many more may wait. Past that a request is refused (not cached) and retried later. */
export const PANEL_AVATAR_JOBS = 1;
export const PANEL_AVATAR_QUEUE = 8;
/** How long the file identity alone vouches for a picture before the bytes are read and their version checked again. */
export const PANEL_AVATAR_RECHECK_MS = 60_000;
/** The bound on one look at the disk on the status path. */
export const PANEL_AVATAR_PROBE_MS = 1_000;
/** What the extension and the service accept: a base64 WebP, PNG or JPEG data URL, nothing else. */
export const PANEL_AVATAR_PATTERN = /^data:image\/(?:webp|png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;
export const isPanelAvatar = (value: unknown): value is string => typeof value === "string" && value.length <= PANEL_AVATAR_MAX_CHARS && PANEL_AVATAR_PATTERN.test(value);
/** The picture's id: 16 hex characters of its digest. */
export const PANEL_AVATAR_ID_PATTERN = /^[0-9a-f]{16}$/;
export const isPanelAvatarId = (value: unknown): value is string => typeof value === "string" && PANEL_AVATAR_ID_PATTERN.test(value);
export const panelAvatarId = (dataUrl: string) => createHash("sha256").update(dataUrl).digest("hex").slice(0, 16);

/** Square WebP bytes, loaded-decoder null for undecodable input, or unavailable (retryable). */
export type PanelAvatarEncode = (bytes: Buffer, side: number) => Promise<Buffer | null | "unavailable">;

/** One async look at the stored picture: removed (or no longer servable), the disk could not answer, or the file's identity. */
export type PanelAvatarProbe = { state: "removed" } | { state: "error" } | { state: "ok"; stamp: string };
/** The stored picture's bytes and their content version, or gone, or the disk could not answer. */
export type PanelAvatarRead = { state: "gone" } | { state: "error" } | { state: "ok"; bytes: Buffer; version: string };
export interface PanelAvatar { id: string; dataUrl: string }

export type PanelAvatarResult = ({ kind: "picture" } & PanelAvatar) | { kind: "none" } | { kind: "unknown" };
export interface PanelAvatars {
  /** The current stored picture; cold reads await production. Unknown I/O is never cached. Never rejects. */
  get(bot: { avatarUrl?: unknown; avatarCrop?: unknown }): Promise<PanelAvatarResult>;
  /** Make the bot's picture now (bounded by the caller). Never rejects. */
  warm(bot: { avatarUrl?: unknown; avatarCrop?: unknown }): Promise<void>;
}

type Entry = { stamp: string; version: string; checkedAt: number; value: PanelAvatar | null };

export type Token = { expired: boolean };
export interface PanelAvatarEncoder {
  encode(bytes: Buffer, side: number, token?: Token): Promise<Buffer | null | "unavailable">;
  recycle(): void;
}
/** Each instance owns its child and request ids; a late exit cannot retire its replacement. */
export function helperEncode(test?: { env?: Record<string, string>; onChild?: (child: ChildProcess) => void }): PanelAvatarEncoder {
  let child: ChildProcess | undefined;
  let sequence = 0;
  const pending = new Map<number, { resolve(value: Buffer | null | "unavailable"): void; reject(error: Error): void }>();
  const recycle = () => {
    const old = child; child = undefined;
    for (const request of pending.values()) request.reject(Error('avatar_encoder_recycled'));
    pending.clear(); old?.kill('SIGKILL');
  };
  return { recycle, async encode(bytes, side, token) {
    if (token?.expired) throw Error('avatar_expired');
    if (!child) {
      const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1', ...test?.env };
      for (const key of ['HOME', 'USERPROFILE', 'SystemRoot', 'TMPDIR']) if (process.env[key]) env[key] = process.env[key];
      const current = fork(SPAWNED_PROXIES.panelAvatarEncoder, [], { execArgv: ['--experimental-strip-types'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'advanced', env });
      child = current; current.stderr?.resume();
      current.on('message', (message: { id: number; out?: Buffer | null; unavailable?: boolean; error?: boolean }) => {
        if (child !== current) return;
        const request = pending.get(message.id); pending.delete(message.id);
        if (message.error) request?.reject(Error('avatar_encode_failed'));
        else request?.resolve(message.unavailable ? 'unavailable' : message.out ?? null);
        if (!pending.size) { current.unref(); current.channel?.unref(); }
      });
      current.on('error', () => { if (child === current) recycle(); });
      current.on('exit', () => { if (child === current) recycle(); });
      test?.onChild?.(current);
    }
    if (token?.expired) throw Error('avatar_expired');
    const current = child; current.ref(); current.channel?.ref();
    return new Promise((resolve, reject) => {
      const id = ++sequence; pending.set(id, { resolve, reject });
      current.send({ id, bytes, side }, error => { if (error && child === current) recycle(); });
    });
  } };
}
// Compatibility for existing module consumers; production owns an explicit encoder.
const defaultEncoder = helperEncode();
export const loadPanelAvatarEncode = Object.assign(async (): Promise<PanelAvatarEncode> => defaultEncoder.encode, { recycle: defaultEncoder.recycle });

type MakeOutcome = "cached" | "error";
export function createPanelAvatars(deps: {
  probe: (url: string, token?: Token) => Promise<PanelAvatarProbe>;
  read: (url: string, token?: Token) => Promise<PanelAvatarRead>;
  encoder?: PanelAvatarEncoder;
  encode?: (() => Promise<PanelAvatarEncode | null>) & { recycle?: () => void };
  now?: () => number;
}): PanelAvatars {
  const now = deps.now ?? Date.now;
  const done = new Map<string, Entry>();
  const pending = new Map<string, Promise<MakeOutcome>>();
  let running = 0; const waiting: (() => void)[] = [];
  const urlOf = (bot: { avatarUrl?: unknown; avatarCrop?: unknown }) => { const profile = botAvatarProfile(bot); return profile.avatarCrop === "mascot" ? undefined : profile.avatarUrl; };
  const keep = (url: string, entry: Entry) => { done.delete(url); done.set(url, entry); while (done.size > CACHE_LIMIT) done.delete(done.keys().next().value as string); };
  const probe = async (url: string, token: Token = { expired: false }): Promise<PanelAvatarProbe> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([deps.probe(url, token), new Promise<PanelAvatarProbe>(resolve => { timer = setTimeout(() => { token.expired = true; resolve({ state: "error" }); }, PANEL_AVATAR_PROBE_MS); timer.unref?.(); })]); }
    catch { return { state: "error" }; }
    finally { clearTimeout(timer); }
  };
  const slot = async (work: (token: Token) => Promise<MakeOutcome>): Promise<MakeOutcome> => {
    if (running >= PANEL_AVATAR_JOBS) await new Promise<void>(resolve => waiting.push(resolve));
    running++;
    const token: Token = { expired: false };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work(token).catch((): MakeOutcome => "error"), new Promise<MakeOutcome>(resolve => {
        timer = setTimeout(() => { token.expired = true; (deps.encoder?.recycle ?? deps.encode?.recycle)?.(); resolve("error"); }, PANEL_AVATAR_MAKE_MS); timer.unref?.();
      })]);
    } finally { clearTimeout(timer); running--; waiting.shift()?.(); }
  };
  const encodeOf = async (bytes: Buffer, token: Token): Promise<PanelAvatar | null | "retry"> => {
    if (token.expired) return "retry";
    const encode = deps.encoder ? (bytes: Buffer, side: number) => deps.encoder!.encode(bytes, side, token) : await deps.encode?.();
    if (token.expired || !encode) return "retry";
    let out: Buffer | null | "unavailable";
    if (token.expired) return "retry";
    try { out = await encode(bytes, PANEL_AVATAR_SIDE); } catch { return "retry"; }
    if (token.expired) return "retry";
    if (out === "unavailable") return "retry";
    if (!out) return null;
    const dataUrl = `data:image/webp;base64,${out.toString("base64")}`;
    return isPanelAvatar(dataUrl) ? { id: panelAvatarId(dataUrl), dataUrl } : null;
  };
  const make = async (url: string, token: Token): Promise<MakeOutcome> => {
    if (token.expired) return "error";
    const seen = await deps.probe(url, token);
    if (token.expired) return "error";
    if (seen.state === "removed") { if (token.expired) return "error"; done.delete(url); return "cached"; }
    if (seen.state === "error") return "error";
    const read = await deps.read(url, token).catch((): PanelAvatarRead => ({ state: "error" }));
    if (token.expired) return "error";
    if (read.state === "gone") { if (token.expired) return "error"; done.delete(url); return "cached"; }
    if (read.state === "error") return "error";
    const before = done.get(url);
    if (before && before.version === read.version) { if (token.expired) return "error"; keep(url, { ...before, stamp: seen.stamp, checkedAt: now() }); return "cached"; }
    const value = await encodeOf(read.bytes, token);
    if (value === "retry" || token.expired) return "error";
    keep(url, { stamp: seen.stamp, version: read.version, checkedAt: now(), value }); return "cached";
  };
  const warm = (bot: { avatarUrl?: unknown; avatarCrop?: unknown }): Promise<MakeOutcome> => {
    const url = urlOf(bot); if (!url) return Promise.resolve("cached");
    let job = pending.get(url);
    if (!job) {
      if (pending.size >= PANEL_AVATAR_JOBS + PANEL_AVATAR_QUEUE) return Promise.resolve("error");
      job = slot(token => make(url, token)).finally(() => { pending.delete(url); }); pending.set(url, job);
    }
    return job;
  };
  return {
    async get(bot) {
      try {
        const url = urlOf(bot); if (!url) return { kind: "none" };
        let entry = done.get(url);
        if (entry) {
          const seen = await probe(url);
          if (seen.state === "removed") { done.delete(url); return { kind: "none" }; }
          if (seen.state === "error") return { kind: "unknown" };
          if (entry.stamp !== seen.stamp) entry = undefined;
        }
        if (!entry) {
          if (await warm(bot) === "error") return { kind: "unknown" };
          entry = done.get(url);
          if (!entry) return { kind: "none" };
        } else if (now() - entry.checkedAt >= PANEL_AVATAR_RECHECK_MS) void warm(bot);
        return entry.value ? { kind: "picture", ...entry.value } : { kind: "none" };
      } catch { return { kind: "unknown" }; }
    },
    async warm(bot) { try { await warm(bot); } catch { /* never rejects */ } },
  };
}
