// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixture owner: sc-safety. Policy owner: the selected production declarations.
// Only enumerated pure initializers are evaluated; server boot and service
// constructors are never evaluated by this data reader.
import ts from "typescript";
import { registerPortConstructor } from "./port-integrity.ts";
import { extractFunction } from "./source-extract.ts";
const names = [
  "routineRequestSourceSchema", "routineRequestEnvelopeSchema", "webhookRequestEnvelopeSchema",
  "ROUTINE_RESULT_PUBLICATION_WAIT_MS", "ROUTINE_WEEKDAY_NAMES", "AUTOMATION_PROPOSAL_REFUSED", "MAX_WORKSPACE_BOTS",
  "ASK_USER_REFUSED", "ASK_USER_SHOWN", "HOST_CONSENT_WAIT_MS", "ASK_BOT_TIMEOUT_MS", "ASK_ORIGIN_GRACE_MS",
  "UNATTENDED_TTL_MS", "GROUP_GOAL_COORDINATOR_GUARD_MS", "GROUP_GOAL_MAX_WAIT_EXHAUSTIONS", "IMAGES_NOT_SENT_RECORD_WAIT_MS",
  "TURN_REFUSAL_NOTES_MAX", "ROOM_LEDGER_REFUSAL_NOTES_MAX", "MEMORY_LINE_LATCH_MAX", "SCREEN_MIN_GAP_MS", "SCREEN_POLL_MS", "BROWSER_REVOCATION_RETRY_MS", "ROUTINE_REBUILD_STOPPED",
  "GROUP_GOAL_WAIT_MAX_MS", "IMAGE_PRESETS", "LEGACY_IMAGE_IDS", "AGENTS_NODE_FLAG",
  "signalCustodyHeld", "signalAuthorityReplayHeld",
  "TURN_STALL_MS", "TURN_HEARTBEAT_ONLY_MS", "MAX_GROUP_HOPS", "REQUEST_ENDED_LINE", "ROOM_TURN_REVOKED_BEFORE_DISPATCH",
  "OWNER_PENDING_HURRY_MS", "MURAGE_NOT_STARTED_LINE", "MURAGE_INTERNAL_CODES",
  "watchdog.stallMs", "watchdog.setupStallMs", "watchdog.heartbeatOnlyMs", "watchdog.checkMs",
  "repeats.thresholds", "repeats.maxKeysPerThread",
  "routines.catchUpStaggerMs", "routines.dispatchStaggerMs", "routines.maxConcurrentAutomaticRuns", "routines.automaticCapCeiling",
] as const;
const units = new Map<string,ReturnType<typeof extractFunction>>();
for (const name of names) {
  const inputs = name.startsWith("signal") ? ["signalParkVerdict"] : [];
  const unit = extractFunction({file:new URL("../index.ts",import.meta.url),select:source=>{
    const declarations = new Map<string,ts.Expression>();
    for (const statement of source.statements) if(ts.isVariableStatement(statement)) for(const declaration of statement.declarationList.declarations)
      if(ts.isIdentifier(declaration.name)&&declaration.initializer)declarations.set(declaration.name.text,declaration.initializer);
    const [root,property] = name.split(".");
    let expression = declarations.get(root);
    if(property && expression && (ts.isCallExpression(expression)||ts.isNewExpression(expression))) {
      const options = expression.arguments?.find(ts.isObjectLiteralExpression);
      const field = options?.properties.find(field=>ts.isPropertyAssignment(field)&&field.name.getText(source)===property);
      expression = field&&ts.isPropertyAssignment(field)?field.initializer:undefined;
    }
    if(!expression) throw new Error(`FIXTURE_SOURCE_DATA_MISSING ${name}`);
    const included = new Set<string>(), active = new Set<string>(), dependencies:string[]=[];
    const inspect = (node:ts.Node):void=>{
      // A Set of string literals (MURAGE_INTERNAL_CODES) is data: no call, no reference, nothing to run. Any other `new` stays refused.
      const literalSet=ts.isNewExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==="Set"&&!declarations.has("Set")&&node.arguments?.length===1
        &&ts.isArrayLiteralExpression(node.arguments[0]!)&&node.arguments[0].elements.every(element=>ts.isStringLiteral(element));
      if(literalSet)return;
      if(ts.isNewExpression(node)||ts.isAwaitExpression(node)||ts.isYieldExpression(node)||ts.isDeleteExpression(node)
        ||ts.isBinaryExpression(node)&&node.operatorToken.kind>=ts.SyntaxKind.FirstAssignment&&node.operatorToken.kind<=ts.SyntaxKind.LastAssignment)throw new Error(`FIXTURE_SOURCE_DATA_EFFECT ${name}`);
      if(ts.isCallExpression(node)) {
        const callee=node.expression.getText(source);
        if(!/^(?:Math\.(?:max|min|floor)|Number|availableParallelism|goalWaitMaxMs|Object\.freeze|z\.)/.test(callee)
          && !(ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==="map"))throw new Error(`FIXTURE_SOURCE_DATA_CALL ${name}: ${callee}`);
      }
      if(ts.isIdentifier(node)) {
        const parent=node.parent;
        const propertyName=(ts.isPropertyAccessExpression(parent)&&parent.name===node)||(ts.isPropertyAssignment(parent)&&parent.name===node);
        if(!propertyName&&!inputs.includes(node.text)&&declarations.has(node.text)&&!included.has(node.text)) {
          if(active.has(node.text))throw new Error(`FIXTURE_SOURCE_DATA_CYCLE ${name}`);
          active.add(node.text); inspect(declarations.get(node.text)!); active.delete(node.text);included.add(node.text);
          dependencies.push(`const ${node.text} = ${declarations.get(node.text)!.getText(source)};`);
        }
      }
      ts.forEachChild(node,inspect);
    };
    inspect(expression);
    return `(${inputs.join(",")}) => { ${dependencies.join("\n")} return (${expression.getText(source)}); }`;
  }});
  await unit.preload(); units.set(name,unit);
}
export function indexSourceData<T>(name: typeof names[number], ...inputs: unknown[]): T {
  const unit=units.get(name);
  if(!unit)throw new Error(`FIXTURE_SOURCE_DATA_MISSING ${name}`);
  const value=unit.preflightSync().value(...inputs) as T;
  // Zod's actual prototype accessor materializes a bound own method on its
  // first read. Do that inside this trusted constructor, before admission;
  // the integrity checker can then reject every later method replacement.
  if(value&&typeof value==="object"&&"_zod" in value)
    for(const method of ["parse","safeParse","parseAsync","safeParseAsync"] as const)Reflect.get(value,method,value);
  return value;
}

// Zod installs builder accessors on first construction. Prime the actual
// production schema kinds before recording their pristine prototypes, still
// before case hooks, rather than blessing a prototype during a test.
const schemaConstructors=new Set<Function>(),schemaObjects=new WeakSet<object>();
function schemaTypes(value:unknown):void {
  if(!value||typeof value!=="object"||schemaObjects.has(value))return;
  schemaObjects.add(value);
  const schema=value as {_zod?:unknown;def?:unknown;constructor:Function};
  if(schema._zod){schemaConstructors.add(schema.constructor);schemaTypes(schema.def);return;}
  if(Array.isArray(value)||Object.getPrototypeOf(value)===Object.prototype)for(const child of Object.values(value))schemaTypes(child);
}
for(const name of ["routineRequestSourceSchema","routineRequestEnvelopeSchema","webhookRequestEnvelopeSchema"] as const) schemaTypes(indexSourceData(name));
for(const Constructor of schemaConstructors)registerPortConstructor(Constructor);
