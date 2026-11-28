// SPDX-License-Identifier: AGPL-3.0-or-later
// Included-file journals are accepted only for source compatibility and ignored.
// Compatibility entry point. No limits has one narrow catastrophe breaker.
import { wipeBreaker, type WipeContext } from './wipe-breaker.ts';
import type { AlwaysAskHit, UnseenOptions } from './always-ask.ts';
import { decodeAnsiC } from './outside-scan.ts';
import { deviceInWord } from './shell/walk.ts';
export function noLimitsWipe(text: string, options: WipeContext & { unread?: boolean; unseen?: UnseenOptions; scriptDepth?: number; writtenScripts?: ReadonlySet<string> } = {}) {
  // MAIN-RULING NOLIMITS-1022 H1 correction (2026-11-25T18:57:03Z): an obfuscated wipe asks too, decoded as far as it decodes
  // text a PowerShell -EncodedCommand decodes to is PowerShell, whatever shell the call itself is read as
  return wipeBreaker(text, options) ?? argvDisk(text) ?? obfuscatedWipe(text, (decoded, pwsh) => wipeBreaker(decoded, pwsh ? { ...options, dialect: "pwsh", shell: undefined, lang: undefined } : options));
}


/** Inline interpreter code that takes its target from argv, handed a disk by name (`python3 -c 'open(sys.argv[1],"wb")' /tmp/../dev/sda`):
 * the wipe engine does not model the code's own argv, so the named disk is the wipe. Streams such as /dev/null are no disk. */
const ARGV_CODE = /\b(?:sys\.argv|process\.argv|ARGV|\$argv|\$ARGV|Bun\.argv)\b|\$\{?[@*0-9]\b/;
/** The code writes: a write call (not the word inside a string), a write or append open mode, or a perl `>` open. Printing or reading argv names no wipe. */
const WRITE_CODE = /(?<!["'\w])(?:write|writeFileSync|writeFile|appendFile(?:Sync)?|createWriteStream|truncate|ftruncate|copyfile|copyFileSync|sendfile|tofile|file_put_contents|fwrite)\s*\(|\bopen\s*\([^)]*(?:["'](?:[wa]|r\+)[bt+]*["']|>)/;
function argvDisk(text: string) {
  if (!ARGV_CODE.test(text) || !WRITE_CODE.test(text) || !/\b(?:python[\d.]*|node|nodejs|deno|bun|ruby|perl|php)\b/.test(text)) return null;
  const disk = deviceInWord(text);
  return disk === undefined ? null : { rule: "disk-erase" as const, what: "This would erase or repartition a disk. Run it anyway?" };
}

export const HOME_OR_ROOT = /^["']?(?:~|\$\{?HOME\}?|\/)\/?\*?["']?[;&|)]*$/;

/** A short option word holding both r and f (`-rf`, `-fr`, `-Rfv`), read word by word so no pattern backtracks. */
export function recursiveForceWord(word: string): boolean {
  if (word.length < 3 || word.length > 32 || word[0] !== "-" || word[1] === "-" || !/^-[a-z]+$/i.test(word)) return false;
  const lower = word.toLowerCase();
  return lower.includes("r") && lower.includes("f");
}

/** The words of a text, split on blanks and shell separators (linear). */
export function wordsOf(text: string): string[] {
  return text.split(/[\s;&|()]+/).filter(Boolean);
}

/** Where decoded text runs: piped to a shell, handed to sh -c, eval, iex, a substitution or a variable in command position, or an exec call
 * (`RegExp.exec(` is a method, not one). Read only when a literal payload below decodes. */
const EXEC_POSITION = /\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b(?!\s+-n\b)|\b(?:ba|z|da|k)?sh\s+-c\b|\beval\b|\b(?:iex|invoke-expression)\b|(?:^|[;&|(]\s*|\b(?:then|do)\s+)(?:\$\(|`)|(?:^|[;&|]\s*)\$\{?\w+\}?(?=\s|;|$)|(?<![.\w$])(?:exec|eval)\s*\(|\bos\.system\s*\(|\bsystem\s*\(|\bsubprocess\.\w+\s*\(|\bexecSync\s*\(|\bnew\s+Function\s*\(/i;
const base64Text = (literal: string): string => Buffer.from(literal, "base64").toString("utf8");
const hexText = (literal: string): string | undefined => literal.length % 2 === 0 ? Buffer.from(literal, "hex").toString("utf8") : undefined;
/** A decoding call on a literal payload, and what it decodes to (bounded, linear patterns). */
const LITERAL_DECODES: readonly (readonly [RegExp, (literal: string) => string | undefined])[] = [
  [/\b(?:echo(?:\s+-n)?|printf(?:\s+%s)?)\s+["']?([A-Za-z0-9+/=]{4,8192})["']?\s*\|\s*base64\s+(?:-d|--decode|-D)\b/g, base64Text],
  [/\b(?:atob|b64decode|b64decodebytes|decodebytes|frombase64string)\s*\(\s*b?["']([A-Za-z0-9+/=]{4,8192})["']/gi, base64Text],
  [/\b(?:unhexlify|fromhex)\s*\(\s*b?["']([0-9a-fA-F]{2,8192})["']/gi, hexText],
  [/\bpack\s*\(\s*["']H\*["']\s*,\s*["']([0-9a-fA-F]{2,8192})["']/g, hexText],
  [/\b(?:echo(?:\s+-n)?|printf(?:\s+%s)?)\s+["']?([0-9a-fA-F]{2,8192})["']?\s*\|\s*xxd\s+-r\s+-p\b/g, hexText],
];
/** The one decode this reads to the end: `echo|printf [%s|%b] <literal> [| base64 -d | rev | xxd -r -p] | sh`. */
const PRINTED_TO_SHELL = /^\s*(echo(?:\s+-[neE]+)?|printf(?:\s+(["']?)%[sb]\2)?)\s+(?:'([^']*)'|"([^"$`\\]*)"|([^\s'"|;&$`]+))\s*(?:\|\s*(base64\s+(?:-d|--decode|-D)|rev|xxd\s+-r\s+-p)\s*)?\|\s*(?:ba|z|da|k)?sh\s*$/;
const ANSI_C_WORD = /\$'(?:[^'\\]|\\[\s\S])*'/g;
const singleQuoted = (text: string): string => `'${text.replace(/'/g, "'\\''")}'`;
/** The home folder or the root as the shell expands it: a quoted `~` is a file named ~. */
const HOME_OR_ROOT_UNQUOTED = /^(?:~|\$\{?HOME\}?|"\$\{?HOME\}?"|\/|["']\/["'])\/?\*?[;&|)]*$/;

/** The decoded text `PRINTED_TO_SHELL` hands its shell, or undefined when this does not decode it. */
function printedToShell(text: string): string | undefined {
  const match = PRINTED_TO_SHELL.exec(text);
  if (!match) return undefined;
  const [, printer, , single, double, bare, decoder] = match;
  let printed = single ?? double ?? bare ?? "";
  // printf and echo -e read backslash escapes themselves
  if (printer!.startsWith("printf") && !/%s/.test(printer!) || /^echo\s+-\w*e/.test(printer!)) printed = decodeAnsiC(`$'${printed.replace(/'/g, "\\'")}'`);
  else if (/\\/.test(printed)) return undefined;
  if (!decoder) return printed;
  if (decoder.startsWith("rev")) return printed.split("\n").map(line => [...line].reverse().join("")).join("\n");
  if (decoder.startsWith("xxd")) return /^(?:[0-9a-f]{2})+$/i.test(printed.trim()) ? Buffer.from(printed.trim(), "hex").toString("utf8") : undefined;
  return /^[A-Za-z0-9+/=]+$/.test(printed.trim()) ? Buffer.from(printed.trim(), "base64").toString("utf8") : undefined;
}

/** Whether the decode at [start, end) is what runs, not text printed beside an unrelated eval (Astra precheck r5 pass 2):
 * piped on to a shell or iex, inside a command-position substitution, set to a variable a later eval or command word runs,
 * or the argument of an exec, eval, system or subprocess call. Each read is anchored to the decode, so it is linear. */
function decodedRuns(text: string, start: number, end: number): boolean {
  // inside single quotes it is data (`echo 'x | base64 -d | sh'`), unless that quoted body is code sh -c, eval or an
  // interpreter's -c / -e runs (`python3 -c '...'`, `perl -e '...'`)
  // an apostrophe inside double quotes or behind a backslash opens nothing (`echo "don't"; echo <payload> | base64 -d | sh`)
  let quote = -1, double = false;
  for (let at = 0; at < start; at++) {
    const char = text[at];
    if (quote >= 0) { if (char === "'") quote = -1; }
    else if (char === "\\") at++;
    else if (char === '"') double = !double;
    else if (char === "'" && !double) quote = at;
  }
  if (quote >= 0 && !/(?:\b(?:ba|z|da|k)?sh\s+-c|\beval|\b(?:python[\d.]*|perl|ruby|node|deno|bun|php|pwsh|powershell)(?:\s+-\w+)*\s+-[ceE]|\bosascript\s+-e)\s+$/i.test(text.slice(Math.max(0, quote - 64), quote))) return false;
  const before = text.slice(Math.max(0, start - 256), start);
  const after = text.slice(end, end + 256);
  if (/^[^;&\n]*?\|\s*(?:sudo\s+)?(?:(?:ba|z|da|k)?sh\b(?!\s+-n\b)|iex\b|invoke-expression\b|source\s+\/dev\/stdin)/i.test(after)) return true;
  if (/(?:^|[;&|(]\s*|\b(?:then|do)\s+)(?:\$\(|`)\s*$/.test(before)) return true;
  // the substitution eval or sh -c is handed, quoted or not (`eval "$(echo <payload> | base64 -d)"`)
  if (/(?:\beval|\b(?:ba|z|da|k)?sh\s+-c)\s+["']?(?:\$\(|`)\s*$/.test(before)) return true;
  const assigned = /(?:^|[\s;&|(])(\w+)=["']?(?:\$\(|`)\s*$/.exec(before)?.[1];
  if (assigned && new RegExp(`(?:\\beval\\s+["']?|(?:^|[;&|]\\s*))\\$\\{?${assigned}\\}?(?![\\w}])`).test(text.slice(end))) return true;
  // the argument of an exec call, also behind a concatenated literal (`os.system(" " + base64.b64decode(...))`; Astra pass 3)
  return /(?<![.\w$])(?:exec|eval|system|os\.system|subprocess\.\w+|execSync|Function)\s*\(\s*(?:[\w.\s(+]|"[^"\n]{0,64}"|'[^'\n]{0,64}')*$/.test(before);
}

/** 1.0.22 MAIN-RULING NOLIMITS-1022 H1 correction (2026-11-25T18:57:03Z, Sean 11-12): at No limits only wipe-shaped commands
 * ask, obfuscated ones included. `isWipe` is the No limits wipe check; this hands it the text decoded as far as it decodes
 * (`$IFS` as a space, `$'...'` escapes, a NUL ending a word, a PowerShell -EncodedCommand, a printed literal piped to a
 * shell). A recursive forced delete of the home folder or the root behind a program the text builds (`$R -rf ~`) is a
 * wipe; so is a literal payload decoded where it runs (base64, hex) that decodes to a wipe; one with no literal runs. Readable
 * text it does not change is the wipe check's alone, so No limits adds no card to a command it reads. A fault is a wipe. */
export function obfuscatedWipe(text: string, isWipe: (decoded: string, pwsh?: true) => AlwaysAskHit | null, depth = 0): AlwaysAskHit | null {
  const fault = { rule: "wipe-check-fault" as const, what: "Murage couldn't finish checking this command for a whole-drive wipe. Run it anyway?" };
  try {
    if (depth > 2) return fault;
    const seen = (decoded: string | undefined) => decoded !== undefined && decoded !== text ? (isWipe(decoded) ?? obfuscatedWipe(decoded, isWipe, depth + 1)) : null;
    // `$IFS` splits the word after tilde expansion, so a `~` behind it is a file named ~ (`rm$IFS-rf$IFS/` still deletes the root)
    const spaced = text.replace(/\$\{?IFS\}?(~)?/g, (_whole, tilde?: string) => tilde ? " '~'" : " ");
    // a `$'...'` word is one quoted word once decoded (`$'\x7e'` is a file named ~), and bash ends it at its first NUL
    // (`$'rm\0x'` runs rm; `$'\0rm'` is an empty word, MAIN RULING 1114-NOLIMITS-OLD-ORACLES read-17)
    const decoded = spaced.replace(ANSI_C_WORD, word => singleQuoted(decodeAnsiC(word).split("\0")[0]!));
    const found = seen(spaced) ?? seen(decoded);
    if (found) return found;
    // PowerShell's -EncodedCommand (any prefix of it, `-ec`, with `-` or `/`) is base64 UTF-16LE: read what it decodes to
    for (const [, flag, encoded] of text.matchAll(/(?:^|\s)[-/]([a-z]+)[\s:]+["']?([A-Za-z0-9+/=]{4,})/gi)) {
      const name = flag!.toLowerCase();
      if (name !== "ec" && !(name.startsWith("e") && "encodedcommand".startsWith(name))) continue;
      const inner = Buffer.from(encoded!, "base64").toString("utf16le");
      // read as PowerShell also behind a host the text hides (`$PS -ec <payload>`), where the wipe check never saw PowerShell
      const hit = isWipe(inner, true) ?? obfuscatedWipe(inner, isWipe, depth + 1);
      // wipe-only (Sean 11-12): the decoded text is the wipe check's alone, so a recursive delete of a scratch folder runs
      if (hit) return hit;
    }
    // a variable the text sets to a literal and hands to eval or a shell (`p='rm -rf ~'; eval "$p"`): read the literal
    for (const [, name] of [...text.matchAll(/(?:\beval|\b(?:ba|z|da|k)?sh\s+-c)\s+["']?\$\{?(\w+)\}?/g)].slice(0, 8)) {
      const value = new RegExp(`(?:^|[\\s;&|(])${name}=(?:'([^']*)'|"([^"$\`\\\\]*)")`).exec(text);
      const literal = value?.[1] ?? value?.[2];
      const hit = literal !== undefined ? isWipe(literal) ?? obfuscatedWipe(literal, isWipe, depth + 1) : null;
      if (hit) return hit;
    }
    // a recursive forced delete flag on the unquoted home folder or the root behind a program the text builds: a variable it
    // never sets (`$R -rf ~`; a variable it sets is the wipe check's, `R=ls; $R -rf ~`), or rm behind a substitution (`$(echo rm) -rf /`)
    // single-quoted text is data here (`echo '$(rm -rf /)'`); a shell it is handed to is read above
    const bare = decoded.replace(/'[^']*'/g, "''");
    const words = wordsOf(bare);
    for (const [at, word] of words.entries()) {
      if (!recursiveForceWord(word) || at + 1 >= words.length || !HOME_OR_ROOT_UNQUOTED.test(words[at + 1]!)) continue;
      const program = words[at - 1] ?? "";
      const variable = /^\$\{?(\w+)\}?$/.exec(program)?.[1];
      const unset = variable !== undefined && !new RegExp(`(?:^|[\\s;&|(])${variable}=`).test(bare);
      const built = /^(?:rm|rmdir|unlink|del)$/i.test(program) && /\$\(|`/.test(bare);
      if (!unset && !built) continue;
      return /^["']?\//.test(words[at + 1]!) ? { rule: "delete-root", what: "This deletes everything on the computer. Run it anyway?" } : { rule: "delete-home", what: "This deletes your home folder. Run it anyway?" };
    }
    // a printed literal piped to a shell (`printf '\x72\x6d -rf ~' | sh`, `echo '~ fr- mr' | rev | sh`): read what the shell gets
    const printed = printedToShell(text);
    if (printed !== undefined) return isWipe(printed) ?? obfuscatedWipe(printed, isWipe, depth + 1);
    // a literal payload decoded where it runs (`$(echo cm0g... | base64 -d)`, `os.system(b64decode("..."))`): a wipe once decoded
    // asks; a payload with no literal is not wipe-shaped by anything this can read, and runs (wipe-only, MAIN 18:57:03Z)
    if (!EXEC_POSITION.test(text)) return null;
    for (const [pattern, decode] of LITERAL_DECODES) for (const match of text.matchAll(pattern)) {
      if (!decodedRuns(text, match.index!, match.index! + match[0].length)) continue;
      const plain = decode(match[1]!);
      const hit = plain !== undefined ? isWipe(plain) ?? obfuscatedWipe(plain, isWipe, depth + 1) : null;
      if (hit) return hit;
    }
    return null;
  } catch {
    return fault;
  }
}
