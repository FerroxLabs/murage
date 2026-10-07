// tools/flux-stream-conformance/wer.ts
export const normalizeWords = (s: string) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);

export function wer(reference: string, hypothesis: string): number {
  const r = normalizeWords(reference);
  const h = normalizeWords(hypothesis);
  if (!r.length) return h.length ? 1 : 0;
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j += 1) d[0][j] = j;
  for (let i = 1; i <= r.length; i += 1) {
    for (let j = 1; j <= h.length; j += 1) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
    }
  }
  return d[r.length][h.length] / r.length;
}

/** Accepted renderings of a backchannel reference (f09): ASR engines spell the same sound several ways. */
export const BACKCHANNEL_RENDERINGS = ["uh-huh", "uh huh", "aha", "mhm", "mm-hmm", "mm hmm"];

const isBackchannel = (reference: string): boolean => {
  const key = normalizeWords(reference).join(" ");
  return BACKCHANNEL_RENDERINGS.some((r) => normalizeWords(r).join(" ") === key);
};

/** wer(), except a backchannel reference scores the best of its accepted renderings. */
export function werAccepting(reference: string, hypothesis: string): number {
  if (!isBackchannel(reference)) return wer(reference, hypothesis);
  return Math.min(...BACKCHANNEL_RENDERINGS.map((r) => wer(r, hypothesis)));
}
