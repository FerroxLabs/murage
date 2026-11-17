// Stable original-input corpus. Wave 2A owns user-text activation.
const ROWS = [
  [1, "**password**: correct(horse)9", ["horse", "correct"]],
  [1, "**token**: data[abcdefghijklmnop]", ["abcdefghijklmnop", "data["]],
  [2, "**password**: abcd«TAILSECRET9", ["TAILSECRET9", "abcd"]],
  [2, "**password**: «redacted TAILSECRET9»", ["TAILSECRET9"]],
  [2, "**password**: «redacted 7 chars»TAILSECRET9", ["TAILSECRET9"]],
  [2, '**token**: "x «redacted 20 chars» TAIL9xyz"', ["TAIL9xyz"]],
  [3, `**password**: "${"a".repeat(1100)} TAILSECRET9\n\nnext ok`, ["TAILSECRET9", "next ok", "aaaa"]],
  [4, "**token**:\n**password**: hunter2", ["hunter2"]],
  [4, "**token**:**password**: hunter2", ["hunter2"]],
  [4, "**token**: **password**: hunter2", ["hunter2"]],
  [5, "**token: s3cret.**", ["s3cret"]],
  [5, "**password: abcd1234!TAILSECRET.**", ["TAILSECRET", "abcd1234"]],
  [6, "**password**:`alpha123 TAILSECRET9`", ["TAILSECRET9", "alpha123"]],
  [6, "**password**: ``abcd1234`TAILSECRET9``", ["TAILSECRET9", "abcd1234"]],
  [6, "**password**: ``abcd1234`TAILSECRET9", ["TAILSECRET9", "abcd1234"]],
  [7, '**password**: "alpha123\\" TAILSECRET9"', ["TAILSECRET9", "alpha123"]],
  [7, '**password**: "alpha\\"\nTAILSECRET9"', ["TAILSECRET9", "alpha"]],
  [8, '**password**: "alpha1234\nTAILSECRET9"', ["TAILSECRET9", "alpha1234"]],
  [8, '**password**: "alpha1234\n\nTAILSECRET9"', ["TAILSECRET9", "alpha1234"]],
  [8, "**password**:\n\nhunter2", ["hunter2"]],
  [8, "**password**:\n- hunter2", ["hunter2"]],
  [8, "**password**:\n> hunter2", ["hunter2"]],
  [8, "**password**:\nNote: hunter2", ["hunter2", "Note"]],
  [8, "**token**:\n**password**:\nhunter2", ["hunter2"]],
  [8, `**password**:${"\n".repeat(9)}hunter2`, ["hunter2"]],
  [9, "**password**: x1y2z3\nBearer: abcdefghijklmnop\n- Hint: hunter2secret", ["x1y2z3", "abcdefghijklmnop", "hunter2secret", "Hint"]],
  [10, "the token: note **password**: hunter2secret", ["hunter2secret"]],
  [10, "token: prose; **password**: hunter2", ["hunter2"]],
  [10, "**The password: correct horse**", ["correct", "horse"]],
  [10, "**OpenAI API key: hunter2**", ["hunter2"]],
  [10, "+ password: correct horse", ["correct", "horse"]],
  [20, "**password**:\nx9y8z7w6", ["x9y8z7w6"]],
  [20, "**password**:\r\nx9y8z7w6", ["x9y8z7w6"]],
  [20, "****password****: x9y8z7w6", ["x9y8z7w6"]],
  [20, "~~**password**~~: x9y8z7w6", ["x9y8z7w6"]],
  [20, "MURAGE_MODEL_PROVIDER_COMMIT_TOKEN: **x9y8z7w6**", ["x9y8z7w6"]],
  [20, "*Password*: leave blank", ["leave blank"]],
  [20, "`token`: string", ["string"]],
  [20, "_token=4096", ["4096"]],
];
const CORPUS = [
  ...ROWS.map(([, input]) => input),
  "the token: leave this prose alone", "const token = await getToken();", "use a **strong password** here",
  "the `password` field", "my_token: x", "password=hunter2000", "Authorization: Bearer abcdefghijklmnop",
  "XAI_API_KEY: «redacted 12 chars»TAILSECRET9", "api_key: sk-proj-abcdefghijklmnopqrstuv", "**password**: hunter2\nmore\n",
];
const BASE = [
 "**password**: correct(horse)9",
 "**token**: data[abcdefghijklmnop]",
 "**password**: abcd«TAILSECRET9",
 "**password**: «redacted TAILSECRET9»",
 "**password**: «redacted 7 chars»TAILSECRET9",
 "**token**: \"x «redacted 20 chars» TAIL9xyz\"",
 "**password**: \"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa TAILSECRET9\n\nnext ok",
 "**token**:\n**password**: hunter2",
 "**token**:**password**: hunter2",
 "**token**: **password**: hunter2",
 "**token: s3cret.**",
 "**password: «redacted 8 chars»!TAILSECRET.**",
 "**password**:`alpha123 TAILSECRET9`",
 "**password**: ``abcd1234`TAILSECRET9``",
 "**password**: ``abcd1234`TAILSECRET9",
 "**password**: \"alpha123\\\" TAILSECRET9\"",
 "**password**: \"alpha\\\"\nTAILSECRET9\"",
 "**password**: \"alpha1234\nTAILSECRET9\"",
 "**password**: \"alpha1234\n\nTAILSECRET9\"",
 "**password**:\n\nhunter2",
 "**password**:\n- hunter2",
 "**password**:\n> hunter2",
 "**password**:\nNote: hunter2",
 "**token**:\n**password**:\nhunter2",
 "**password**:\n\n\n\n\n\n\n\n\nhunter2",
 "**password**: x1y2z3\nBearer: abcdefghijklmnop\n- Hint: hunter2secret",
 "the token: note **password**: hunter2secret",
 "token: prose; **password**: hunter2",
 "**The password: correct horse**",
 "**OpenAI API key: hunter2**",
 "+ password: correct horse",
 "**password**:\nx9y8z7w6",
 "**password**:\r\nx9y8z7w6",
 "****password****: x9y8z7w6",
 "~~**password**~~: x9y8z7w6",
 "MURAGE_MODEL_PROVIDER_COMMIT_TOKEN: **x9y8z7w6**",
 "*Password*: leave blank",
 "`token`: string",
 "_token=4096",
 "the token: leave this prose alone",
 "const token = await getToken();",
 "use a **strong password** here",
 "the `password` field",
 "my_token: x",
 "password=«redacted 10 chars»",
 "Authorization: Bearer «redacted 16 chars»",
 "XAI_API_KEY: «redacted 12 chars»TAILSECRET9",
 "api_key: «redacted 30 chars»",
 "**password**: hunter2\nmore\n"
]
;
export const TYPE_WORDS = Object.freeze(["string", "number", "boolean", "null", "object", "array", "undefined", "unknown", "any", "void", "never", "token"]);
export const MD_SECRET_CASES = Object.freeze(CORPUS.map((input, i) => {
  const sourceIndex = i + 1;
  const sep = (sourceIndex === 27 || sourceIndex === 28 ? input.lastIndexOf(":") : input.search(/[=:]/)) + 1;
  const wrapped = sourceIndex <= 37 || sourceIndex === 39 || sourceIndex === 47 || sourceIndex === 49;
  const user = wrapped ? input.slice(0, sep) + ` «redacted ${input.length - sep} chars»`
    : sourceIndex === 44 ? "my_token: «redacted 1 chars»" : BASE[i];
  return Object.freeze({ id: `K-24-${String(sourceIndex).padStart(2, "0")}`, sourceIndex, input,
    base: { user: BASE[i] }, expected: { user }, sentinels: ROWS[i]?.[2] ?? [] });
}));
export const PLAIN_CASES = Object.freeze([
  { id: "K-PLAIN-NUMBER", input: "password: 1234", output: "password: «redacted 4 chars»" },
  { id: "K-PLAIN-SHORT", input: "password: hunter2", output: "password: «redacted 7 chars»" },
  { id: "K-COUNT", input: "tokens: 1200", output: "tokens: 1200" },
  { id: "K-PLAIN-TOKEN", input: "token: x", output: "token: «redacted 1 chars»" },
  ...TYPE_WORDS.flatMap((word, i) => [
    { id: `K-CODE-TYPE-${String(i + 1).padStart(2, "0")}`, input: `\`token\`: ${word}`, output: `\`token\`: ${word}` },
    { id: `K-PLAIN-TYPE-${String(i + 1).padStart(2, "0")}`, input: `token: ${word}`, output: `token: ${word}` },
  ]),
]);

// Historical L7 move ledger: original synthetic bytes, not old redacted output.
export const L7_CASES = Object.freeze([
  { id: "K-L7-01", input: "password:\nfirst-value\nsecond-value", user: "password:\nfirst-value\nsecond-value", secrets: ["first-value", "second-value"] },
  { id: "K-L7-02", input: "token\n  arbitrary-value\n\nmore-value", user: "token\n  arbitrary-value\n\nmore-value", secrets: ["arbitrary-value", "more-value"] },
  { id: "K-L7-03", input: ("private key\n-----BEGIN PRIVATE " + "KEY-----\nPEMSECRET\n-----END PRIVATE " + "KEY-----"), secrets: ["PEMSECRET"] },
  { id: "K-L7-04", input: ("private_key=-----BEGIN PRIVATE " + "KEY-----\nUNMATCHEDSECRET"), secrets: ["UNMATCHEDSECRET"] },
  { id: "K-L7-05", input: `token=SG.${"a".repeat(22)}.\n${"b".repeat(43)}`, secrets: ["aaaa", "bbbb"] },
  { id: "K-L7-06", input: `Bearer pypi-AgE${"c".repeat(40)}\n  ${"d".repeat(42)}`, secrets: ["cccc", "dddd"] },
  { id: "K-L7-07", input: `token=sk-${"a".repeat(20)}/rest.~tail`, secrets: ["aaaa", "/rest.~tail"] },
  { id: "K-L7-08", input: "ordinary status: ready", user: "ordinary status: ready", secrets: [] },
]);
export const L7_VARIANT_IDS = Object.freeze(["K-L7-LINES", "K-L7-LABELS", "K-L7-TAIL", "K-L7-SHORT", "K-L7-UNION", "K-L7-MARKER", "K-L7-PEM", "K-L7-PROVIDER", "K-L7-OWNER"]);
