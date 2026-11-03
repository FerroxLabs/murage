// The "Type the code" screen's decisions, apart from the DOM so they can be
// tested in Node: how a computer's address is shortened for display, how typed
// or pasted text becomes six digits, and when the sixth digit connects.

export const CODE_LENGTH = 6;

/** "https://example-mac.tailnet123.ts.net:8443/x" -> "example-mac". */
export function shortName(address: string): string {
  const host = address.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?#]/)[0] ?? "";
  const bare = host.replace(/^.*@/, "").replace(/:\d*$/, "");
  return bare.split(".")[0] ?? "";
}

/** Typed or pasted text reduced to its digits, at most six ("123 456" -> "123456"). */
export function codeDigits(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, CODE_LENGTH);
}

export interface CodeEntry {
  /** New text from the input; returns the digits the input should now hold. */
  input(raw: string): string;
  /** Return on the code field: connects whatever is there, as before. */
  enter(): void;
  readonly digits: string;
}

/**
 * `hasAddress` is asked at the moment the sixth digit lands: with no address
 * there is nothing to connect to, so the digits wait for Return.
 */
export function createCodeEntry(hasAddress: () => boolean, connect: () => void): CodeEntry {
  let digits = "";
  let fired = false;
  return {
    get digits() {
      return digits;
    },
    input(raw) {
      digits = codeDigits(raw);
      if (digits.length < CODE_LENGTH) fired = false;
      else if (!fired && hasAddress()) {
        fired = true;
        connect();
      }
      return digits;
    },
    enter() {
      connect();
    },
  };
}
