// The "Type the code" screen's decisions, apart from the DOM so they can be
// tested in Node: how a computer's address is named for display, how typed or
// pasted text becomes six digits, and when a pairing attempt is made.

export const CODE_LENGTH = 6;

function hostOf(address: string): string {
  const host = address.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?#]/)[0] ?? "";
  return host.replace(/^.*@/, "").replace(/:\d*$/, "");
}

/**
 * What the Computer row shows. The saved name when there is one. Otherwise an
 * IP address in full ("192.168.0.10"), a MagicDNS name with its tailnet so two
 * tailnets tell apart ("desktop (tailAAAA)"), and anything shorter as typed.
 */
export function displayName(address: string, savedName?: string): string {
  const saved = savedName?.trim();
  if (saved) return saved;
  const host = hostOf(address);
  if (/^[\d.]+$/.test(host) || host.includes(":") || host.startsWith("[")) return host;
  const labels = host.split(".");
  if (labels.length >= 3 && labels[0] && labels[1]) return `${labels[0]} (${labels[1]})`;
  return host;
}

export interface ParsedCode {
  /** At most six digits, what the boxes show and what Connect receives. */
  digits: string;
  /** True when the text is unmistakably one code, so it may connect by itself. */
  auto: boolean;
}

/**
 * Typed or pasted text to a code. A run of exactly six digits wins ("Device 2:
 * 123456", "Code: 123456"). Otherwise all the digits are joined ("123 456",
 * "123-456"); more than six that way is ambiguous, so the first six are shown
 * and nothing connects until the person presses Go.
 */
export function parseCode(raw: string): ParsedCode {
  const run = /(?<!\d)\d{6}(?!\d)/.exec(raw);
  if (run) return { digits: run[0], auto: true };
  const all = raw.replace(/\D/g, "");
  return { digits: all.slice(0, CODE_LENGTH), auto: all.length === CODE_LENGTH };
}

/** Typed or pasted text reduced to the digits the boxes show (see parseCode). */
export function codeDigits(raw: string): string {
  return parseCode(raw).digits;
}

export interface CodeEntry {
  /** New text from the code input; returns the digits the input should now hold. */
  input(raw: string): string;
  /** The address field was edited: re-arms, never connects by itself. */
  addressChanged(): void;
  /** Go, Return or the Connect button: one attempt per code. */
  enter(): void;
  readonly digits: string;
}

/**
 * One pairing attempt per code. Auto-connect (a clean sixth digit), Go/Return
 * and the Connect button share one `fired` flag. Editing the code to fewer
 * than six digits, or editing the address, re-arms it; an address edit alone
 * never connects, so a changed address is only tried when the person presses
 * Connect (or re-enters the code).
 * `hasAddress` is asked as the sixth digit lands: with no address typed yet
 * the digits wait for Connect.
 */
export function createCodeEntry(hasAddress: () => boolean, connect: (digits: string) => void): CodeEntry {
  let digits = "";
  let fired = false;
  const fire = () => {
    if (fired) return;
    fired = true;
    connect(digits);
  };
  return {
    get digits() {
      return digits;
    },
    input(raw) {
      const parsed = parseCode(raw);
      digits = parsed.digits;
      if (digits.length < CODE_LENGTH) fired = false;
      else if (parsed.auto && hasAddress()) fire();
      return digits;
    },
    addressChanged() {
      fired = false;
    },
    enter: fire,
  };
}
