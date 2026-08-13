import { createHash } from "node:crypto";

/** Provider-neutral policy for deciding when a computer observation needs vision. */
export interface ObservationMetrics {
  screenshotsCaptured: number;
  screenshotsSentToModel: number;
  fullScreenObservations: number;
  croppedObservations: number;
  structuredBrowserObservations: number;
  computerActions: number;
  retries: number;
  verificationSuccesses: number;
  verificationFailures: number;
}

export interface CropRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserTarget {
  id: string;
  title: string;
  url: string;
}

export const emptyObservationMetrics = (): ObservationMetrics => ({
  screenshotsCaptured: 0,
  screenshotsSentToModel: 0,
  fullScreenObservations: 0,
  croppedObservations: 0,
  structuredBrowserObservations: 0,
  computerActions: 0,
  retries: 0,
  verificationSuccesses: 0,
  verificationFailures: 0,
});

export function normalizeCrop(raw: unknown, maxWidth = 1280): CropRegion | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const x = Math.round(Number(value.x));
  const y = Math.round(Number(value.y));
  const width = Math.round(Number(value.width));
  const height = Math.round(Number(value.height));
  if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width < 32 || height < 32) return null;
  if (x + width > maxWidth || height > 4_000) return null;
  return { x, y, width, height };
}

/** Removes query/fragment data before browser state reaches a model or log. */
export function safeBrowserUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return null;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

/** Parses Chrome's /json/list response into a small, safe structured observation. */
export function parseBrowserTargets(raw: string): BrowserTarget[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const value = item as Record<string, unknown>;
      const url = safeBrowserUrl(value.url);
      if (value.type !== "page" || !url || typeof value.id !== "string") return [];
      const title = typeof value.title === "string" ? value.title.replace(/\s+/g, " ").trim().slice(0, 200) : "";
      return [{ id: value.id.slice(0, 100), title, url }];
    });
  } catch {
    return [];
  }
}

/**
 * Keeps observations cheap without claiming the screen is immutable: an action
 * marks the frame dirty; the next screenshot captures once, hashes pixels, and
 * only returns an image if the pixels changed. Repeated reads without an action
 * reuse the verified observation instead of capturing/sending another image.
 */
export class ObservationCoordinator {
  metrics = emptyObservationMetrics();
  private lastHash: string | null = null;
  private dirty = true;

  noteAction() {
    this.metrics.computerActions += 1;
    this.dirty = true;
  }

  noteRetry() {
    this.metrics.retries += 1;
  }

  needsCapture(force = false) {
    return force || this.dirty || this.lastHash === null;
  }

  observeFrame(base64: string, crop: CropRegion | null) {
    this.metrics.screenshotsCaptured += 1;
    const hash = createHash("sha256").update(base64).digest("hex");
    const changed = hash !== this.lastHash;
    this.lastHash = hash;
    this.dirty = false;
    if (changed) {
      this.metrics.screenshotsSentToModel += 1;
      if (crop) this.metrics.croppedObservations += 1;
      else this.metrics.fullScreenObservations += 1;
    }
    return { changed, hash };
  }

  noteStructuredObservation() {
    this.metrics.structuredBrowserObservations += 1;
  }

  noteVerification(ok: boolean) {
    if (ok) this.metrics.verificationSuccesses += 1;
    else this.metrics.verificationFailures += 1;
  }
}
