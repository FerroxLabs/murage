// SPDX-License-Identifier: AGPL-3.0-or-later
// What the Backups page says when backups while Murage is closed can't be set
// up because the app or its data folder is on a volume a background job can't
// read (electron/backup-closed-volume.mjs). Shared by the desktop and the page.
export const CLOSED_VOLUME_SENTENCES = Object.freeze({
  app: "Backups while Murage is closed need Murage in your Applications folder on this Mac's own disk. Move Murage there, then turn this on again.",
  data: "Backups while Murage is closed need Murage's data folder on this Mac's own disk, not on another drive. Move the data folder there, then turn this on again.",
  both: "Backups while Murage is closed need Murage in your Applications folder and its data folder on this Mac's own disk. Move both there, then turn this on again.",
});
/** The sentence for a status `blocked` value, or null. */
export function closedVolumeSentence(blocked) {
  return typeof blocked === "string" && blocked.startsWith("volume-") ? CLOSED_VOLUME_SENTENCES[blocked.slice(7)] ?? CLOSED_VOLUME_SENTENCES.app : null;
}
