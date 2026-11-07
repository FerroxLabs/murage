/** Shared finite speech grammar; destination exemptions use this same lexer. */
import { parseFragment } from "parse5";
import { findSecretLabels, isExactMarker } from "../../shared/md-secret-label.mjs";

type Span = Readonly<{ start: number; end: number; view: string; spoken: string; atomic: boolean; unsafe?: boolean }>;
const TAGS = new Set("murage-goal b strong i em u s del span p div br img a code pre blockquote tool_output tool_result tool-output tool-result table tr td th tbody thead ul ol li h1 h2 h3 h4 h5 h6".split(" "));
const VOID = new Set(["br", "img"]);
const BLOCK = new Set("p div pre blockquote table tr ul ol li h1 h2 h3 h4 h5 h6 tool_output tool_result tool-output tool-result".split(" "));

function decode(text: string): string {
  return text.replace(/&(?:#[xX][\da-fA-F]+|#\d+|[A-Za-z][A-Za-z\d]+);/g, (entity) => {
    const node = parseFragment(entity).childNodes[0];
    return node && "value" in node ? node.value : entity;
  }).replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, "$1");
}

/** A finite grammar, with a work and depth bound. Unrepresented syntax closes the source. */
export function lex(source: string, destinations?: Array<{ start: number; end: number }>): Span[] {
  const spans: Span[] = [];
  const lowerSource = source.toLowerCase();
  let work = source.length * 40 + 40;
  const scan = (from: number, to: number, depth: number, omitted = false): Span[] => {
    const out: Span[] = [];
    const add = (start: number, end: number, view: string, spoken = view, atomic = true, unsafe = false) => {
      out.push({ start, end, view, spoken, atomic, ...(unsafe ? { unsafe: true } : {}) });
    };
    for (let i = from; i < to;) {
      if (--work < 0 || depth > 32) throw new Error("speech scan budget");
      const start = i;
      const c = source[i];
      if (c === "«") {
        const close = source.indexOf("»", i + 1);
        const end = close < 0 || close >= to ? to : close + 1;
        const raw = source.slice(i, end);
        const safe = isExactMarker(raw) && (end === to || /\s/.test(source[end]));
        add(i, end, "redacted", "redacted", true, !safe);
        i = end; continue;
      }
      if (c === "»") { add(i, to, "", "", true, true); break; }
      if (!omitted && (i === 0 || source[i - 1] === "\n") && /[ `~\t|]/.test(c)) {
        const lineEnd = Math.min(to, source.indexOf("\n", i) < 0 ? to : source.indexOf("\n", i));
        const line = source.slice(i, lineEnd);
        const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
        if (fence) {
          const endRe = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}[ \\t]*$`, "gm");
          endRe.lastIndex = lineEnd + 1;
          const close = endRe.exec(source);
          const end = close && close.index < to ? close.index + close[0].length : to;
          const children = scan(lineEnd + 1, close && close.index < to ? close.index : to, depth + 1, true);
          add(i, end, children.map(s => s.view).join(""), "code omitted", true, !close || children.some(s => s.unsafe));
          i = end; continue;
        }
        if (/^(?: {4}|\t)/.test(line) || /^\s*\|.*\|\s*$/.test(line)) {
          const children = scan(i, lineEnd, depth + 1, true);
          add(i, lineEnd, children.map(s => s.view).join(""), line.trimStart().startsWith("|") ? "table omitted" : "code omitted", true, children.some(s => s.unsafe));
          i = lineEnd; continue;
        }
      }
      if (c === "<") {
        const tail = source.slice(i, to);
        const url = /^<https?:\/\/[^\s<>]+>/.exec(tail);
        if (url) { add(i, i + url[0].length, decode(url[0]), "link"); i += url[0].length; continue; }
        const tag = /^<([\w-]+)\b(?:[^<>"']|"[^"]*"|'[^']*')*>/.exec(tail);
        if (!tag || !TAGS.has(tag[1].toLowerCase())) { add(i, to, "", "", true, true); break; }
        const name = tag[1].toLowerCase();
        // Inspect raw attributes even for table tags that an HTML fragment parser
        // drops outside their required parent context.
        const attrs = [...tag[0].slice(name.length + 1, -1).matchAll(/([^\s<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)]
          .map((match) => ({ name: match[1], value: match[2] ?? match[3] ?? match[4] ?? "" }));
        const badAttribute = attrs.some(({ name, value }) => findSecretLabels(`${name}:`).length > 0 || findSecretLabels(`${decode(value)}:`).length > 0);
        const attrView = attrs.map(({ value }) => decode(value)).join(" ");
        if (VOID.has(name) || /\/>$/.test(tag[0])) {
          add(i, i + tag[0].length, attrView, name === "img" ? "image omitted" : "\n", true, badAttribute);
          i += tag[0].length; continue;
        }
        // Nested same-name elements are conservatively unsafe. No partial tag can escape.
        const closing = `</${name}>`;
        const endTag = lowerSource.indexOf(closing, i + tag[0].length);
        if (endTag < 0 || endTag >= to) { add(i, to, "", "", true, true); break; }
        const innerStart = i + tag[0].length;
        const children = scan(innerStart, endTag, depth + 1);
        const view = children.map((s) => s.view).join("");
        const block = BLOCK.has(name) ? "\n" : "";
        const omitted = name === "murage-goal" ? "" : name === "pre" || name.startsWith("tool_") || name.startsWith("tool-") ? "code omitted" : name === "table" ? "table omitted" : children.map((s) => s.spoken).join("");
        const unsafe = badAttribute || children.some((s) => s.unsafe) || findSecretLabels(attrView).length > 0;
        add(i, endTag + closing.length, block + view + block, block + omitted + block, true, unsafe);
        i = endTag + closing.length; continue;
      }
      if (c === "[" || (c === "!" && source[i + 1] === "[")) {
        const image = c === "!";
        const open = i + (image ? 1 : 0);
        let level = 1, end = open + 1;
        for (; end < to && level; end++) {
          if (--work < 0) throw new Error("speech scan budget");
          if (source[end] === "\\") { end++; continue; }
          if (source[end] === "[") level++;
          if (source[end] === "]") level--;
        }
        if (level || source[end] !== "(") { add(i, to, "", "", true, true); break; }
        const labelEnd = end - 1;
        level = 1;
        let finish = end + 1;
        for (; finish < to && level; finish++) {
          if (--work < 0) throw new Error("speech scan budget");
          if (source[finish] === "\\") { finish++; continue; }
          if (source[finish] === "(") level++;
          if (source[finish] === ")") level--;
        }
        if (level) { add(i, to, "", "", true, true); break; }
        const children = scan(open + 1, labelEnd, depth + 1);
        destinations?.push({ start: end + 1, end: finish - 1 });
        add(i, finish, children.map((s) => s.view).join(""), image ? "image omitted" : children.map((s) => s.spoken).join(""), true,
          children.some((s) => s.unsafe) || findSecretLabels(decode(source.slice(end + 1, finish - 1))).length > 0);
        i = finish; continue;
      }
      if (c === "`") {
        let width = 1;
        while (source[i + width] === "`") width++;
        const close = source.indexOf("`".repeat(width), i + width);
        if (close < 0 || close >= to) { add(i, to, "", "", true, true); break; }
        const view = decode(source.slice(i + width, close));
        add(i, close + width, view, width >= 3 ? "code omitted" : view);
        i = close + width; continue;
      }
      if (c === "*" || c === "~" || c === "_") {
        // Shared label normalization independently inspects the original source.
        // Preserve underscores within words; other decoration contributes no text.
        const kept = c === "_" && /[\p{L}\p{N}]/u.test(source[i - 1] ?? "") && /[\p{L}\p{N}]/u.test(source[i + 1] ?? "");
        add(i, i + 1, kept ? c : "", kept ? c : ""); i++; continue;
      }
      if (c === "&" || c === "\\") {
        const entity = /^(?:&(?:#[xX][\da-fA-F]+|#\d+|[A-Za-z][A-Za-z\d]+);|\\[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/.exec(source.slice(i, to));
        if (entity) { add(i, i + entity[0].length, decode(entity[0])); i += entity[0].length; continue; }
      }
      i++;
      while (i < to && !/[«»<\[!`*~_&\\\n]/.test(source[i]) && source[i - 1] !== "\n") i++;
      add(start, i, source.slice(start, i), source.slice(start, i), false);
    }
    return out;
  };
  spans.push(...scan(0, source.length, 0));
  return spans;
}

/** Only the lexer can grant a markdown destination exemption. Code spans,
 * escaped brackets and unmatched closers must retain their original text. */
export function withoutSpeechDestinations(source: string): string {
  const destinations: Array<{ start: number; end: number }> = [];
  lex(source, destinations);
  const parts: string[] = [];
  let start = 0;
  // Recursive label scans finish before their enclosing destination, so these
  // disjoint ranges already occur in source order.
  for (const destination of destinations) {
    parts.push(source.slice(start, destination.start), " ");
    start = destination.end;
  }
  parts.push(source.slice(start));
  // This is the exact bare-URL span rewritten to "link" by speech protection.
  return parts.join("").replace(/https?:\/\/\S+/g, " ");
}

