// Owner: sc-safety-rd (production dispatcher fixture completeness).
// Owner: index.ts authority owners (real declarations, imports and registration).
import { afterEach, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import ts from "typescript";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { ownToolGate } from "../outside-own.ts";
import { threadHumanPrincipal } from "../human-principals.ts";
import { consumingFixture, consumingResponseRecorder } from "./consuming-fixture.ts";
import { clearInternalAuthorityFixtures } from "./internal-authority-fixture.ts";
import { internalDispatchFixture, internalDispatchAuthorityFixture } from "./internal-dispatch-fixture.ts";

const fixtures: ReturnType<typeof consumingFixture>[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
  await clearInternalAuthorityFixtures();
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const fixture of fixtures.splice(0)) fixture.close();
});

it("H-SCOPE-1 production internal dispatcher preflights its complete real dependency closure", async () => {
  const f=consumingFixture(undefined,{empty:true,botId:"preflight-bot",threadId:"preflight-thread"}); fixtures.push(f);
  const {botId,threadId,dispatchGeneration:generation}=f.binding.identity;
  const capabilities=new InternalCapabilities(),humanPrincipal=threadHumanPrincipal(threadId,f.f.db);
  capabilities.begin(botId,threadId,generation,humanPrincipal);
  const token=capabilities.mint({botId,threadId,generation,humanPrincipal,kind:"agents",depth:0,skillAuthoring:false});
  const setup=await internalDispatchAuthorityFixture(f,capabilities);
  const plan=await internalDispatchFixture();

  // Prove the inspected closure contains the complete current production
  // branch, including every service path and the common admission checks.
  const file=new URL("../index.ts",import.meta.url);
  const source=ts.createSourceFile("index.ts",readFileSync(file,"utf8"),ts.ScriptTarget.Latest,true);
  let branch="";
  const visit=(node:ts.Node):void=>{
    if(ts.isIfStatement(node)&&node.expression.getText(source)==='path.startsWith("/api/internal/")')branch=node.thenStatement.getText(source);
    ts.forEachChild(node,visit);
  };
  visit(source);
  expect(branch.length).toBeGreaterThan(0);
  expect(plan.code).toContain(branch);

  const socket=new Socket();sockets.push(socket);
  const req=new IncomingMessage(socket);
  req.headers.authorization=`Bearer ${token}`;
  req.method="POST";req.url="/api/internal/agents";
  const response=consumingResponseRecorder();
  const scope:Record<string,unknown>={...(setup).scope,internalCapabilities:capabilities,req,res:response.raw,
    method:req.method,path:req.url,url:new URL(req.url,"http://fixture.invalid"),database:()=>f.f.db};
  // Let preflight demonstrate the actual import resolution, even though other
  // acceptance cases explicitly supply the identity-equal production import.
  delete scope.ownToolGate;
  await setup.dispatchAuthoritySetup.run(async()=>{
    const result=await plan.preflight(scope);
    const unresolved=[...result.free].filter(([name,resolution])=>resolution.step!=="declaration"&&!Object.hasOwn(result.bound,name));
    expect(unresolved).toEqual([]);
    expect(result.free.get("issueDecisionAuthority")?.step).toBe("declaration");
    expect(result.free.get("internalTurnOwners")?.step).toBe("state");
    expect(result.free.get("archivingBots")?.step).toBe("state");
    expect(result.free.get("ownToolGate")?.step).toBe("import");
    expect(result.bound.ownToolGate).toBe(ownToolGate);
    expect(capabilities.resolve(req.headers.authorization)).not.toBeNull();
    expect(response.output).toHaveLength(0);
  });
});
