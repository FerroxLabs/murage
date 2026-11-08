import { expect, it } from 'vitest';
import { localImageCost, localImageBudget, reserveLocalImage, queueImageDiscovery } from './local-image-budget';
import type { MediaAsset } from '../../shared/media-assets';
const asset = (width: number, frames = 1) => ({ width, height: 1, frameCount: frames, decodedBytes: width * frames * 4 }) as MediaAsset;
it('R31-BOUND validates exact inclusive decoded cost, frame count and checked multiplication', () => {
  for (const width of [4_000_000, 4_000_001, 24_000_000]) expect(localImageCost(asset(width))).toBe(width * 4);
  expect(localImageCost(asset(24_000_001))).toBeNull(); expect(localImageCost(asset(12_000_000, 2))).toBe(96_000_000);
  for (const malformed of [{}, { ...asset(1), frameCount: 0 }, { ...asset(1), decodedBytes: 5 }, asset(Number.MAX_SAFE_INTEGER, 2)]) expect(localImageCost(malformed as MediaAsset)).toBeNull();
});
it('R2-A1 counts duplicate surfaces separately and never exceeds 192 MB or 32 nodes', () => {
  const releases: Array<() => void> = [];
  try {
    for (let i = 0; i < 20; i++) { const release = reserveLocalImage(15_999_996); if (release) releases.push(release); expect(localImageBudget().bytes).toBeLessThanOrEqual(192_000_000); }
    expect(releases).toHaveLength(12); expect(reserveLocalImage(96_000_000)).toBeNull();
  } finally { for (const release of releases) { release(); release(); } }
  expect(localImageBudget().bytes).toBe(0);
  for (let i = 0; i < 32; i++) releases.push(reserveLocalImage(4)!);
  expect(reserveLocalImage(4)).toBeNull(); for (const release of releases) release(); expect(localImageBudget().count).toBe(0);
});
it('A13 admits at most 32 of 500 image discoveries and cancellation removes queued work', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let started = 0;
  const cancellations = Array.from({ length: 500 }, () => queueImageDiscovery(async () => { started++; await gate; }));
  expect(started).toBe(32); expect(localImageBudget().discoveries).toBe(32);
  cancellations.slice(32).forEach(cancel => cancel()); release();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(localImageBudget().discoveries).toBe(0); expect(started).toBe(32);
});
