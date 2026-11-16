import ts from "typescript";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** AST-based public declarations: assigned implementation bodies are deliberately omitted. */
export function publicSignatures(source: string, only?: readonly string[], parameterPropertyClasses?: readonly string[]): string[] {
  const file = ts.createSourceFile("contract.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const printer = ts.createPrinter({ removeComments: true });
  const print = (node: ts.Node) => printer.printNode(ts.EmitHint.Unspecified, node, file).replace(/\b(?:declare|async)\s+/gu, "");
  const exported = (node: ts.Node) => ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
  const signature = (node: ts.Node): string => {
    // Strip implementation blocks structurally, including constructors and accessors.
    if (ts.isFunctionDeclaration(node)) return print(ts.factory.updateFunctionDeclaration(node, node.modifiers, node.asteriskToken, node.name, node.typeParameters, node.parameters, node.type, undefined));
    if (ts.isMethodDeclaration(node)) return print(ts.factory.updateMethodDeclaration(node, node.modifiers, node.asteriskToken, node.name, node.questionToken, node.typeParameters, node.parameters, node.type, undefined));
    if (ts.isConstructorDeclaration(node)) return print(ts.factory.updateConstructorDeclaration(node, node.modifiers, node.parameters, undefined));
    if (ts.isGetAccessorDeclaration(node)) return print(ts.factory.updateGetAccessorDeclaration(node, node.modifiers, node.name, node.parameters, node.type, undefined));
    if (ts.isSetAccessorDeclaration(node)) return print(ts.factory.updateSetAccessorDeclaration(node, node.modifiers, node.name, node.parameters, undefined));
    if (ts.isPropertyDeclaration(node)) return print(ts.factory.updatePropertyDeclaration(node, node.modifiers, node.name, node.questionToken ?? node.exclamationToken, node.type, undefined));
    if (ts.isClassDeclaration(node)) {
      let members = node.members.filter(m => !(m.name && ts.isPrivateIdentifier(m.name)) && !(ts.canHaveModifiers(m) && ts.getModifiers(m)?.some(v => v.kind === ts.SyntaxKind.PrivateKeyword)));
      // Node's strip-only runtime needs explicit fields. Canonicalize that
      // explicitly marked equivalent API to the frozen parameter-property spelling;
      // require an exact name/type/readonly match, retaining every other field.
      const constructors = members.filter(ts.isConstructorDeclaration);
      if ((parameterPropertyClasses === undefined || parameterPropertyClasses.includes(node.name?.text ?? "")) && constructors.length === 1 && constructors[0]!.body) {
        const constructor = constructors[0]!;
        const folded = new Set<ts.ClassElement>();
        const parameters = constructor.parameters.map(parameter => {
          if (!ts.isIdentifier(parameter.name) || !parameter.type || parameter.questionToken || parameter.dotDotDotToken || parameter.modifiers?.length) return parameter;
          const property = members.find((member): member is ts.PropertyDeclaration => ts.isPropertyDeclaration(member)
            && ts.isIdentifier(member.name) && member.name.text === (parameter.name as ts.Identifier).text
            && ts.getJSDocTags(member).some(tag => tag.tagName.text === "frozenParameterProperty")
            && !member.questionToken && !member.exclamationToken && !member.initializer
            && Boolean(member.type) && member.type!.getText(file) === parameter.type!.getText(file)
            && member.modifiers?.length === 1 && member.modifiers[0]!.kind === ts.SyntaxKind.ReadonlyKeyword);
          if (!property) return parameter;
          folded.add(property);
          return ts.factory.updateParameterDeclaration(parameter, [ts.factory.createModifier(ts.SyntaxKind.ReadonlyKeyword)], parameter.dotDotDotToken, parameter.name, parameter.questionToken, parameter.type, parameter.initializer);
        });
        members = members.filter(member => !folded.has(member)).map(member => member === constructor
          ? ts.factory.updateConstructorDeclaration(constructor, constructor.modifiers, parameters, constructor.body) : member);
      }
      return `class ${node.name?.text} ${node.typeParameters?.map(print).join(",") ?? ""} ${node.heritageClauses?.map(print).join(" ") ?? ""} {\n${members.map(signature).join("\n")}\n}`;
    }
    return print(node);
  };
  return file.statements.flatMap(node => {
    if (!exported(node)) return [];
    const names = ts.isVariableStatement(node) ? node.declarationList.declarations.map(d => d.name.getText(file))
      : "name" in node && node.name ? [(node.name as ts.Node).getText(file)] : [];
    if (only && !names.some(n => only.includes(n))) return [];
    return [signature(node)];
  });
}

const surfaces: Record<string, readonly string[] | undefined> = {
  "server/highlevel/operations/registry.ts": undefined,
  "server/highlevel/held-request.ts": undefined,
  "server/highlevel/uploads.ts": undefined,
  "server/highlevel/anchored-read.ts": undefined,
  "server/highlevel/event-projection.ts": undefined,
  "server/highlevel/actions.ts": undefined,
  "server/highlevel/escalation.ts": undefined,
  "server/highlevel/multipart.ts": undefined,
  "server/highlevel/provider-contract.ts": ["HighLevelMethod", "RetryClass", "HighLevelEndpoint"],
  "server/highlevel/client.ts": ["HighLevelCallContext"],
  "shared/highlevel.ts": ["HIGHLEVEL_FAMILIES", "Family", "Risk", "FamilyLevel", "OperationId", "EffectiveGrant", "EffectiveHighLevelAccess", "effectiveHighLevelAccess", "operationAllowed", "highlevelDenyMatch", "levelCovers", "workspaceFileRefSchema", "highlevelDenyRuleSchema", "LEGACY_TOOL_TO_OPERATION"],
};
export function contractSnapshot(root: string = process.cwd()): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [path, names] of Object.entries(surfaces)) {
    // Only this F0 class used a parameter property. Other frozen declarations
    // (including PreparedUpload) already spelled their properties explicitly.
    const parameterPropertyClasses = path === "server/highlevel/anchored-read.ts" ? ["AnchoredReadRefused"] : [];
    out[path] = publicSignatures(readFileSync(resolve(root, path), "utf8"), names, parameterPropertyClasses);
  }
  // Only the HighLevel bus seam is frozen; unrelated bus members remain editable.
  const bus = ts.createSourceFile("bus.ts", readFileSync(resolve(root, "server/harness/bus.ts"), "utf8"), ts.ScriptTarget.Latest, true);
  const cls = bus.statements.find(s => ts.isClassDeclaration(s) && s.name?.text === "EventBus") as ts.ClassDeclaration;
  const member = cls.members.find(m => m.name?.getText(bus) === "highlevelProjection")!;
  out["server/harness/bus.ts"] = publicSignatures(`export class EventBus { ${member.getText(bus)} }`);
  // S-INT may update only the initializer at wave boundaries, not its type.
  out["server/highlevel/operations/integrated-families.ts"] = publicSignatures(readFileSync(resolve(root, "server/highlevel/operations/integrated-families.ts"), "utf8").replace(/=\s*[^;]+;/u, "= [];"));
  const data = ["server/highlevel/operations/manifest.ts", "server/highlevel/operations/manifest-data.json", "server/highlevel/provider-manifest.json",
    ...readdirSync(resolve(root, "server/highlevel/operations/schemas")).filter(f => f.endsWith(".ts")).map(f => `server/highlevel/operations/schemas/${f}`)];
  for (const path of data.sort()) out[path] = createHash("sha256").update(readFileSync(resolve(root, path))).digest("hex");
  return out;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const snapshot = JSON.stringify(contractSnapshot(), null, 2) + "\n";
  if (process.argv.includes("--write")) writeFileSync("server/highlevel/frozen-contract.json", snapshot);
  else if (snapshot !== readFileSync("server/highlevel/frozen-contract.json", "utf8")) throw new Error("F0 contract changed: MAIN manifest amendment required");
}
