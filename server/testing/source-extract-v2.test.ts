// Owner: sc-safety (fixture admission); production declarations retain their original owners.
import { expect, it, vi } from "vitest";
import { extractFunction } from "./source-extract.ts";
import { freshIndexPorts } from "./index-ports.ts";
import { ShellSessionRegistry } from "../shell-session-state.ts";
const file = new URL("../index.ts", import.meta.url);
it("H-SCOPE-4' no negative path can replace a resolved authority declaration", async () => {
  const unit = extractFunction({ file, text: 'function issueDecisionAuthority() { return "real"; } function selected() { return issueDecisionAuthority(); }', select: "selected" });
  await expect(unit.preflight({ issueDecisionAuthority: async () => ({}) })).rejects.toThrow("FIXTURE_OVERRIDE_REFUSED");
});
it("H-SCOPE-6 authority names outside the old regex are refused by resolved declaration", async () => {
  for (const [name, module] of [["partitionToolRefusal", "./shared-bots-roster.ts"], ["checkedOpenTurns", "./memory/lineage-write.ts"]]) {
    const unit = extractFunction({ file, text: `import { ${name} } from "${module}"; function selected() { return ${name}; }`, select: "selected" });
    await expect(unit.preflight({ [name]: () => undefined })).rejects.toThrow(/FIXTURE_OVERRIDE_REFUSED.*\.ts/);
  }
});
it("H-SCOPE-7 renamed imports and local aliases retain declaration identity", async () => {
  const text = 'import { partitionToolRefusal as ptr } from "./shared-bots-roster.ts"; const alias = ptr; function selected() { return alias; }';
  for (const name of ["ptr", "alias"]) {
    const unit = extractFunction({ file, text, select: "selected" });
    await expect(unit.preflight({ [name]: () => undefined })).rejects.toThrow(/FIXTURE_OVERRIDE_REFUSED.*shared-bots-roster/);
  }
});
it("H-SCOPE-8 namespace authority replacement is refused", async () => {
  const unit = extractFunction({ file, text: 'import * as roster from "./shared-bots-roster.ts"; function selected() { return roster.partitionToolRefusal; }', select: "selected" });
  await expect(unit.preflight({ roster: { partitionToolRefusal: () => undefined } })).rejects.toThrow("FIXTURE_OVERRIDE_REFUSED");
});
it("H-SCOPE-9 state ports cannot be replaced or reached through the returned binding", async () => {
  const unit = extractFunction({ file, text: 'const internalTurnOwners = new Map(); function selected() { return internalTurnOwners.size; }', select: "selected" });
  await expect(unit.preflight({ internalTurnOwners: new Map() }, { ports: freshIndexPorts() })).rejects.toThrow("FIXTURE_OVERRIDE_REFUSED");
  const result = await unit.preflight({}, { ports: freshIndexPorts() });
  expect(result.bound).not.toHaveProperty("internalTurnOwners");
  expect(unit.free.get("internalTurnOwners")).not.toHaveProperty("value");
});

it("H-SCOPE-9 integrity catches instance and shared-prototype method patches after a real writer", async () => {
  const {assertPortsPristine}=await import("./port-integrity.ts");
  const unit=extractFunction({file,text:'const owners=new Map(); function selected() { owners.set("real-writer",1); return owners; }',select:"selected"});
  const raw=new Map<string,number>();
  const result=await unit.preflight({}, {ports:[{name:"owners",fresh:()=>raw,reason:"Private state seeded by the selected real writer."}]});
  const owners:Map<string,number>=result.value();
  expect(owners.get("real-writer")).toBe(1);
  Object.defineProperty(raw,"get",{value:()=>9,configurable:true});
  try {expect(()=>assertPortsPristine()).toThrow("FIXTURE_PORT_TAMPERED");} finally {Reflect.deleteProperty(raw,"get");}
  const descriptor=Object.getOwnPropertyDescriptor(Map.prototype,"get")!;
  try {Object.defineProperty(Map.prototype,"get",{...descriptor,value:()=>undefined});expect(()=>assertPortsPristine()).toThrow("FIXTURE_PORT_TAMPERED");}
  finally {Object.defineProperty(Map.prototype,"get",descriptor);}
  expect(()=>assertPortsPristine()).not.toThrow();
});

it("H-SCOPE-7 declaration IDs survive local aliases and re-exports", async () => {
  const {resolveCaseDeclaration,declarationKey}=await import("./case-ports.ts");
  const ts=(await import("typescript")).default;
  const plain=ts.createSourceFile(new URL("../index.ts",import.meta.url).pathname,'import {partitionToolRefusal} from "./shared-bots-roster.ts";',99,true);
  const renamed=ts.createSourceFile(plain.fileName,'import {partitionToolRefusal as p} from "./shared-bots-roster.ts"; const alias=p;',99,true);
  const first=resolveCaseDeclaration(plain,"partitionToolRefusal"),second=resolveCaseDeclaration(renamed,"alias");
  expect(first?.file).toContain("shared-bots-roster.ts");
  expect(first?.start).toBeGreaterThan(0);
  expect(second).toEqual(first);
  expect(declarationKey(second!)).toBe(declarationKey(first!));
});

it("H-SCOPE-10 identical export observers work and post-bind or queued replacements never run", async () => {
  const {vi}=await import("vitest");
  const {showWidget}=await import("../chat-widgets.ts");
  const text='import {showWidget} from "./chat-widgets.ts"; function selected(...args) { return showWidget(...args); }';
  const refused=extractFunction({file,text,select:"selected"});
  await expect(refused.preflight({showWidget:vi.fn(()=>undefined)})).rejects.toThrow("FIXTURE_OVERRIDE_REFUSED");
  const queued=vi.fn(showWidget),fake=vi.fn();
  queued.mockImplementationOnce(fake);
  await expect(refused.preflight({showWidget:queued})).rejects.toThrow("FIXTURE_OVERRIDE_REFUSED");
  const observer=vi.fn(showWidget);
  const bound=await extractFunction({file,text,select:"selected"}).preflight({showWidget:observer});
  // Invalid widget input exercises the real parser without a storage effect.
  expect(bound.value({},"fixture",{})).toMatchObject({ok:false,status:400});
  expect(observer).toHaveBeenCalledOnce();
  expect(fake).not.toHaveBeenCalled();
  expect(()=>observer.mockImplementation(fake)).toThrow("FIXTURE_PORT_TAMPERED");
});

it("H-SCOPE-8 namespace lookup names its resolved module", async () => {
  const unit=extractFunction({file,text:'import * as roster from "./shared-bots-roster.ts"; function selected() { return roster.partitionToolRefusal; }',select:"selected"});
  await expect(unit.preflight({roster:{partitionToolRefusal:()=>undefined}})).rejects.toThrow(/FIXTURE_OVERRIDE_REFUSED.*shared-bots-roster\.ts/);
});

it("H-SCOPE-6 a purported state port cannot replace declaration or import code", async () => {
  const {vi}=await import("vitest");const forged=vi.fn();
  for(const text of ['function issueDecisionAuthority() {} function selected() { return issueDecisionAuthority(); }','import {partitionToolRefusal as issueDecisionAuthority} from "./shared-bots-roster.ts"; function selected() {return issueDecisionAuthority();}']) {
    const unit=extractFunction({file,text,select:"selected"});
    await expect(unit.preflight({}, {ports:[{name:"issueDecisionAuthority",fresh:()=>forged,reason:"Planted attempted authority override."}]})).rejects.toThrow("FIXTURE_OVERRIDE_REFUSED");
  }
  expect(forged).not.toHaveBeenCalled();
});

it("H-SCOPE-8 namespace members have the same declaration ID as a named import", async () => {
  const {resolveCaseDeclaration}=await import("./case-ports.ts");const ts=(await import("typescript")).default;
  const sf=ts.createSourceFile(new URL("../index.ts",import.meta.url).pathname,'import * as roster from "./shared-bots-roster.ts"; import {partitionToolRefusal as p} from "./shared-bots-roster.ts"; const namespaceAlias=roster; function selected(){return roster.partitionToolRefusal;}',99,true);
  const named=resolveCaseDeclaration(sf,"p");
  expect(named?.file).toContain("shared-bots-roster.ts");
  expect(resolveCaseDeclaration(sf,"roster.partitionToolRefusal")).toEqual(named);
  expect(resolveCaseDeclaration(sf,"namespaceAlias.partitionToolRefusal")).toEqual(named);
  expect(resolveCaseDeclaration(sf,"roster")).toEqual(named);
});

it("H-SCOPE-9 a shared prototype patch before binding is refused before the writer", async () => {
  const descriptor=Object.getOwnPropertyDescriptor(Map.prototype,"has")!;
  let failure:unknown;
  try {
    Object.defineProperty(Map.prototype,"has",{...descriptor,value:()=>false});
    const unit=extractFunction({file,text:'function selected(){return "writer";}',select:"selected"});
    try{await unit.preflight();}catch(error){failure=error;}
  } finally {Object.defineProperty(Map.prototype,"has",descriptor);}
  expect(String(failure)).toContain("FIXTURE_PORT_TAMPERED");
});

it("H-SCOPE-9 an I/O callback cannot patch and restore a collection method around a read", async () => {
  const {vi}=await import("vitest"),forged=vi.fn(()=>"forged");
  const descriptor=Object.getOwnPropertyDescriptor(Map.prototype,"get")!;
  const unit=extractFunction({file,text:'const owners=new Map(); function selected(){owners.set("real",1);return body(owners);}',select:"selected"});
  const bound=await unit.preflight({body:(owners:Map<string,number>)=>{
    Object.defineProperty(Map.prototype,"get",{...descriptor,value:forged});
    try{return owners.get("real");}finally{Object.defineProperty(Map.prototype,"get",descriptor);}
  }},{ports:[{name:"owners",fresh:()=>new Map(),reason:"Private real collection, seeded by the selected production writer."}]});
  expect(()=>bound.value()).toThrow("FIXTURE_PORT_TAMPERED");
  expect(forged).not.toHaveBeenCalled();
});

it("H-SCOPE-10 a captured mock setter cannot replace a bound observer", async () => {
  const {vi}=await import("vitest"),{showWidget}=await import("../chat-widgets.ts");
  const {assertPortsPristine}=await import("./port-integrity.ts");
  const observer=vi.fn(showWidget),replace=observer.mockImplementation,fake=vi.fn();
  const unit=extractFunction({file,text:'import {showWidget} from "./chat-widgets.ts";function selected(...args){return showWidget(...args);}',select:"selected"});
  const bound=await unit.preflight({showWidget:observer});
  replace(fake);
  try {
    expect(()=>assertPortsPristine()).toThrow("FIXTURE_PORT_TAMPERED");
    expect(()=>bound.value({},"fixture",{})).toThrow("FIXTURE_PORT_TAMPERED");
    expect(fake).not.toHaveBeenCalled();
  }finally{replace(showWidget);}
});

it("H-SCOPE-9 collections start with their real constructor and no own method patches", async () => {
  const {vi}=await import("vitest"),forged=vi.fn();
  for(const fresh of [()=>Object.assign(new Map(),{get:forged}),()=>({get:forged,size:0})]) {
    const unit=extractFunction({file,text:'const owners=new Map();function selected(){return owners.get("row");}',select:"selected"});
    await expect(unit.preflight({}, {ports:[{name:"owners",fresh,reason:"Planted counterfeit collection."}]})).rejects.toThrow("FIXTURE_PORT_TAMPERED");
  }
  expect(forged).not.toHaveBeenCalled();
});

it("H-SCOPE-6 even an identity-equal authority import needs a declared case port", async () => {
  const {ownToolGate}=await import("../outside-own.ts");
  const unit=extractFunction({file,text:'import {ownToolGate} from "./outside-own.ts";function selected(){return ownToolGate;}',select:"selected"});
  await expect(unit.preflight({ownToolGate})).rejects.toThrow("FIXTURE_OVERRIDE_REFUSED");
  const real=await unit.preflight({});
  expect(real.value()).toBe(ownToolGate);
});

it("H-SCOPE-6 a DATA Store cannot bring a patched authorization reader", async () => {
  const {realStore}=await import("./index-ports.ts"),{vi}=await import("vitest");
  const unit=extractFunction({file,select:()=>"() => store.bot('fixture')"});
  const safe=await unit.preflight({store:realStore()});
  expect(safe.value).toBeTypeOf("function");
  const forged=realStore(),reader=vi.fn();
  Object.defineProperty(forged,"bot",{value:reader,configurable:true});
  await expect(unit.preflight({store:forged})).rejects.toThrow("FIXTURE_OVERRIDE_REFUSED");
  expect(reader).not.toHaveBeenCalled();
});

it("H-SCOPE-6 unused unreviewed case keys are refused rather than silently admitted", async () => {
  const unit=extractFunction({file,text:'function selected(){return "real";}',select:"selected"});
  await expect(unit.preflight({unusedAuthority:()=>"forged"})).rejects.toThrow("FIXTURE_OVERRIDE_REFUSED unusedAuthority");
  expect((await unit.preflight({})).value()).toBe("real");
});

it("H-SCOPE-6 a legacy dispatcher registry cannot manufacture a real claim", async () => {
  const {bindInternalDispatch}=await import("./internal-authority-fixture.ts"),{vi}=await import("vitest");
  const resolve=vi.fn(()=>({botId:"fixture",threadId:"fixture",generation:"fixture"}));
  await expect(bindInternalDispatch({expression:"async () => {}",scope:{internalCapabilities:{resolve},req:{headers:{authorization:"Bearer fixture"}}}})).rejects.toThrow("FIXTURE_OVERRIDE_REFUSED internalCapabilities");
  expect(resolve).not.toHaveBeenCalled();
});

it("H-SCOPE-6 DATA getters cannot substitute authorization and fabricated setup cannot bypass preflight", async () => {
  const {realStore}=await import("./index-ports.ts"),{vi}=await import("vitest");
  const {bindInternalDispatch}=await import("./internal-authority-fixture.ts");
  const forged=vi.fn(),store=realStore();
  Object.defineProperty(store,"bot",{get:forged,configurable:true});
  const unit=extractFunction({file,select:()=>"() => store.bot('fixture')"});
  await expect(unit.preflight({store})).rejects.toThrow("FIXTURE_OVERRIDE_REFUSED");
  await expect(bindInternalDispatch({expression:"async () => {}",scope:{dispatchAuthoritySetup:{bind:forged}}})).rejects.toThrow("FIXTURE_OVERRIDE_REFUSED dispatchAuthoritySetup");
  expect(forged).not.toHaveBeenCalled();
});

it("H-SCOPE-7 every admitted case port names a real declaration offset", async () => {
  const {CASE_PORTS}=await import("./case-ports.ts");
  for(const port of CASE_PORTS){expect(port.declaration.start).toBeGreaterThanOrEqual(0);expect(port.declaration.line).toBeGreaterThan(0);}
});

it("H-SCOPE-6 the legacy dispatcher also validates an existing DATA Store", async () => {
  const {realStore}=await import("./index-ports.ts"),{vi}=await import("vitest");
  const {bindInternalDispatch}=await import("./internal-authority-fixture.ts");
  const store=realStore(),forged=vi.fn();
  Object.defineProperty(store,"bot",{value:forged,configurable:true});
  await expect(bindInternalDispatch({expression:"async () => {}",scope:{store}})).rejects.toThrow("FIXTURE_OVERRIDE_REFUSED store");
  expect(forged).not.toHaveBeenCalled();
});

it("H-SCOPE-10 arbitrary or copied StatePorts cannot supply production authority", async () => {
  const {vi}=await import("vitest");
  const forged=vi.fn(()=>true),fresh=vi.fn(()=>({resolve:forged}));
  const unit=extractFunction({file,select:()=>"() => internalCapabilities.resolve(undefined)"});
  await expect(unit.preflight({}, {ports:[{name:"internalCapabilities",fresh,reason:"Untrusted attempted service injection."}]})).rejects.toThrow(/FIXTURE_STATE_PORT_REFUSED internalCapabilities/);
  const real=freshIndexPorts().find(port=>port.name==="internalCapabilities")!;
  await expect(unit.preflight({}, {ports:[{...real,fresh}]})).rejects.toThrow(/FIXTURE_STATE_PORT_REFUSED internalCapabilities/);
  expect(fresh).not.toHaveBeenCalled();expect(forged).not.toHaveBeenCalled();
  const control=await unit.preflight({}, {ports:freshIndexPorts()});
  expect(control.value()).toBeNull();
});
it("H-SCOPE-10 a prepatched service prototype is refused before its first tracking", async () => {
  const {ToolResults}=await import("../tool-results.ts"),{vi}=await import("vitest");
  const original=Object.getOwnPropertyDescriptor(ToolResults.prototype,"save")!,forged=vi.fn();
  try {
    Object.defineProperty(ToolResults.prototype,"save",{...original,value:forged});
    const unit=extractFunction({file,select:()=>"() => toolResults.save({}, 'fixture', false)"});
    await expect(unit.preflight({}, {ports:freshIndexPorts()})).rejects.toThrow("FIXTURE_PORT_TAMPERED");
    expect(forged).not.toHaveBeenCalled();
  } finally {Object.defineProperty(ToolResults.prototype,"save",original);}
});
it("H-SCOPE-10 JSON cannot replace the production redaction and provenance writer", async () => {
  const {indexCallbackFixture}=await import("./internal-dispatch-fixture.ts"),{vi}=await import("vitest");
  const forged=vi.fn();
  await expect(indexCallbackFixture("configureBotEgress",{json:forged})).rejects.toThrow(/FIXTURE_OVERRIDE_REFUSED json .*index\.ts:\d+/);
  expect(forged).not.toHaveBeenCalled();
});
it("H-SCOPE-8 builtin aliases resolve to their external declaration", async () => {
  const {resolveCaseDeclaration,declarationKey}=await import("./case-ports.ts"),ts=(await import("typescript")).default;
  const source=ts.createSourceFile(file.pathname,'import {readFileSync as read} from "node:fs"; import * as disk from "node:fs"; const alias=read;',ts.ScriptTarget.Latest,true);
  const named=resolveCaseDeclaration(source,"read")!,namespace=resolveCaseDeclaration(source,"disk.readFileSync")!,alias=resolveCaseDeclaration(source,"alias")!;
  expect(named.file).toMatch(/@types\/node\/fs\.d\.ts$/);
  expect(named.start).toBeGreaterThan(0);
  expect(declarationKey(named)).toBe(declarationKey(namespace));expect(declarationKey(named)).toBe(declarationKey(alias));
});
it("H-SCOPE-10 a formatter observer requires an actual extracted declaration", async () => {
  const {vi}=await import("vitest");
  const real=(await extractFunction({file,select:"routineTimestamp"}).preflight()).value;
  const unit=extractFunction({file,select:()=>"(value) => routineTimestamp(value)"});
  const forged=vi.fn(()=>"forged");
  await expect(unit.preflight({routineTimestamp:forged})).rejects.toThrow("FIXTURE_OVERRIDE_REFUSED");
  expect(forged).not.toHaveBeenCalled();
  const observer=vi.fn(real),control=await unit.preflight({routineTimestamp:observer});
  expect(control.value(0)).toBe("1970-01-01T00:00:00.000Z");
  expect(observer).toHaveBeenCalledExactlyOnceWith(0);
});

it("H-SCOPE-10 an exported singleton own-method patch cannot become its first baseline", async () => {
  const {ioBudget}=await import("../io-budget.ts"),{vi}=await import("vitest");
  const prior=Object.getOwnPropertyDescriptor(ioBudget,"shouldDefer"),forged=vi.fn(()=>false);
  const unit=extractFunction({file,select:()=>"() => ioBudget.shouldDefer('fixture')"});
  try {
    Object.defineProperty(ioBudget,"shouldDefer",{value:forged,configurable:true});
    await expect(unit.preflight()).rejects.toThrow("FIXTURE_PORT_TAMPERED");
    expect(forged).not.toHaveBeenCalled();
  } finally {
    if(prior)Object.defineProperty(ioBudget,"shouldDefer",prior);
    else Reflect.deleteProperty(ioBudget,"shouldDefer");
  }
  const control=await unit.preflight();
  expect(typeof control.value()).toBe("boolean");
});

it("H-SCOPE-10 a binding keeps its integrity scope when called from another binding", async () => {
  const {vi}=await import("vitest");
  const owners=new Map([["real","real"]]),forged=vi.fn(()=>"forged");
  const first=await extractFunction({file,text:'const owners=new Map(); function selected(){return owners.get("real");}',select:"selected"})
    .preflight({}, {ports:[{name:"owners",fresh:()=>owners,reason:"Private synthetic collection for cross-binding integrity."}]});
  const second=await extractFunction({file,text:'function selected(){return body();}',select:"selected"})
    .preflight({body:()=>first.value()});
  Object.defineProperty(owners,"get",{value:forged,configurable:true});
  try {
    expect(()=>second.value()).toThrow("FIXTURE_PORT_TAMPERED");
    expect(forged).not.toHaveBeenCalled();
  } finally {Reflect.deleteProperty(owners,"get");}
  expect(second.value()).toBe("real");
});
it("H-SCOPE-10 integrity scopes expose no records and cannot be forged", async () => {
  const {withinPortScope,currentPortScope}=await import("./port-integrity.ts"),{vi}=await import("vitest");
  const forged=vi.fn();
  withinPortScope(()=>{
    const token=currentPortScope()!;
    expect(Object.isFrozen(token)).toBe(true);
    expect(Reflect.ownKeys(token)).toEqual([]);
    expect(Object.getPrototypeOf(token)).toBeNull();
  });
  expect(()=>withinPortScope(forged,{})).toThrow("FIXTURE_PORT_SCOPE_REFUSED");
  expect(forged).not.toHaveBeenCalled();
});

it("H-SCOPE-10 private service observations preserve real calls without exposing a receiver", async () => {
  const {fixtureObservers,bindInternalDispatch}=await import("./internal-authority-fixture.ts");
  const observations=fixtureObservers(["sharedOwnerUsage.begin"]);
  const bound=await bindInternalDispatch({expression:'async () => { sharedOwnerUsage.begin("fixture",{generation:"fixture-generation",botId:"fixture-bot",teamId:"fixture-team",messageId:"fixture-message",engine:"fixture",startedAt:1,ownerWaitMs:0,asks:new Set()}); }',scope:{fixtureObservers:observations}});
  const observed=observations.spy("sharedOwnerUsage.begin");
  expect(observed).not.toHaveBeenCalled();
  await bound.dispatch();
  expect(observed).toHaveBeenCalledExactlyOnceWith("fixture",expect.objectContaining({generation:"fixture-generation"}));
  expect(observed.mock.results[0]).toEqual({type:"return",value:undefined});
  expect(()=>observed()).toThrow("FIXTURE_OBSERVER_READ_ONLY");
  expect(()=>observed.mock.contexts).toThrow("FIXTURE_OBSERVER_PRIVATE_RECEIVER");
  expect(observed.getMockImplementation()).toBeUndefined();
  expect(()=>Reflect.apply(Array.prototype.push,observed.mock.calls,[[]])).toThrow();
  expect(observed).toHaveBeenCalledOnce();
});
it("H-SCOPE-10 copied observation plans are refused before their body", async () => {
  const {fixtureObservers,bindInternalDispatch}=await import("./internal-authority-fixture.ts"),{vi}=await import("vitest");
  const observations=fixtureObservers(["botCalls.fact"]),body=vi.fn();
  await expect(bindInternalDispatch({expression:"async () => body()",scope:{fixtureObservers:{...observations},body}})).rejects.toThrow("FIXTURE_OVERRIDE_REFUSED fixtureObservers");
  expect(body).not.toHaveBeenCalled();
});

it("H-SCOPE-10 returned declaration references retain origin but local shadows never do", async () => {
  const {vi}=await import("vitest"),forged=vi.fn(()=>"forged");
  const consumer=extractFunction({file,select:()=>"(value) => routineTimestamp(value)"});
  const shadow=await extractFunction({file,select:()=>"(() => { const routineTimestamp=() => body(); return {routineTimestamp}; })()",include:["routineTimestamp"]}).preflight({body:forged});
  await expect(consumer.preflight({routineTimestamp:vi.fn(shadow.value.routineTimestamp)})).rejects.toThrow("FIXTURE_OVERRIDE_REFUSED");
  expect(forged).not.toHaveBeenCalled();
  const control=await extractFunction({file,select:()=>"({routineTimestamp})"}).preflight();
  const bound=await consumer.preflight({routineTimestamp:vi.fn(control.value.routineTimestamp)});
  expect(bound.value(0)).toBe("1970-01-01T00:00:00.000Z");
});

it("H-SCOPE-6 legacy dispatch and callback entry points refuse unused authority overrides",async()=>{
  const {vi}=await import("vitest"),forged=vi.fn(),body=vi.fn();
  const {bindInternalDispatch}=await import("./internal-authority-fixture.ts");
  const {completeIndexCallbackFixture}=await import("./internal-dispatch-fixture.ts");
  const ts=(await import("typescript")).default,{readFileSync}=await import("node:fs");
  const source=ts.createSourceFile("index.ts",readFileSync(file,"utf8"),ts.ScriptTarget.Latest,true);
  await expect(bindInternalDispatch({expression:"async () => {}",scope:{issueDecisionAuthority:forged},source})).rejects.toThrow(/FIXTURE_OVERRIDE_REFUSED issueDecisionAuthority.*index.ts:[0-9]+/);
  await expect(completeIndexCallbackFixture("() => 1",{issueDecisionAuthority:forged},source)).rejects.toThrow(/FIXTURE_OVERRIDE_REFUSED issueDecisionAuthority/);
  await expect(bindInternalDispatch({expression:"async () => {}",scope:{dispatchAuthoritySetup:{bind:body}},source})).rejects.toThrow("FIXTURE_OVERRIDE_REFUSED dispatchAuthoritySetup");
  expect(forged).not.toHaveBeenCalled();expect(body).not.toHaveBeenCalled();
});

it("H-SCOPE-10 dynamic imports resolve real modules without importing the server bootstrap",async()=>{
  const unit=extractFunction({file,text:'async function selected(){return (await import("./service-no-limits.ts")).serviceNoLimits("missing","missing","missing");}',select:"selected"});
  const bound=await unit.preflight();await expect(bound.value()).resolves.toBe(false);
  const bootstrap=await extractFunction({file,text:'function selected(){return import("./index.ts");}',select:"selected"}).preflight();
  await expect(bootstrap.value()).rejects.toThrow("FIXTURE_IMPORT_PORT_REQUIRED index.ts");
});

it("H-SCOPE-10 absolute and query spellings cannot import the server bootstrap",async()=>{
  for(const specifier of [new URL("../index.ts",import.meta.url).pathname,new URL("../index.ts",import.meta.url).href+"?bootstrap"]) {
    const bound=await extractFunction({file,text:`function selected(){return import(${JSON.stringify(specifier)});}`,select:"selected"}).preflight();
    await expect(bound.value()).rejects.toThrow("FIXTURE_IMPORT_PORT_REQUIRED index.ts");
  }
});

it("H-SCOPE-10 one real observer retains its lock across multiple bindings",async()=>{
  const {vi}=await import("vitest"),{showWidget}=await import("../chat-widgets.ts");
  const observer=vi.fn(showWidget),forged=vi.fn();
  const unit=extractFunction({file,text:'import {showWidget} from "./chat-widgets.ts"; function selected(...args){return showWidget(...args);}',select:"selected"});
  const first=await unit.preflight({showWidget:observer}),second=await unit.preflight({showWidget:observer});
  expect(first.value({},"fixture",{})).toMatchObject({ok:false,status:400});
  expect(second.value({},"fixture",{})).toMatchObject({ok:false,status:400});
  expect(observer).toHaveBeenCalledTimes(2);
  expect(()=>observer.mockImplementationOnce(forged)).toThrow("FIXTURE_PORT_TAMPERED");
  expect(forged).not.toHaveBeenCalled();
});

it("H-SCOPE-10 source observers cannot borrow another fixture's private state",async()=>{
  const {bindInternalDispatch}=await import("./internal-authority-fixture.ts"),{vi}=await import("vitest");
  const first=await bindInternalDispatch({expression:"async () => {}",scope:{},expose:["venuePostStored"]});
  const observer=vi.fn(first.unit.venuePostStored);
  const same=await bindInternalDispatch({expression:'async () => venuePostStored("fixture","missing")',scope:{venuePostStored:observer},parent:first});
  expect(same.unit).toBeDefined();
  const second=await bindInternalDispatch({expression:"async () => {}",scope:{}});
  await expect(bindInternalDispatch({expression:'async () => venuePostStored("fixture","missing")',scope:{venuePostStored:observer},parent:second})).rejects.toThrow("FIXTURE_OVERRIDE_REFUSED venuePostStored");
  expect(observer).not.toHaveBeenCalled();
});


it("H-SCOPE-10 real schema methods materialize before integrity admission",async()=>{
  const {indexSourceData}=await import("./internal-source-data.ts"),{trackPort,protectPort}=await import("./port-integrity.ts"),{vi}=await import("vitest");
  const schema=indexSourceData<import("zod").ZodType>("routineRequestEnvelopeSchema");
  trackPort("fixture-schema",schema,true);const guarded=protectPort(schema);
  expect(guarded.safeParse({action:"create",fromBotId:"fixture",fromThreadId:"fixture",routine:{}}).success).toBe(true);
  expect(guarded.safeParse({action:"unknown"}).success).toBe(false);
  const original=Object.getOwnPropertyDescriptor(schema,"safeParse")!,forged=vi.fn(()=>({success:true,data:{}}));
  try {
    Object.defineProperty(schema,"safeParse",{...original,value:forged});
    expect(()=>guarded.safeParse({action:"unknown"})).toThrow("FIXTURE_PORT_TAMPERED");
    expect(forged).not.toHaveBeenCalled();
  } finally {Object.defineProperty(schema,"safeParse",original);}
});


it("H-SCOPE-6 Store roster and revision accessors are refused without executing them",async()=>{
  const {realStore}=await import("./index-ports.ts"),{vi}=await import("vitest");
  for(const key of ["bots","memoryRosterRevision"] as const) {
    const store=realStore(),forged=vi.fn();
    Object.defineProperty(store,key,{get:forged,configurable:true});
    await expect(extractFunction({file,select:()=>"() => store.bots"}).preflight({store})).rejects.toThrow("FIXTURE_OVERRIDE_REFUSED store");
    expect(forged).not.toHaveBeenCalled();
  }
});


it("H-SCOPE-9 deferred construction keeps private ports private and rejects forged production recipes",async()=>{
  const {vi}=await import("vitest"),fresh=vi.fn(()=>new Map([["fixture",7]]));
  const synthetic=extractFunction({file,text:'const owners=new Map(); function selected(){return owners.get("fixture");}',select:"selected"});
  const bound=await synthetic.preflight({}, {ports:[{name:"owners",fresh,defer:true,reason:"Synthetic constructor timing control."}]});
  expect(fresh).not.toHaveBeenCalled();expect(Object.hasOwn(bound.bound,"owners")).toBe(false);
  expect(bound.value()).toBe(7);expect(bound.value()).toBe(7);expect(fresh).toHaveBeenCalledOnce();
  const forged=vi.fn(()=>({resolve:()=>true}));
  await expect(extractFunction({file,select:()=>"() => internalCapabilities.resolve(undefined)"}).preflight({}, {ports:[{name:"internalCapabilities",fresh:forged,defer:true,reason:"Untrusted deferred recipe."}]})).rejects.toThrow("FIXTURE_STATE_PORT_REFUSED");
  expect(forged).not.toHaveBeenCalled();
});

it("H-SCOPE-6 a real mail runtime cannot carry a caller's restore predicate",async()=>{
  const {EmailRuntime}=await import("../email/runtime.ts"),{bindInternalDispatch}=await import("./internal-authority-fixture.ts"),{vi}=await import("vitest");
  const forged=vi.fn(()=>false),runtime=new EmailRuntime({accountKey:()=>null,database:()=>{throw new Error("unreached mail I/O");},transaction:work=>work(),workspaceRoot:()=>undefined,bot:()=>undefined,restoreWindow:forged});
  try {
    await expect(bindInternalDispatch({expression:"async () => {}",scope:{emailRuntime:runtime}})).rejects.toThrow("FIXTURE_OVERRIDE_REFUSED emailRuntime");
    expect(forged).not.toHaveBeenCalled();
  } finally {runtime.stop();}
});

it("H-SCOPE-9 cached declaration plans admit current DATA without retaining old values",async()=>{
  const unit=extractFunction({file,select:()=>"() => cfg.features.skillRecorder"});
  const first=await unit.preflight({cfg:{features:{skillRecorder:true}}});
  expect(first.value()).toBe(true);
  const forged=vi.fn(()=>true);
  await expect(unit.preflight({cfg:{features:{skillRecorder:forged}}})).rejects.toThrow("FIXTURE_OVERRIDE_REFUSED");
  expect(forged).not.toHaveBeenCalled();
  const next=await unit.preflight({cfg:{features:{skillRecorder:false}}});
  expect(next.value()).toBe(false);expect(first.value()).toBe(true);
});
it("H-SCOPE-9 cached declaration plans still refuse a forged factory with identical port names",async()=>{
  const {freshIndexPorts}=await import("./index-ports.ts");
  const unit=extractFunction({file,select:()=>"() => internalCapabilities.resolve(undefined)"});
  const ports=freshIndexPorts(),first=await unit.preflight({}, {ports});
  expect(first.value()).toBeNull();
  const forged=vi.fn(()=>({resolve:()=>true}));
  await expect(unit.preflight({}, {ports:ports.map(port=>port.name==="internalCapabilities"?{...port,fresh:forged}:port)})).rejects.toThrow("FIXTURE_STATE_PORT_REFUSED");
  expect(forged).not.toHaveBeenCalled();
});

it("H-SCOPE-9 source text cache detects same-size edits even when mtime is restored",async()=>{
  const {mkdtempSync,writeFileSync,statSync,utimesSync}=await import("node:fs");
  const {join}=await import("node:path"),{tmpdir}=await import("node:os");
  const {removeTempDir}=await import("./cleanup.ts");
  const directory=mkdtempSync(join(tmpdir(),"source-cache-")),file=join(directory,"source.ts");
  try {
    writeFileSync(file,'function selected(){return "first";}');
    const originalTime=new Date("2024-01-01T00:00:00.000Z");utimesSync(file,originalTime,originalTime);
    const before=statSync(file,{bigint:true});
    expect((await extractFunction({file,select:"selected"}).preflight()).value()).toBe("first");
    writeFileSync(file,'function selected(){return "other";}');
    utimesSync(file,before.atime,before.mtime);
    expect(statSync(file,{bigint:true}).size).toBe(before.size);
    expect(statSync(file,{bigint:true}).mtimeNs).toBe(before.mtimeNs);
    expect((await extractFunction({file,select:"selected"}).preflight()).value()).toBe("other");
  }finally {removeTempDir(directory);}
});


it.each([
  ["shellSessions", ShellSessionRegistry], ["roomStopRequests", Map],
  ["ledgerLeasesByAdmission", WeakMap], ["ledgerProviderInstances", WeakMap],
  ["recallWaits", Map], ["directTurnCancellationProofs", Map],
] as const)("H-SCOPE-TRAIN %s binds fresh real state through dispatch preflight", async (name, Constructor) => {
  const { bindInternalDispatch, clearInternalAuthorityFixtures } = await import("./internal-authority-fixture.ts");
  try {
    const first = await bindInternalDispatch({ expression: `async () => ${name}`, scope: {} });
    const value = await first.dispatch();
    expect(value).toBeInstanceOf(Constructor);
    const second = await bindInternalDispatch({ expression: `async () => ${name}`, scope: {} });
    expect(await second.dispatch()).not.toBe(value);
  } finally { await clearInternalAuthorityFixtures(); }
});

// design1019-approval-attention (attniso-race fix): the module-level approvalAttention has a state port, so every
// bindInternalDispatch user (internal-response-fence and the other fixture users) resolves it to a fresh real service.
it("H-SCOPE-ATTENTION approvalAttention binds a fresh real attention service through dispatch preflight", async () => {
  const { bindInternalDispatch, clearInternalAuthorityFixtures } = await import("./internal-authority-fixture.ts");
  try {
    const first = await bindInternalDispatch({ expression: "async () => approvalAttention", scope: {} });
    const value = await first.dispatch() as unknown as { admit(thread: string, generation: string): unknown; scopeOf(thread: string, generation: string): unknown; stats(): { scopes: number } };
    expect(value.stats().scopes).toBe(0);
    const scope = value.admit("fixture-thread", "fixture-generation");
    expect(value.scopeOf("fixture-thread", "fixture-generation")).toBe(scope);
    expect(value.stats().scopes).toBe(1);
    const second = await bindInternalDispatch({ expression: "async () => approvalAttention", scope: {} });
    const fresh = await second.dispatch() as unknown as typeof value;
    expect(fresh).not.toBe(value);
    expect(fresh.stats().scopes).toBe(0);
  } finally { await clearInternalAuthorityFixtures(); }
});
