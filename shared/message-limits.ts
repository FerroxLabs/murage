// How much one chat message may carry.
//
// ONE BOUND, READ ON BOTH SIDES. The composer checks it before a send leaves
// the renderer, and every harness route that accepts a person's message
// checks it again after parsing. Before this file the only bound was the
// harness's generic 1,000,000-byte JSON body limit: a larger message came
// back as `413 body too large`, the store flashed that for six seconds, put
// the text back in the box, and the person saw nothing happen at all.

/** The most text one message may carry, in UTF-8 bytes (1 MB). Measured on
 * the raw text rather than its JSON spelling, so the size a person is told is
 * the size of what they wrote. */
export const MESSAGE_TEXT_MAX_BYTES = 1024 * 1024;

/** Room for everything a send carries besides its text: ids, the reply
 * target, the room mode, and the JSON punctuation around them. */
export const MESSAGE_REQUEST_ENVELOPE_BYTES = 64 * 1024;

/** The JSON body bound for a route that carries one message. JSON may spell
 * one byte of text in up to six (`\u0001`), so the body bound admits every
 * text within MESSAGE_TEXT_MAX_BYTES however it is escaped; the text limit
 * itself is enforced after parsing. Same shape as the workspace editor's
 * WORKSPACE_WRITE_BODY_MAX_BYTES. */
export const MESSAGE_REQUEST_MAX_BYTES = 6 * MESSAGE_TEXT_MAX_BYTES + MESSAGE_REQUEST_ENVELOPE_BYTES;

/** The stable code a size refusal carries, next to its readable `error`. */
export const MESSAGE_TOO_LARGE_CODE = "message-too-large";

const KIB = 1024;
const MIB = 1024 * 1024;

/** UTF-8 byte length without allocating a copy of a multi-megabyte string.
 * A lone surrogate counts three bytes, which is what TextEncoder and
 * Buffer.byteLength both substitute for it. */
export function messageTextBytes(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
  }
  return bytes;
}

/** Whether a message is over the limit. The length checks answer the common
 * cases without walking the string: a UTF-16 unit is at least one byte and
 * at most three. */
export function messageIsTooLarge(text: string): boolean {
  if (text.length > MESSAGE_TEXT_MAX_BYTES) return true;
  if (text.length * 3 <= MESSAGE_TEXT_MAX_BYTES) return false;
  return messageTextBytes(text) > MESSAGE_TEXT_MAX_BYTES;
}

function unitLabel(value: number, unit: string, round: (n: number) => number): string {
  const tenths = round(value * 10) / 10;
  return `${Number.isInteger(tenths) ? tenths : tenths.toFixed(1)} ${unit}`;
}

/** "512 B", "38 KB", "1 MB", "4.2 MB" — a size in the words a person uses. */
export function formatMessageSize(bytes: number, round: (n: number) => number = Math.round): string {
  if (bytes < KIB) return `${bytes} B`;
  if (bytes < MIB) return unitLabel(bytes / KIB, "KB", round);
  return unitLabel(bytes / MIB, "MB", round);
}

/** The two sizes a refusal states. A message over the limit must never read
 * as the same size as the limit ("1 MB, and the limit is 1 MB"), so when
 * ordinary rounding would say that, the size is rounded up instead. */
export function messageSizeLabels(sizeBytes: number): { size: string; limit: string } {
  const limit = formatMessageSize(MESSAGE_TEXT_MAX_BYTES);
  let size = formatMessageSize(sizeBytes);
  if (sizeBytes > MESSAGE_TEXT_MAX_BYTES && size === limit) size = formatMessageSize(sizeBytes, Math.ceil);
  return { size, limit };
}

export interface MessageTooLargeRefusal {
  error: string;
  code: typeof MESSAGE_TOO_LARGE_CODE;
  sizeBytes: number;
  limitBytes: number;
}

/** The harness's answer to an over-limit message, or null when it fits. The
 * `error` sentence is read raw by clients that do not know the code. */
export function messageTooLargeRefusal(text: string): MessageTooLargeRefusal | null {
  if (!messageIsTooLarge(text)) return null;
  const sizeBytes = messageTextBytes(text);
  const { size, limit } = messageSizeLabels(sizeBytes);
  return {
    error: `This message is ${size}, and one message can be up to ${limit}. Shorten it or split it into smaller messages.`,
    code: MESSAGE_TOO_LARGE_CODE,
    sizeBytes,
    limitBytes: MESSAGE_TEXT_MAX_BYTES,
  };
}

/** A send the harness refused for its size: the message check above, or the
 * body bound in front of it. Both answer 413. */
export function isMessageSizeRefusal(error: unknown): boolean {
  return (error as { status?: unknown } | null | undefined)?.status === 413;
}
