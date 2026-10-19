// SPDX-License-Identifier: AGPL-3.0-or-later
// Cloud checkout WP9 r1-1 (Astra WP9-1 #1): the From field of an emailed withdrawal notice, parsed as a complete RFC 5322 address-list
// (RFC 6532 UTF-8 allowed): quoted strings, comments, angle addresses and groups. The display name is never read: a mailbox is only ever
// the addr-spec, so `"<pat@gmail.com>" <attacker@gmail.com>` is attacker@gmail.com, and two mailboxes in one header value are two.
// Anything the grammar does not allow (a stray `<`, `>` or `@` outside an address, an obsolete route, a domain literal, an unterminated
// quote or comment) makes the WHOLE field invalid: the sender is then never attributed (plan 5.3 (1): (5b)).

export interface ParsedFrom { valid: boolean; mailboxes: string[] }

const ATEXT = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~\-\u0080-\u{10FFFF}]+$/u;
const LABEL = /^[A-Za-z0-9\u0080-\u{10FFFF}](?:[A-Za-z0-9\-\u0080-\u{10FFFF}]*[A-Za-z0-9\u0080-\u{10FFFF}])?$/u;

class Bad extends Error {}

/** Splits one header value into top-level pieces on `sep` characters that are outside quotes, comments, angle brackets and domain literals,
 *  removing comments on the way. Unbalanced quoting throws. */
function scan(s: string): Array<{ text: string; sep: string | null }> {
  const out: Array<{ text: string; sep: string | null }> = [];
  let buf = ""; let i = 0; let angle = false;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") throw new Bad("bare_escape");
    if (c === '"') {
      let j = i + 1; let q = '"';
      for (; j < s.length && s[j] !== '"'; j += 1) { if (s[j] === "\\") { if (j + 1 >= s.length) throw new Bad("quote"); q += s[j] + s[j + 1]; j += 1; } else if (s[j] === "\r" || s[j] === "\n") throw new Bad("quote"); else q += s[j]; }
      if (j >= s.length) throw new Bad("quote");
      buf += `${q}"`; i = j + 1; continue;
    }
    if (c === "(") {
      let depth = 1; let j = i + 1;
      for (; j < s.length && depth > 0; j += 1) { if (s[j] === "\\") j += 1; else if (s[j] === "(") depth += 1; else if (s[j] === ")") depth -= 1; }
      if (depth !== 0) throw new Bad("comment");
      buf += " "; i = j; continue;
    }
    if (c === ")") throw new Bad("comment");
    if (c === "[") throw new Bad("domain_literal");
    if (c === "<") { if (angle) throw new Bad("angle"); angle = true; buf += c; i += 1; continue; }
    if (c === ">") { if (!angle) throw new Bad("angle"); angle = false; buf += c; i += 1; continue; }
    if (!angle && (c === "," || c === ":" || c === ";")) { out.push({ text: buf, sep: c }); buf = ""; i += 1; continue; }
    if (angle && (c === "," || c === ":" || c === ";")) throw new Bad("route");
    buf += c; i += 1;
  }
  if (angle) throw new Bad("angle");
  out.push({ text: buf, sep: null });
  return out;
}

/** A display name: words (atoms) and quoted strings only. Its content is not used. */
function checkPhrase(p: string) {
  const rest = p.replace(/"(?:[^"\\]|\\.)*"/g, " ").trim();
  if (rest === "") return;
  for (const w of rest.split(/\s+/)) if (!/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.\-\u0080-\u{10FFFF}]+$/u.test(w)) throw new Bad("phrase");
}

/** addr-spec -> "local@domain" (local part unquoted when it is a plain dot-atom), or throws. r2-4: CFWS is consumed where RFC 5322 3.4.1 permits it,
 *  around the local part and the domain (comments were already turned into spaces by scan); whitespace INSIDE a dot-atom stays invalid. */
function addrSpec(raw: string): string {
  const s = raw.trim();
  const masked = s.replace(/"(?:[^"\\]|\\.)*"/g, (m) => "x".repeat(m.length));
  const at = masked.lastIndexOf("@");
  if (!s || at <= 0 || at === s.length - 1) throw new Bad("addr");
  let local = s.slice(0, at).trim(); const domain = s.slice(at + 1).trim();
  if (!local || !domain || /\s/.test(masked.slice(0, at).trim()) || /\s/.test(domain)) throw new Bad("addr");
  if (local.startsWith('"')) {
    if (!/^"(?:[^"\\]|\\.)*"$/.test(local)) throw new Bad("addr");
    const inner = local.slice(1, -1).replace(/\\(.)/g, "$1");
    if (inner && inner.split(".").every((x) => ATEXT.test(x))) local = inner;
  } else if (!local.split(".").every((x) => ATEXT.test(x))) throw new Bad("addr");
  const labels = domain.replace(/\.$/, "").split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) throw new Bad("domain");
  return `${local}@${domain.replace(/\.$/, "")}`;
}

/** One mailbox: name-addr (display name ignored) or addr-spec. */
function mailbox(text: string): string {
  const t = text.trim();
  // `<` and `>` count only outside quoted strings: a display name like "<pat@gmail.com>" is text, never an address.
  const masked = t.replace(/"(?:[^"\\]|\\.)*"/g, (m) => "x".repeat(m.length));
  const lt = masked.indexOf("<");
  if (lt < 0) return addrSpec(t);
  const gt = masked.indexOf(">", lt);
  if (gt < 0 || masked.slice(gt + 1).trim() !== "" || masked.indexOf("<", lt + 1) >= 0) throw new Bad("angle");
  checkPhrase(t.slice(0, lt));
  const inner = t.slice(lt + 1, gt);
  if (inner.trim().startsWith("@")) throw new Bad("route");
  return addrSpec(inner);
}

/** Parses every From header value given (normally exactly one) and returns every mailbox in all of them. Invalid anywhere: valid=false. */
export function parseFrom(values: readonly string[]): ParsedFrom {
  const mailboxes: string[] = [];
  try {
    for (const raw of values) {
      // r2-4: unfold (RFC 5322 2.2.3): CRLF immediately followed by WSP is removed. Any other CR or LF left makes the whole field invalid.
      const v = raw.replace(/\r\n(?=[ \t])/g, "");
      if (/[\r\n]/.test(v)) throw new Bad("fold");
      const parts = scan(v);
      let inGroup = false;
      let pending: string[] = [];
      for (const p of parts) {
        if (p.sep === ":") {
          if (inGroup) throw new Bad("group");
          checkPhrase(p.text);
          if (!p.text.trim()) throw new Bad("group");
          inGroup = true; continue;
        }
        if (p.text.trim() !== "") pending.push(mailbox(p.text));
        else if (p.sep === "," && !inGroup) throw new Bad("empty");
        if (p.sep === ";") { if (!inGroup) throw new Bad("group"); inGroup = false; }
        mailboxes.push(...pending); pending = [];
      }
      if (inGroup) throw new Bad("group");
    }
  } catch (e) {
    if (e instanceof Bad) return { valid: false, mailboxes: [] };
    throw e;
  }
  return { valid: true, mailboxes };
}
