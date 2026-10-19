// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";
import ts from "typescript";
import { cloudHomeCopy } from "./copy.ts";
import { cloudCopy } from "../../src/lib/cloud-copy.ts";

it("keeps all home refusal literals in the designated server copy file", () => {
  const directory = new URL("./", import.meta.url);
  const paths = readdirSync(directory).filter(name => name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "copy.ts").map(name => new URL(name, directory));
  paths.push(new URL("../cloud-request-auth.ts", import.meta.url));
  const failures: string[] = [];
  for (const path of paths) {
    const source = ts.createSourceFile(path.pathname, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    const literal = (node?: ts.Node) => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));
    const visit = (node: ts.Node) => {
      if (ts.isNewExpression(node) && node.expression.getText(source) === "Error" && literal(node.arguments?.[0])) failures.push(path.pathname);
      if (ts.isCallExpression(node) && /^(console\.(error|warn)|refuse)$/.test(node.expression.getText(source)) && node.arguments.some(literal)) failures.push(path.pathname);
      if (ts.isPropertyAssignment(node) && node.name.getText(source) === "error" && literal(node.initializer)) failures.push(path.pathname);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(failures).toEqual([]);
});
it("keeps exact owner copy, client parity and the required wording restrictions", () => {
  expect(cloudHomeCopy.pairedDeviceRequired).toBe("Open this on a device you've paired with your Cloud.");
  expect(cloudHomeCopy.phoneCredential).toBe("Finish this on your computer.");
  expect(cloudHomeCopy.claudeFluxOnHome).toBe("On your Cloud, Claude models on Flux run through Fuigo.");
  expect(cloudHomeCopy.ownerCredentialCaveat).toBe("Murage's code never reads your sign-in files. If the Murage server itself were compromised, it could reach them.");
  for (const [key, value] of Object.entries(cloudCopy)) expect(cloudHomeCopy[key as keyof typeof cloudHomeCopy]).toBe(value);
  for (const value of Object.values(cloudHomeCopy)) expect(value).not.toMatch(/—|\b(?:safe|safely|safety|unsafe|price|budget|spend|composio)\b/i);
});
