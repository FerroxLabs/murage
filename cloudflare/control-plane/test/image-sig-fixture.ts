// SPDX-License-Identifier: AGPL-3.0-or-later
// Signed-image test fixture. The key pair is generated here, in the test process, and exists only for it; no real key or custody file is read.
// Timestamps sit at the epoch so the suites' tiny injected clocks (now: () => 5) are inside every signature window.
import { b64urlEncode, buildPayload } from "../scripts/image-sig.mjs";
import { env } from "cloudflare:workers";
import { verifyImageForUse, type ImageTrust, type VerifiedImage, type VerifyDeps } from "../src/image-signature";
import { createLiveProvider as createLiveProviderRaw, type HostFetch, type LiveDeps } from "../src/b5-provisioner";

export const CHECK_SHA = "c".repeat(64);
export const CREATED = "1970-01-01T00:00:00Z";
export const VERIFIED_AT = "19700101T000000Z";
export const SIZE = "2.84";

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
const b64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b)));

export interface TestKey { priv: CryptoKey; spkiB64: string; fp: string }
export async function makeKey(): Promise<TestKey> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
  return { priv: pair.privateKey, spkiB64: b64(spki), fp: hex(await crypto.subtle.digest("SHA-256", spki)) };
}

export interface EntryFields { imageId: string; createdAt?: string; imageSize?: string; env?: "staging" | "prod"; checkSha256?: string; verifiedAt?: string }
/** A signed customer entry. WebCrypto signs to the raw r||s form, which is the stored form. */
export async function signEntry(key: TestKey, f: EntryFields) {
  const e = { imageId: f.imageId, createdAt: f.createdAt ?? CREATED, imageSize: f.imageSize ?? SIZE, env: f.env ?? "prod",
    checkSha256: f.checkSha256 ?? CHECK_SHA, verifiedAt: f.verifiedAt ?? VERIFIED_AT };
  const bytes = new TextEncoder().encode(buildPayload({ ...e, verdict: "pass" }));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.priv, bytes));
  return { kind: "customer", verifiedBy: "hz-live-rescue", checkVersion: "1", verifiedAt: e.verifiedAt, createdAt: e.createdAt, imageSize: e.imageSize,
    env: e.env, checkSha256: e.checkSha256, verdict: "pass", keyFp: key.fp, sig: b64urlEncode(sig) } as Record<string, unknown> & { sig: string; keyFp: string };
}

export const MAIN_KEY = await makeKey();
export const ARCH_OF: Record<string, "x86" | "arm"> = { "111": "x86", "222": "arm", "1": "x86", "333": "x86", "452016490": "x86", "451260442": "arm" };
export const IMG_KINDS: Record<string, Record<string, unknown>> = {
  "111": await signEntry(MAIN_KEY, { imageId: "111" }),
  "222": await signEntry(MAIN_KEY, { imageId: "222" }),
  "1": await signEntry(MAIN_KEY, { imageId: "1" }),
  "333": await signEntry(MAIN_KEY, { imageId: "333" }),
  // The staging-approved provider ids (APPROVED_provider_IMAGE_IDS), which the G3 gate in the live provider insists on.
  "452016490": await signEntry(MAIN_KEY, { imageId: "452016490" }),
  "451260442": await signEntry(MAIN_KEY, { imageId: "451260442" }),
};
export const PUBKEY = MAIN_KEY.spkiB64;
export const SIG_TRUST: ImageTrust = { fps: [MAIN_KEY.fp], checks: [CHECK_SHA], revoked: [], epoch: 1 };

/** provider's answer for GET /images/{id} for the fixture images. */
export const hzImage = (id: string, over: Record<string, unknown> = {}) => ({ image: { id: Number(id), type: "snapshot", status: "available", deleted: null,
  created: CREATED, image_size: Number(SIZE), architecture: ARCH_OF[id] ?? "x86", ...over } });

/** Wraps a fake cloud so the re-check's GET /images/{id} is answered for the fixture images; every other call goes to the fake. */
export function withImages(inner: HostFetch, over: (id: string) => Record<string, unknown> | Response | undefined = () => undefined): HostFetch {
  return async (url, init) => {
    const m = /^https:\/\/api\.hetzner\.cloud\/v1\/images\/(\d+)$/.exec(url);
    if (m && (init?.method ?? "GET") === "GET" && ARCH_OF[m[1]]) {
      const o = over(m[1]);
      if (o instanceof Response) return o;
      return new Response(JSON.stringify(hzImage(m[1], o)), { status: 200 });
    }
    return inner(url, init);
  };
}
export const SIG_DEPS = { trust: SIG_TRUST } as const;

/** The suites' tiny injected clocks (now: () => 5) sit inside every fixture signature window. */
export const SIG_NOW = 5;
/** createLiveProvider with the fixture's trust and a provider that answers the re-check for the fixture images. */
export function createLiveProvider(e: Env, deps: LiveDeps = {}) {
  return createLiveProviderRaw(e, { ...deps, fetch: withImages(deps.fetch ?? (fetch as HostFetch)), verify: { ...SIG_DEPS, ...deps.verify } });
}
/** A capability minted by the real gate for a fixture image (the adapters accept nothing else). Use with an adapter whose clock is SIG_NOW. */
export async function verifiedImage(image = "111", arch: "x86" | "arm" = "x86", now = SIG_NOW): Promise<VerifiedImage> {
  const e = { ...env, B5_IMAGE_VERIFY_PUBKEY: PUBKEY, HCLOUD_TOKEN: "hz-test-token" } as unknown as Env;
  return verifyImageForUse(e, { imageKinds: IMG_KINDS } as never, { provider: "hetzner", image, arch }, now,
    { fetch: withImages(async () => new Response("{}", { status: 500 })), trust: SIG_TRUST, buildEnv: "production" });
}

// ---- fixture set for suites whose clock sits at T0 (the warm-pool suites run at 1.8e12 ms) ---------------------------------------------------
export const T0 = 1_800_000_000_000;
const DAY_MS = 86_400_000;
const isoZ = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
export const T0_CREATED = isoZ(T0 - 10 * DAY_MS);
export const T0_VERIFIED = isoZ(T0 - 5 * DAY_MS).replace(/[-:]/g, "");
export const IMG_KINDS_T0: Record<string, Record<string, unknown>> = {
  "111": await signEntry(MAIN_KEY, { imageId: "111", createdAt: T0_CREATED, verifiedAt: T0_VERIFIED }),
  "222": await signEntry(MAIN_KEY, { imageId: "222", createdAt: T0_CREATED, verifiedAt: T0_VERIFIED }),
};
/** VerifyDeps for the grabber suites: fixture trust, and a provider that answers the re-check with the T0 images. */
export const GRAB_VERIFY: VerifyDeps = { trust: SIG_TRUST, fetch: withImages(async () => new Response("{}", { status: 500 }), () => ({ created: T0_CREATED })) };
/** The pool claim's per-arch check, as createLiveProvider wires it, for suites that call claimPoolServer directly. */
export const okArch = async () => true;
