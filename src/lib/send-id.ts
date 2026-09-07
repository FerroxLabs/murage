/** Message deduplication IDs must also work on a private HTTP browser door.
 * randomUUID requires a secure context; getRandomValues does not. Keep the
 * UUID v4 shape and strong randomness without depending on a clock or a
 * module-local counter (which would collide across tabs/reloads). Call once
 * per new send; retries retain the ID already stored with the draft. */
export function newSendId(): string {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  if (typeof crypto?.getRandomValues !== "function") {
    throw new Error("This browser cannot create message IDs. Open Murage in a supported browser.");
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
