/** True mime per capture format; a webp frame must never be labelled png. */
const PREVIEW_MIME: Record<string, string> = {
  jpeg: "image/jpeg", jpg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif",
};
function mimeForFormat(format: string): string {
  const key = format.toLowerCase();
  return PREVIEW_MIME[key] ?? (/^[a-z0-9.+-]{2,16}$/.test(key) ? `image/${key}` : "image/png");
}
export type PrivateScreenFrame = { png: string; mime: string };

/** Capture a preview only while nobody holds the human-control lease. The
 * second check matters for remote captures: a user can take over while the
 * screenshot request is in flight, and that result may already contain what
 * they started typing. */
export async function captureOutsideHumanControl(
  control: () => { held: boolean; revision: number },
  capture: () => Promise<{ png: string; format: string }>,
): Promise<PrivateScreenFrame | null> {
  const before = control();
  if (before.held) return null;
  const { png, format } = await capture();
  const after = control();
  // Checking only `held` has a take→type→release race: a slow remote
  // screenshot can finish after the lease is already false again. Any control
  // transition during the request makes that frame private and disposable.
  if (after.held || after.revision !== before.revision) return null;
  return { png, mime: mimeForFormat(format) };
}
