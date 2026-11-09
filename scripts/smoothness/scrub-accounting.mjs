export const ACCOUNTING_KEYS = new Set(["usage", "cost", "charge", "tokens", "tokensin", "tokensout", "inputtokens", "outputtokens", "cachedinput"]);
export function scrubCore(text, visit = () => {}) {
  if (typeof text !== "string") throw TypeError("scrubber requires text");
  // All character inspection goes through read(), including lookahead and escapes.
  const read = i => { if (i >= text.length) return ""; visit(i); return text[i]; };
  const word = c => c !== "" && /[A-Za-z0-9_]/.test(c);
  const space = c => c !== "" && /\s/.test(c);
  const stop = c => !c || space(c) || ",;]}".includes(c);
  const out = [];
  let i = 0;
  while (i < text.length) {
    const start = i, c = read(i);
    if (!word(c)) { out.push(c); i++; continue; }
    const token = [];
    do { token.push(read(i++)); } while (word(read(i)));
    if (!ACCOUNTING_KEYS.has(token.join("").toLowerCase())) { out.push(text.slice(start, i)); continue; }
    if (read(i) === '"' || read(i) === "'") i++;
    while (space(read(i))) i++;
    if (read(i) !== ":" && read(i) !== "=") { out.push(text.slice(start, i)); continue; }
    i++;
    while (space(read(i))) i++;
    out.push(text.slice(start, i));
    const opener = read(i), valueStart = i;
    let valid = false;
    if (opener === "{" || opener === "[") {
      const stack = [];
      let quote = null, escaped = false;
      // One budget, from the opener; each consumed character counts once even
      // inside quotes or after a backslash. Delimiters must match the stack.
      while (i < text.length && i - valueStart < 512) {
        const ch = read(i++);
        if (quote) {
          if (escaped) escaped = false;
          else if (ch === "\\") escaped = true;
          else if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === "\\") break; // escapes exist only inside quotes; outside them the value is malformed (dropped)
        else if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
        else if (ch === "}" || ch === "]") {
          if (stack.pop() !== ch) break;
          if (!stack.length) { valid = true; break; }
        }
      }
    } else if (opener === '"' || opener === "'") {
      i++;
      let escaped = false;
      while (i < text.length && i - valueStart < 512) { // the same 512-char budget as every other branch
        const ch = read(i++);
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === opener) { valid = true; break; }
      }
    } else if (!stop(opener) && !"\\:=}".includes(opener)) {
      valid = true;
      while (i < text.length && !stop(read(i)) && i - valueStart < 512) {
        const ch = read(i++);
        if ('"\'\\{['.includes(ch)) { valid = false; break; }
      }
      if (valid && i < text.length && !stop(read(i))) valid = false; // ran out of budget before the delimiter
    }
    if (!valid) { out.push("[accounting value cut]"); break; }
    out.push('"x"');
  }
  return out.join("");
}

// Validation permits a cut only where the grammar encountered an accounting value.
// Substituting a safe scalar lets the same grammar check every preceding character.
export function safeAccounting(text) {
  const marker = "[accounting value cut]";
  if (!text.endsWith(marker)) return scrubCore(text) === text;
  const prefix = text.slice(0, -marker.length);
  const probe = prefix + '"x"';
  return scrubCore(probe) === probe && scrubCore(prefix + '"') === text;
}
