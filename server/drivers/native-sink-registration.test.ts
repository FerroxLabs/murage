import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import ts from "typescript";
import { consumingSinkEntry } from "../consuming-sink-inventory.ts";

// Inventory failures refuse the real answer before the transport is entered.
// Keep each concrete native-answer call tied to its registered destination.
for (const file of ["claude.ts", "codex.ts", "codex-hook.ts", "pi.ts", "openai-chat.ts", "acp/approval-delivery.ts"]) {
  const source = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  let call = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "releaseNativeAnswer") {
      const sink = node.arguments[1];
      const ordinal = ++call;
      it(`${file} native answer ${ordinal} has a registered final sink`, () => {
        expect(sink && ts.isStringLiteral(sink), "a native sink must be an explicit registered literal").toBe(true);
        if (!sink || !ts.isStringLiteral(sink)) return;
        expect(consumingSinkEntry(`native:${sink.text}`, "native"), `${file}: ${sink.text}`).toMatchObject({
          provenanceContract: "explicit-per-response", finalGate: "emitConsumingTurnResponse", refusalHandler: "binding.onLedgerRefused",
        });
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}
