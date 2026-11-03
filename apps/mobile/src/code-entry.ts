// The "Type the code" screen's decisions, apart from the DOM so they can be
// tested in Node: how a computer's address is named for display, how typed or
// pasted text becomes six digits, and when a pairing attempt is made.

export const CODE_LENGTH = 6;

function hostOf(address: string): string {
  const host = address.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?#]/)[0] ?? "";
  const bare = host.replace(/^.*@/, "");
  const bracketed = /^(\[[^\]]*\]):\d*$/.exec(bare);
  if (bracketed) return bracketed[1]!;
  // A bare IPv6 address has several colons and no port to strip.
  if (bare.split(":").length > 2) return bare;
  return bare.replace(/:\d*$/, "");
}

/** "https://Desk.tail1.ts.net:8443/" and "desk.tail1.ts.net" are the same place. */
function sameAddress(a: string, b: string): boolean {
  return hostOf(a).toLowerCase() === hostOf(b).toLowerCase() && hostOf(a) !== "";
}

export interface SavedForm {
  origin?: string;
  name?: string;
}

/**
 * The Computer row's text, or null when the address field should stay visible.
 * The row stands for the saved origin: after a redraw that carries a typed
 * address (`hasDraft`) it shows only if that address is still the origin, and
 * the saved name is used only when the address equals the saved origin.
 */
export function computerRow(address: string, form: SavedForm, hasDraft: boolean): string | null {
  if (address.trim() === "") return null;
  const isOrigin = form.origin !== undefined && sameAddress(address, form.origin);
  if (hasDraft && !isOrigin) return null;
  return displayName(address, isOrigin ? form.name : undefined);
}

/**
 * What the Computer row shows. The saved name when given. Otherwise an IP
 * address in full, a MagicDNS name (*.ts.net) as "name (tailnet)" so two
 * tailnets tell apart, and any other host in full.
 */
export function displayName(address: string, savedName?: string): string {
  const saved = savedName?.trim();
  if (saved) return saved;
  const host = hostOf(address);
  const labels = host.split(".");
  if (labels.length >= 3 && labels.slice(-2).join(".").toLowerCase() === "ts.net" && labels[0] && labels[1]) {
    return `${labels[0]} (${labels[1]})`;
  }
  return host;
}

export interface ParsedCode {
  /** At most six digits, what the boxes show and what Connect receives. */
  digits: string;
  /** True when the text is unmistakably one code, so it may connect by itself. */
  auto: boolean;
  /** True when the text held more than one possible code; wait for Go. */
  ambiguous: boolean;
}

/**
 * Typed or pasted text to a code. Exactly one run of six digits wins ("Device
 * 2: 123456"). Digits that join to exactly six ("123 456") are a code too.
 * Several six-digit runs, or more than six digits with no single clean run,
 * are ambiguous: the first candidate (or first six digits) is shown and
 * nothing connects until the person presses Go.
 */
export function parseCode(raw: string): ParsedCode {
  const runs = raw.match(/(?<!\d)\d{6}(?!\d)/g) ?? [];
  const all = raw.replace(/\D/g, "");
  if (runs.length === 1) return { digits: runs[0]!, auto: true, ambiguous: false };
  if (runs.length > 1) return { digits: runs[0]!, auto: false, ambiguous: true };
  return { digits: all.slice(0, CODE_LENGTH), auto: all.length === CODE_LENGTH, ambiguous: all.length > CODE_LENGTH };
}

/** Typed or pasted text reduced to the digits the boxes show (see parseCode). */
export function codeDigits(raw: string): string {
  return parseCode(raw).digits;
}

/** The box that carries the highlight: where the caret really is, 0 to 5. */
export function highlightIndex(caret: number | null, length: number): number {
  return Math.max(0, Math.min(caret ?? length, CODE_LENGTH - 1));
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
  // An ambiguous paste stays "needs Go" until the digits change.
  let confirm = false;
  const fire = () => {
    if (fired) return;
    fired = true;
    confirm = false;
    connect(digits);
  };
  return {
    get digits() {
      return digits;
    },
    input(raw) {
      const parsed = parseCode(raw);
      confirm = parsed.digits === digits ? confirm || parsed.ambiguous : parsed.ambiguous;
      digits = parsed.digits;
      if (digits.length < CODE_LENGTH) fired = false;
      else if (parsed.auto && !confirm && hasAddress()) fire();
      return digits;
    },
    addressChanged() {
      fired = false;
    },
    enter: fire,
  };
}
