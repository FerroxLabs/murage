// Synthetic markers only. None of these strings is a working credential or key.
export const ERROR_TEXT_DIAGNOSTIC = "ordinary diagnostic";
export const ERROR_TEXT_LEAK = /Q7|7x|xQ/;
export function errorTextCases(window = 8192) {
  const value = "Q7x".repeat(window);
  const body = `${"Q7x".repeat(21)}Q\n`.repeat(Math.ceil(window * 3 / 64));
  return [
    { name: "labelled credential", raw: `api_key=${value}\n${ERROR_TEXT_DIAGNOSTIC}` },
    { name: "private key", raw: `-----BEGIN PRIVATE KEY-----\n${body}-----END PRIVATE KEY-----\n${ERROR_TEXT_DIAGNOSTIC}` },
    { name: "inline private key", raw: `-----BEGIN PRIVATE KEY-----${value}-----END PRIVATE KEY-----\n${ERROR_TEXT_DIAGNOSTIC}` },
    { name: "unfinished private key", raw: `-----BEGIN PRIVATE KEY-----\n${body}` },
    { name: "short diagnostic", raw: ERROR_TEXT_DIAGNOSTIC },
  ];
}

/** Full log files whose recent error lies beyond the old 256 KiB prefix. */
export function errorLogTailCases() {
  return [
    { name: "END-only private key", raw: errorTextCases(262144).find(({ name }) => name === "private key")!.raw },
    { name: "partial labelled value", raw: errorTextCases(262144).find(({ name }) => name === "labelled credential")!.raw },
    { name: "recent ordinary diagnostic", raw: `${"old diagnostic\n".repeat(20000)}${ERROR_TEXT_DIAGNOSTIC}` },
  ];
}
