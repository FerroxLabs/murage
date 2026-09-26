import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const context = {}; context.globalThis = context;
vm.runInNewContext(readFileSync(new URL("./recovery/messages.js", import.meta.url), "utf8"), context);
const { messages, fallback, sentence } = context.murageRecoveryMessages;

// Every refusal code the recovery path can raise, read from the code that
// raises it, so a new one without a sentence fails here.
function raisedCodes() {
  const root = new URL("..", import.meta.url);
  const files = [
    ...readdirSync(new URL("server/", root)).filter(name => /^installation-.*\.ts$/.test(name) && !name.includes(".test.")).map(name => new URL(`server/${name}`, root)),
    ...readdirSync(new URL("electron/", root)).filter(name => /^installation-recovery-.*\.mjs$/.test(name) && !name.includes("test")).map(name => new URL(`electron/${name}`, root)),
    new URL("scripts/installation-recovery-worker.ts", root), new URL("electron/backup-mode.mjs", root),
  ];
  const codes = new Set();
  for (const file of files) for (const match of readFileSync(file, "utf8").matchAll(/(?:fail|refuse|Error)\("([A-Z][A-Z0-9]*_[A-Z0-9_]+)"|code: ?"([A-Z][A-Z0-9]*_[A-Z0-9_]+)"/g)) codes.add(match[1] ?? match[2]);
  for (const test of ["PRIVATE_CREDENTIAL_CANARY", "PRIVATE_ERROR_CANARY"]) codes.delete(test);
  return [...codes];
}

test("every recovery refusal has its own plain sentence", () => {
  const missing = raisedCodes().filter(code => !Object.hasOwn(messages, code));
  assert.deepEqual(missing, []);
});

test("no sentence shows a code, tool jargon, an em dash or safe", () => {
  for (const text of [...Object.values(messages), fallback]) {
    assert.doesNotMatch(text, /[A-Z]{2,}_[A-Z_]+|age-keygen|fidelity|—|\bsaf(?:e|ely)\b/i, text);
    assert.match(text, /\.$/, text);
  }
  assert.equal(sentence("SOMETHING_NEW"), fallback);
  assert.match(sentence("AGE_PROCESS_FAILED"), /recovery key/);
});
