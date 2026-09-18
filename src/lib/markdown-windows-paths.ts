// Adapted from OpenMausBot #1380. Markdown reads a backslash before
// punctuation as an escape, so a bot's link to C:\Users\me\.murage\report.md
// parsed as C:\Users\me.murage\report.md: the separator before ".murage" (the
// default data folder), "_drafts" or "-old" was dropped and the link named a
// file that is not there. In a link, image or definition destination that
// starts with a drive letter, such a backslash stays a path separator. "\\"
// and the destination's own delimiters "\(", "\)", "\<" and "\>" still
// escape, so a destination whose backslashes were already escaped reads as
// before. Prose, titles and every other destination keep ordinary escaping.
//
// The structural types below are the slice of mdast-util-from-markdown's
// compile context this extension touches; that package is not a direct
// dependency, so its types are not imported.

type Point = { line: number; column: number; offset?: number };
type Token = { end: Point };
type TextNode = { value: string; position: { end: Point } };
type CompileContext = {
  stack: object[];
  buffer(): void;
  sliceSerialize(token: Token): string;
};
type Handle = (this: CompileContext, token: Token) => undefined;

const destinations = new WeakSet<object>();
const DRIVE = /^[A-Za-z]:(?:[\\/]|$)/;
const STILL_ESCAPES = new Set(["\\", "(", ")", "<", ">"]);

const enterDestination: Handle = function () {
  this.buffer();
  destinations.add(this.stack[this.stack.length - 1]!);
  return undefined;
};

const exitCharacterEscapeValue: Handle = function (token) {
  // The text node `characterEscape` opened, popped as mdast's own data
  // handler would pop it.
  const tail = this.stack.pop() as TextNode;
  const value = this.sliceSerialize(token);
  const separator = destinations.has(this.stack[this.stack.length - 1]!)
    && DRIVE.test(tail.value)
    && !STILL_ESCAPES.has(value);
  tail.value += separator ? `\\${value}` : value;
  tail.position.end = { line: token.end.line, column: token.end.column, offset: token.end.offset };
  return undefined;
};

export const windowsPathDestinations = {
  enter: {
    resourceDestinationString: enterDestination,
    definitionDestinationString: enterDestination,
  },
  exit: {
    characterEscapeValue: exitCharacterEscapeValue,
  },
};

/** remark plugin: parse link destinations with the extension above. */
export function remarkWindowsPathDestinations(this: { data(): object }) {
  const data = this.data() as { fromMarkdownExtensions?: unknown[] };
  (data.fromMarkdownExtensions ??= []).push(windowsPathDestinations);
}
