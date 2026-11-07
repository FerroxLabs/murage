import type { MediaAsset } from '../../shared/media-assets';
export const LOCAL_IMAGE_MAX_DECODED_BYTES = 96_000_000;
export const LOCAL_IMAGE_INLINE_MAX_DECODED_BYTES = 16_000_000;
export const LOCAL_IMAGE_TOTAL_DECODED_BYTES = 192_000_000;
export const LOCAL_IMAGE_MAX_SURFACES = 32;
export function localImageCost(asset: MediaAsset): number | null {
  const { width, height, frameCount, decodedBytes } = asset;
  if (![width, height, frameCount, decodedBytes].every(n => typeof n === 'number' && Number.isSafeInteger(n) && n > 0)) return null;
  const cost = BigInt(width!) * BigInt(height!) * BigInt(frameCount!) * 4n;
  return cost <= BigInt(LOCAL_IMAGE_MAX_DECODED_BYTES) && cost === BigInt(decodedBytes!) ? Number(cost) : null;
}
let bytes = 0, count = 0, discoveries = 0;
const listeners = new Set<() => void>(), waiting: Array<() => void> = [];
export function reserveLocalImage(cost: number): (() => void) | null {
  if (!Number.isSafeInteger(cost) || cost <= 0 || cost > LOCAL_IMAGE_MAX_DECODED_BYTES || bytes + cost > LOCAL_IMAGE_TOTAL_DECODED_BYTES || count >= LOCAL_IMAGE_MAX_SURFACES) return null;
  bytes += cost; count++; let released = false;
  return () => { if (released) return; released = true; bytes -= cost; count--; queueMicrotask(() => { for (const listener of listeners) listener(); }); };
}
export function watchLocalImageBudget(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function queueImageDiscovery(work: () => Promise<void>): () => void {
  let canceled = false;
  const start = () => {
    if (canceled) return;
    discoveries++;
    void work().finally(() => { discoveries--; waiting.shift()?.(); });
  };
  if (discoveries < 32) start(); else waiting.push(start);
  return () => { canceled = true; const index = waiting.indexOf(start); if (index >= 0) waiting.splice(index, 1); };
}
let closeLightbox: (() => void) | undefined;
export function claimLocalImageLightbox(close: () => void): () => void {
  if (closeLightbox !== close) closeLightbox?.(); closeLightbox = close;
  return () => { if (closeLightbox === close) closeLightbox = undefined; };
}
export function localImageBudget() { return { bytes, count, discoveries, waiting: waiting.length }; }
