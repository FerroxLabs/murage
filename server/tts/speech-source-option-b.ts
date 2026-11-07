import { findSecretLabels } from "../../shared/md-secret-label.mjs";
import { withoutSpeechDestinations } from "./speech-source-grammar.ts";

export const MAX_SOURCE_BYTES = 256 * 1024;

/** Inspect raw text; grammar recognition only exempts destinations from percent checks. */
export function optionBCut(source: string): boolean {
  if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) return true;
  if (/<[A-Za-z/!?]|&#|&[A-Za-z\d]+;|&(?:amp|lt|gt|quot|apos|nbsp)/.test(source)) return true;
  if (/%[\da-fA-F]{2}/.test(source) && /%[\da-fA-F]{2}/.test(withoutSpeechDestinations(source))) return true;
  return findSecretLabels(collapseOptionB(source)).length > 0;
}

/** Keep fence info/bodies and cells; supply the missing label/value separator.
 * A separator row is optional. A newline after `<` is handled by this label
 * scan, not the tag trigger. Plain `a < b` retains the head unsafe-span cut.
 */
export function collapseOptionB(source: string): string {
  return source.split("\n").map(line => {
    if (line.includes("|") && line.includes("---") && /^[\s:|-]+$/.test(line)) return " ";
    return line.replace(/^\s*\||\|\s*$/g, " ").replace(/\|/g, " : ");
  }).join(" ").replace(/`{3,}|~{3,}/g, " ").replace(/\s+/g, " ");
}

