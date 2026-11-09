import { t } from "./i18n";
import { saveBlob, reportSaveFailure } from './save-file';
import { nativeAvailable } from './native-shell';
import type { LocalMediaResolution } from './media-resolve';
export const LOCAL_IMAGE_SAVE_DEADLINE_MS = 15_000;
export const LOCAL_IMAGE_ENCODED_MAX_BYTES = 26_214_400;
type Ready = Extract<LocalMediaResolution, { state: 'ready' }>;
export type LocalImageSaveResult = { state: 'saved' | 'busy' | 'disposed' | 'failed' | 'handoff-failed' } | { state: 'changed' | 'unavailable'; resolution: LocalMediaResolution };
let slot: symbol | undefined;
export function tryAcquireSaveSlot(): (() => void) | null {
  if (slot) return null;
  const token = Symbol(); slot = token;
  return () => { if (slot === token) slot = undefined; };
}
export function localImageSaveBusy(): boolean { return slot !== undefined; }
export function localImageByteUrl(url: string): boolean {
  try {
    const origin = globalThis.location?.origin ?? 'http://localhost';
    const parsed = new URL(url, origin);
    return parsed.origin === origin && /^\/api\/media\/bytes\/ma1_[A-Za-z0-9_-]{32}$/.test(parsed.pathname) && parsed.searchParams.getAll('cap').length === 1 && !!parsed.searchParams.get('cap') && !parsed.hash;
  } catch { return false; }
}
export function saveLocalImage(options: { shown: Ready; renew: () => Promise<LocalMediaResolution>; live: () => boolean; fetcher?: typeof fetch; handoff?: typeof saveBlob; native?: () => Promise<boolean>; report?: typeof reportSaveFailure }): { acquired: boolean; result: Promise<LocalImageSaveResult>; dispose: () => void } {
  const report = options.report ?? reportSaveFailure;
  let release = tryAcquireSaveSlot(), disposed = false, handingOff = false, cancelAttempt: (() => void) | undefined;
  const live = () => !disposed && options.live();
  const dispose = () => { disposed = true; cancelAttempt?.(); if (!handingOff) { release?.(); release = null; } };
  if (!release) { report(Object.assign(new Error(t('media.local.saveBusy')), { code: 'local-image-busy' })); return { acquired: false, result: Promise.resolve({ state: 'busy' }), dispose }; }
  const attempt = async (ready: Ready): Promise<Blob> => {
    const controller = new AbortController(); let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let chunks: Uint8Array<ArrayBuffer>[] = [], size = 0;
    let rejectStop!: (reason: Error) => void;
    const stopped = new Promise<never>((_, reject) => { rejectStop = reject; });
    const stop = () => { controller.abort(); void reader?.cancel().catch(() => {}); chunks = []; rejectStop(new Error('Picture transport stopped.')); };
    cancelAttempt = stop;
    const timer = setTimeout(stop, LOCAL_IMAGE_SAVE_DEADLINE_MS);
    const bounded = <T>(promise: Promise<T>) => Promise.race([promise, stopped]);
    try {
      const expected = ready.asset.bytes;
      if (!localImageByteUrl(ready.url) || !Number.isSafeInteger(expected) || expected! <= 0 || expected! > LOCAL_IMAGE_ENCODED_MAX_BYTES) throw Error('Invalid picture size.');
      const response = await bounded((options.fetcher ?? fetch)(ready.url, { signal: controller.signal, cache: 'no-store', referrerPolicy: 'no-referrer', redirect: 'error' }));
      const header = response.headers.get('content-length');
      if (!live() || !response.ok || response.redirected || !header || !/^\d+$/.test(header) || Number(header) !== expected || !response.body) throw Error('Picture download failed.');
      reader = response.body.getReader();
      while (true) {
        const next = await bounded(reader.read());
        if (!live()) throw Error('Picture action ended.');
        if (next.done) break;
        if (size + next.value.byteLength > expected! || size + next.value.byteLength > LOCAL_IMAGE_ENCODED_MAX_BYTES) throw Error('Invalid picture size.');
        size += next.value.byteLength; chunks.push(new Uint8Array(next.value));
      }
      if (size !== expected) throw Error('Incomplete picture download.');
      return new Blob(chunks, { type: ready.asset.mime });
    } finally {
      clearTimeout(timer); cancelAttempt = undefined; controller.abort();
      void reader?.cancel().catch(() => {}); try { reader?.releaseLock(); } catch { /* Pending read is already detached and observed. */ }
      chunks = [];
    }
  };
  const result = (async (): Promise<LocalImageSaveResult> => {
    let ready = options.shown, renewed = false, handedOff = false;
    const refresh = async (): Promise<LocalImageSaveResult | undefined> => {
      release?.(); release = null;
      const next = await options.renew(); renewed = true;
      if (!live()) return { state: 'disposed' };
      if (next.state !== 'ready') { report(new Error('Picture download failed.')); return { state: 'unavailable', resolution: next }; }
      if (next.asset.revision !== options.shown.asset.revision) return { state: 'changed', resolution: next };
      ready = next; release = tryAcquireSaveSlot();
      if (!release) { report(Object.assign(new Error(t('media.local.saveBusy')), { code: 'local-image-busy' })); return { state: 'busy' }; }
    };
    try {
      if (!live()) return { state: 'disposed' };
      if (ready.expiresAt === undefined || ready.expiresAt - Date.now() <= 15_000) { const result = await refresh(); if (result) return result; }
      let blob: Blob;
      try { blob = await attempt(ready); }
      catch {
        release?.(); release = null;
        if (!live()) return { state: 'disposed' };
        if (renewed) { report(new Error('Picture download failed.')); return { state: 'failed' }; }
        const result = await refresh(); if (result) return result;
        try { blob = await attempt(ready); }
        catch { if (!live()) return { state: 'disposed' }; report(new Error('Picture download failed.')); return { state: 'failed' }; }
      }
      if (!live()) return { state: 'disposed' };
      try {
        const native = await (options.native ?? (() => nativeAvailable('saveFile')))();
        if (!live()) return { state: 'disposed' };
        handingOff = true;
        await (options.handoff ?? saveBlob)(blob, ready.asset.name);
        if (!native) { const retained = release; release = null; handedOff = true; setTimeout(() => retained?.(), 60_000); }
        return { state: 'saved' };
      } catch { if (live()) report(new Error('Picture save failed.')); return { state: live() ? 'handoff-failed' : 'disposed' }; }
    } catch { if (live()) report(new Error('Picture download failed.')); return { state: live() ? 'failed' : 'disposed' }; } finally { if (!handedOff) release?.(); release = null; }
  })();
  return { acquired: true, result, dispose };
}
