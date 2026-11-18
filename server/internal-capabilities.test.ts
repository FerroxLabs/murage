import "../scripts/test-truth-intended-assertion.test-helper.mjs";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import ts from "typescript";
import vm from "node:vm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InternalCapabilities, requiredInternalKind, type InternalCapabilityKind } from "./internal-capabilities.ts";

function mint(registry: InternalCapabilities, threadId = "thread", generation = "generation", kind: InternalCapabilityKind = "agents") {
  const token = registry.mint({ botId: "bot", threadId, generation, kind, depth: 0, skillAuthoring: false });
  return { token, claim: registry.resolve(`Bearer ${token}`)! };
}

describe("internal turn capabilities", () => {
  it.each(['generation','thread','bot','all','replacement','completion','expiry'])("releases deduplicated memory view leases on %s", ending => {
    let now=1, acquired=0, released=0;
    const registry=new InternalCapabilities({now:()=>now,orphanMs:10});
    registry.begin('bot','thread','generation');
    const {claim}=mint(registry,'thread','generation','memory');
    const retain=()=>{acquired++;return ()=>{released++;};};
    registry.retainMemoryView(claim,'view',retain);
    registry.retainMemoryView(claim,'view',retain);
    registry.retainMemoryView(claim,'other-view',retain);
    expect(acquired).toBe(2);
    if(ending==='generation')registry.revokeGeneration('thread','generation');
    if(ending==='thread')registry.revokeThread('thread');
    if(ending==='bot')registry.revokeBot('bot');
    if(ending==='all')registry.revokeAll();
    if(ending==='replacement')registry.begin('bot','thread','replacement');
    if(ending==='completion'){registry.bindProviderTurn('thread','generation','provider');registry.completeProviderTurn('thread','provider');}
    if(ending==='expiry'){now=11;expect(registry.isActive(claim)).toBe(false);}
    expect(released).toBe(2);
    expect(()=>registry.retainMemoryView(claim,'view',retain)).toThrow('MEMORY_UNAUTHORIZED');
    registry.revokeAll();
    expect(released).toBe(2);
  });

  it.each(['expiry','generation'])("keeps at most 128 memory view leases per claim, so %s teardown walks a bounded set", ending => {
    let now=1, acquired=0, released=0;
    const registry=new InternalCapabilities({now:()=>now,orphanMs:10});
    registry.begin('bot','thread','generation');
    const {claim}=mint(registry,'thread','generation','memory');
    const releasedKeys:number[]=[];
    for(let i=0;i<300;i++)registry.retainMemoryView(claim,`view-${i}`,()=>{acquired++;return ()=>{released++;releasedKeys.push(i);};});
    // The oldest leases were released as newer ones arrived: 300 retained, 128 held.
    expect(acquired).toBe(300);
    expect(released).toBe(172);
    expect(releasedKeys).toEqual(Array.from({length:172},(_,i)=>i));
    if(ending==='expiry'){now=11;expect(registry.isActive(claim)).toBe(false);}
    else registry.revokeGeneration('thread','generation');
    // Teardown released exactly the 128 still held; none twice.
    expect(released).toBe(300);
    expect(new Set(releasedKeys).size).toBe(300);
  });

  it.each(['return','throw','abort'])("turn finally releases memory readers on %s", async ending => {
    const registry=new InternalCapabilities();registry.begin('bot','thread','generation');
    const {claim}=mint(registry,'thread','generation','memory');
    let released=0;
    registry.retainMemoryView(claim,'view',()=>()=>{released++;});
    registry.bindProviderTurn('thread','generation','provider');
    const source=readFileSync(new URL('./index.ts',import.meta.url),'utf8');
    const ast=ts.createSourceFile('index.ts',source,ts.ScriptTarget.Latest,true);
    const candidates:ts.TryStatement[]=[];
    const visit=(node:ts.Node)=>{
      if(ts.isTryStatement(node)&&node.finallyBlock?.getText(ast).includes('internalCapabilities.completeProviderTurn(event.threadId, event.turnId)'))candidates.push(node);
      ts.forEachChild(node,visit);
    };
    visit(ast);
    const terminal=candidates.sort((a,b)=>a.getWidth(ast)-b.getWidth(ast))[0]?.finallyBlock;
    expect(terminal).toBeDefined();
    const context=vm.createContext({internalCapabilities:registry,internalTurnOwners:new Map([['thread',{generation:'generation'}]]),
      pendingRoomStop:undefined,terminalLease:{identity:{dispatchGeneration:'generation'}},console,queueMicrotask});
    vm.runInContext(ts.transpileModule(`globalThis.finalize=event=>{${terminal!.getText(ast)}}`,{compilerOptions:{target:ts.ScriptTarget.ES2023}}).outputText,context);
    context.finalize({threadId:'thread',turnId:'provider',type:ending==='abort'?'session.exited':'turn.completed',ok:ending==='return'});
    expect(registry.isActive(claim)).toBe(false);
    expect(released).toBe(1);
  });

  it("returns immutable exact claims and rejects malformed bearers and forged objects", () => {
    const registry = new InternalCapabilities();
    registry.begin("bot", "thread", "generation");
    const { token, claim } = mint(registry);
    expect(Object.isFrozen(claim)).toBe(true);
    expect(registry.resolve(`Bearer ${token}`)).toBe(claim);
    expect(registry.isActive({ ...claim })).toBe(false);
    for (const header of [undefined, [token], token, `bearer ${token}`, `Bearer ${token} `, `Bearer ${"0".repeat(48)}`]) {
      expect(registry.resolve(header)).toBeNull();
    }
    expect(() => registry.mint({ ...claim, botId: "other" })).toThrow();
    expect(() => registry.mint({ ...claim, depth: -1 })).toThrow();
    expect(() => registry.mint({ ...claim, depth: 0.5 })).toThrow();
  });

  it("expires claims and pending reservations using its injected clock", () => {
    let now = 1;
    const registry = new InternalCapabilities({ now: () => now, orphanMs: 10 });
    registry.begin("bot", "thread", "generation");
    const { token, claim } = mint(registry);
    const reservation = registry.reserve(claim, "create")!;
    now = 11;
    expect(registry.isActive(claim)).toBe(false);
    expect(registry.resolve(`Bearer ${token}`)).toBeNull();
    expect(reservation.commit()).toBe(false);
  });

  it("a second generation that re-binds an already bound provider turn is named for that turn (104 P7)", () => {
    const registry = new InternalCapabilities();
    registry.begin("bot", "thread", "first");
    expect(registry.bindProviderTurn("thread", "first", "provider-turn")).toBe(true);
    registry.begin("bot", "thread", "second");
    expect(registry.bindProviderTurn("thread", "second", "provider-turn")).toBe(true);
    expect(registry.providerTurnOf("thread", "first")).toBe("provider-turn");
    expect(registry.providerTurnOf("thread", "second")).toBe("provider-turn");
    expect(registry.dispatchingGeneration("thread", "provider-turn")).toBe("first");
  });

  it("refuses terminal-before-bind and distinguishes identical turn ids in different threads", () => {
    const registry = new InternalCapabilities();
    registry.begin("bot", "thread", "generation");
    const first = mint(registry);
    registry.completeProviderTurn("other-thread", "provider-turn");
    expect(registry.bindProviderTurn("thread", "generation", "provider-turn")).toBe(true);
    expect(registry.isActive(first.claim)).toBe(true);
    registry.completeProviderTurn("thread", "provider-turn");
    expect(registry.isActive(first.claim)).toBe(false);
    registry.begin("bot", "thread", "next");
    const next = mint(registry, "thread", "next");
    registry.completeProviderTurn("thread", "fast-turn");
    expect(registry.bindProviderTurn("thread", "next", "fast-turn")).toBe(false);
    expect(registry.isActive(next.claim)).toBe(false);
  });

  it("remembers which generation dispatched a provider turn after that generation is revoked", () => {
    const registry = new InternalCapabilities({ tombstoneLimit: 2 });
    registry.begin("bot", "thread", "stopped");
    expect(registry.bindProviderTurn("thread", "stopped", "old-turn")).toBe(true);
    // Stop revokes the generation at once; its turn's terminal event comes later.
    registry.revokeThread("thread");
    registry.begin("bot", "thread", "next");
    expect(registry.dispatchingGeneration("thread", "old-turn")).toBe("stopped");
    // First binding wins; another thread's identical turn id is its own.
    registry.bindProviderTurn("thread", "next", "old-turn");
    expect(registry.dispatchingGeneration("thread", "old-turn")).toBe("stopped");
    expect(registry.dispatchingGeneration("other-thread", "old-turn")).toBeUndefined();
    expect(registry.dispatchingGeneration("thread", "")).toBeUndefined();
    // Bounded like the completion tombstones.
    registry.bindProviderTurn("thread", "next", "second-turn");
    registry.bindProviderTurn("thread", "next", "third-turn");
    expect(registry.dispatchingGeneration("thread", "old-turn")).toBeUndefined();
    expect(registry.dispatchingGeneration("thread", "third-turn")).toBe("next");
  });

  it("names the provider turn each generation dispatched, through revocation and completion, bounded", () => {
    const registry = new InternalCapabilities({ tombstoneLimit: 2 });
    registry.begin("bot", "thread", "gen-a");
    expect(registry.providerTurnOf("thread", "gen-a")).toBeUndefined();
    expect(registry.bindProviderTurn("thread", "gen-a", "turn-a")).toBe(true);
    expect(registry.providerTurnOf("thread", "gen-a")).toBe("turn-a");
    expect(registry.providerTurnOf("other-thread", "gen-a")).toBeUndefined();
    expect(registry.providerTurnOf("thread", "")).toBeUndefined();
    registry.revokeGeneration("thread", "gen-a");
    expect(registry.providerTurnOf("thread", "gen-a")).toBe("turn-a");
    registry.completeProviderTurn("thread", "turn-a");
    expect(registry.providerTurnOf("thread", "gen-a")).toBe("turn-a");
    registry.begin("bot", "thread", "gen-b");
    registry.bindProviderTurn("thread", "gen-b", "turn-b");
    registry.begin("bot", "thread", "gen-c");
    registry.bindProviderTurn("thread", "gen-c", "turn-c");
    expect(registry.providerTurnOf("thread", "gen-a")).toBeUndefined();
    expect(registry.providerTurnOf("thread", "gen-b")).toBe("turn-b");
    expect(registry.providerTurnOf("thread", "gen-c")).toBe("turn-c");
  });

  it("old completion, binding and cleanup cannot revoke a replacement generation", () => {
    const registry = new InternalCapabilities();
    registry.begin("bot", "thread", "generation");
    const old = mint(registry);
    registry.bindProviderTurn("thread", "generation", "old-turn");
    registry.begin("bot", "thread", "next");
    const next = mint(registry, "thread", "next");
    registry.completeProviderTurn("thread", "old-turn");
    registry.revokeGeneration("thread", "generation");
    expect(registry.bindProviderTurn("thread", "generation", "late-turn")).toBe(false);
    expect(registry.isActive(old.claim)).toBe(false);
    expect(registry.isActive(next.claim)).toBe(true);
  });

  // RED2I: the harness fold clears a thread's internal turn owner only when
  // its generation ended. A late terminal event of a stopped, unbound turn
  // must leave the replacement generation active — token minted or not.
  it("reports the active generation until its own bound provider turn completes", () => {
    const registry = new InternalCapabilities();
    expect(registry.activeGeneration("thread")).toBeUndefined();
    registry.begin("bot", "thread", "generation");
    registry.bindProviderTurn("thread", "generation", "refused-turn");
    registry.revokeGeneration("thread", "generation");
    registry.begin("bot", "thread", "next");
    // No token minted yet by "next"; the refused child's terminal event lands.
    registry.completeProviderTurn("thread", "refused-turn");
    expect(registry.activeGeneration("thread")).toBe("next");
    const next = mint(registry, "thread", "next");
    expect(registry.isActive(next.claim)).toBe(true);
    expect(registry.bindProviderTurn("thread", "next", "next-turn")).toBe(true);
    registry.completeProviderTurn("thread", "next-turn");
    expect(registry.activeGeneration("thread")).toBeUndefined();
    expect(registry.isActive(next.claim)).toBe(false);
  });

  it("bounds terminal tombstones", () => {
    const registry = new InternalCapabilities({ tombstoneLimit: 2 });
    for (const id of ["old", "middle", "new"]) registry.completeProviderTurn("thread", id);
    registry.begin("bot", "thread", "generation");
    expect(registry.bindProviderTurn("thread", "generation", "old")).toBe(true);
    expect(registry.bindProviderTurn("thread", "generation", "new")).toBe(false);
  });

  it("shares budgets across generation tokens and reserves concurrent admission atomically", () => {
    const registry = new InternalCapabilities();
    registry.begin("bot", "thread", "generation");
    const a = mint(registry), b = mint(registry, "thread", "generation", "connectors");
    const slots = Array.from({ length: 4 }, () => registry.reserve(a.claim, "handoff")!);
    expect(registry.reserve(b.claim, "handoff")).toBeNull();
    slots[0]!.release(); slots[0]!.release();
    const replacement = registry.reserve(b.claim, "handoff")!;
    expect(replacement.commit()).toBe(true);
    expect(replacement.commit()).toBe(true);
    replacement.release();
    expect(registry.reserve(a.claim, "handoff")).toBeNull();
    expect(registry.reserve(a.claim, "create")).not.toBeNull();
    registry.revokeThread("thread");
    expect(slots[1]!.commit()).toBe(false);
    expect(registry.reserve(a.claim, "create")).toBeNull();
  });

  it("revokes every owned bot thread and all remaining owners", () => {
    const registry = new InternalCapabilities();
    registry.begin("bot", "thread", "generation");
    registry.begin("bot", "second", "generation");
    const first = mint(registry), second = mint(registry, "second");
    registry.revokeBot("bot");
    expect(registry.isActive(first.claim)).toBe(false);
    expect(registry.isActive(second.claim)).toBe(false);
    registry.begin("bot", "third", "generation");
    const third = mint(registry, "third");
    registry.revokeAll();
    expect(registry.isActive(third.claim)).toBe(false);
  });

  it("mints, resolves and revokes the mcp kind like the others: only with the turn, and gone with its generation", () => {
    const registry = new InternalCapabilities();
    registry.begin("bot", "thread", "generation");
    const { token, claim } = mint(registry, "thread", "generation", "mcp");
    expect(claim.kind).toBe("mcp");
    expect(registry.resolve(`Bearer ${token}`)).toBe(claim);
    expect(registry.isActive(claim)).toBe(true);
    // a token for a generation that is not the turn's current one cannot be minted
    expect(() => registry.mint({ botId: "bot", threadId: "thread", generation: "other", kind: "mcp", depth: 0, skillAuthoring: false })).toThrow();
    expect(() => registry.mint({ botId: "bot", threadId: "thread", generation: "generation", kind: "bogus" as never, depth: 0, skillAuthoring: false })).toThrow();
    registry.revokeGeneration("thread", "generation");
    expect(registry.resolve(`Bearer ${token}`)).toBeNull();
    expect(registry.isActive(claim)).toBe(false);
  });

  it("a warm process's turn-N token stops working at settle and stays dead during turn N+1", () => {
    const registry = new InternalCapabilities();
    registry.begin("bot", "thread", "turn-1");
    const first = mint(registry, "thread", "turn-1");
    expect(registry.resolve(`Bearer ${first.token}`)).toBe(first.claim);
    // settle: the harness revokes the generation (index.ts revokeInternalGeneration)
    registry.revokeGeneration("thread", "turn-1");
    expect(registry.resolve(`Bearer ${first.token}`)).toBeNull();
    expect(registry.isActive(first.claim)).toBe(false);
    // turn N+1 on the same thread, same process: a new generation, a new token
    registry.begin("bot", "thread", "turn-2");
    const second = mint(registry, "thread", "turn-2");
    expect(second.token).not.toBe(first.token);
    expect(registry.resolve(`Bearer ${first.token}`)).toBeNull();
    expect(registry.resolve(`Bearer ${second.token}`)).toBe(second.claim);
    // a token minted without settling is also replaced when the next turn begins
    registry.begin("bot", "thread", "turn-3");
    expect(registry.resolve(`Bearer ${second.token}`)).toBeNull();
  });

  it("binds a token to its thread: another thread's generation cannot mint or reuse it", () => {
    const registry = new InternalCapabilities();
    registry.begin("bot", "thread-a", "gen-a");
    registry.begin("bot", "thread-b", "gen-b");
    const a = mint(registry, "thread-a", "gen-a");
    expect(a.claim.threadId).toBe("thread-a");
    expect(() => registry.mint({ ...a.claim, threadId: "thread-b" })).toThrow();
    registry.revokeGeneration("thread-b", "gen-b");
    expect(registry.resolve(`Bearer ${a.token}`)).toBe(a.claim);
  });
});

describe("the device kind (1.0.9 phone tools, S13)", () => {
  it("maps /api/internal/device/ paths to device and nothing else does", () => {
    expect(requiredInternalKind("/api/internal/device/call")).toBe("device");
    expect(requiredInternalKind("/api/internal/device/")).toBe("device");
    expect(requiredInternalKind("/api/internal/agents")).toBe("agents");
    expect(requiredInternalKind("/api/internal/devices")).toBe("agents");
    expect(requiredInternalKind("/api/internal/memory/search")).toBe("memory");
  });

  it("mints a device claim, and a claim of any other kind does not match the device path", () => {
    const registry = new InternalCapabilities();
    registry.begin("bot", "thread", "generation");
    const device = mint(registry, "thread", "generation", "device");
    expect(device.claim.kind).toBe("device");
    expect(device.claim.kind === requiredInternalKind("/api/internal/device/call")).toBe(true);
    for (const kind of ["agents", "connectors", "computer", "memory", "mcp"] as const) {
      const other = mint(registry, "thread", "generation", kind);
      expect(other.claim.kind === requiredInternalKind("/api/internal/device/call"), kind).toBe(false);
    }
  });

  it("refuses a claim with an unknown kind", () => {
    const registry = new InternalCapabilities();
    registry.begin("bot", "thread", "generation");
    expect(() => registry.mint({ botId: "bot", threadId: "thread", generation: "generation", kind: "phone" as never, depth: 0, skillAuthoring: false })).toThrow();
  });
});

describe("the highlevel kind (1.0.11 native HighLevel, GAP-HIGHLEVEL-109 section 17)", () => {
  it("maps /api/internal/highlevel/ to highlevel, and every existing kind, device included, maps as before", () => {
    expect(requiredInternalKind("/api/internal/highlevel/mcp")).toBe("highlevel");
    expect(requiredInternalKind("/api/internal/highlevel/")).toBe("highlevel");
    expect(requiredInternalKind("/api/internal/highlevels")).toBe("agents");
    expect(requiredInternalKind("/api/internal/highlevel")).toBe("agents");
    expect(requiredInternalKind("/api/internal/device/call")).toBe("device");
    expect(requiredInternalKind("/api/internal/memory/search")).toBe("memory");
    expect(requiredInternalKind("/api/internal/connectors/mcp")).toBe("connectors");
    expect(requiredInternalKind("/api/internal/mcp-remote/x")).toBe("mcp");
    expect(requiredInternalKind("/api/internal/box/v1/exec")).toBe("computer");
    expect(requiredInternalKind("/api/internal/computer-control")).toBe("computer");
    expect(requiredInternalKind("/api/internal/agents")).toBe("agents");
  });

  it("mints a highlevel claim, and no other kind matches the highlevel path", () => {
    const registry = new InternalCapabilities();
    registry.begin("bot", "thread", "generation");
    const highlevel = mint(registry, "thread", "generation", "highlevel");
    expect(highlevel.claim.kind).toBe("highlevel");
    expect(highlevel.claim.kind === requiredInternalKind("/api/internal/highlevel/mcp")).toBe(true);
    for (const kind of ["agents", "connectors", "computer", "memory", "mcp", "device"] as const) {
      const other = mint(registry, "thread", "generation", kind);
      expect(other.claim.kind === requiredInternalKind("/api/internal/highlevel/mcp"), kind).toBe(false);
      expect(other.claim.kind).toBe(kind);
    }
  });

  it("the inline map in server/index.ts agrees, keeps device, and Stop ends HighLevel calls with the generation", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).toContain('path.startsWith("/api/internal/device/") ? "device" : path.startsWith("/api/internal/highlevel/") ? "highlevel" :');
    const body = (name: string) => { const at = source.indexOf(`function ${name}(`); return source.slice(at, source.indexOf("\n}\n", at)); };
    expect(body("revokeInternalGeneration")).toContain("highlevelCalls.turnEnded(generation)");
    expect(body("revokeInternalThread")).toContain("highlevelCalls.turnEndedForThread(threadId)");
    expect(body("revokeInternalBot")).toContain("highlevelCalls.turnEndedForBot(botId)");
    expect(body("revokeAllInternalTurns")).toContain("highlevelCalls.turnEndedAll()");
  });
});


describe("consuming turn cleanup", () => {
  let server: VerificationServer, headers: Record<string, string>;
  const href = (file: string) => JSON.stringify(pathToFileURL(join(process.cwd(), file)).href);
  const rows = () => {
    const file = join(server.info.dataDir, 'lease-events');
    return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  };
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(server.info.url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    expect(response.ok).toBe(true);
    return response.json() as Promise<any>;
  };
  beforeAll(async () => {
    server = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs = await import('node:fs'), path = await import('node:path');
      const {InternalCapabilities} = await import(${href('server/internal-capabilities.ts')});
      const {BUILT_IN_DRIVERS} = await import(${href('server/drivers/builtIn.ts')});
      const {makeLateTerminalDriver} = await import(${href('server/testing/fake-late-terminal-driver.ts')});
      const root = process.env.MURAGE_DATA_DIR;
      const log = row => fs.appendFileSync(path.join(root,'lease-events'), JSON.stringify(row)+'\\n');
      const begin = InternalCapabilities.prototype.begin;
      InternalCapabilities.prototype.begin = function(botId, threadId, generation, humanPrincipal) {
        const id = begin.call(this,botId,threadId,generation,humanPrincipal);
        const token = this.mint({botId,threadId,generation:id,humanPrincipal,kind:'memory',depth:0,skillAuthoring:false});
        const claim = this.resolve('Bearer '+token);
        this.retainMemoryView(claim,'fixture-view',()=>{log({type:'retained',threadId,generation:id});return ()=>{log({type:'released',threadId,generation:id});queueMicrotask(()=>log({type:'retired',threadId,generation:id,active:this.isActive(claim),resolvable:this.resolve('Bearer '+token)!==null}));};});
        return id;
      };
      const driver = makeLateTerminalDriver({fencedDefaults:true}), create = driver.create.bind(driver);
      driver.create = async input => {
        const instance = await create(input), send = instance.adapter.sendTurn.bind(instance.adapter);
        instance.adapter.onEvent(event=>{if(event.type==='turn.completed'||event.type==='session.exited')log({type:'terminal',threadId:event.threadId});});
        instance.adapter.sendTurn = async turn => {
          const ending = turn.text.includes('LEASE_THROW') ? 'throw' : turn.text.includes('LEASE_ABORT') ? 'abort' : 'return';
          log({type:'dispatch',threadId:turn.threadId,ending});
          if(ending==='throw')throw Error('fixture dispatch failed before acceptance');
          if(ending==='abort') {
            turn.beforeSubmit?.();
            return {turnId:'lease-abort'};
          }
          return send(turn);
        };
        // This in-process provider has no child or deferred terminal event.
        instance.adapter.interruptTurn = async () => ({closeConfirmed:true});
        return instance;
      };
      BUILT_IN_DRIVERS.push(driver);
      const configPath=path.join(root,'config.json'), config=JSON.parse(fs.readFileSync(configPath,'utf8'));
      config.instances.late={driver:'fakeLateTerminal',environment:{}};
      fs.writeFileSync(configPath,JSON.stringify(config));
    ` });
    const { secret } = await (await fetch(server.info.url + '/api/desktop-secret')).json() as { secret: string };
    headers = { 'content-type':'application/json', 'x-murage-surface':'desktop', 'x-murage-surface-secret':secret };
  });
  afterAll(async () => { await server?.close(); });
  it.each(['return','throw','abort'])('actual turn %s releases its memory lease', async ending => {
    const bot = (await api('POST','/api/bots',{name:'Lease fixture',modelSelection:{instanceId:'late',model:'late-1'}})).bot;
    await api('PATCH',`/api/bots/${bot.id}`,{computer:'off',browser:false,composio:false});
    await api('POST',`/api/bots/${bot.id}/messages`,{text:`LEASE_${ending.toUpperCase()}`,threadId:bot.threadId});
    const events = () => rows().filter(row=>row.threadId===bot.threadId);
    await expect.poll(()=>events().some(row=>row.type==='dispatch')).toBe(true);
    expect(events().find(row=>row.type==='dispatch').ending).toBe(ending);
    const retained = events().filter(row=>row.type==='retained');
    expect(retained).toHaveLength(1);
    if(ending==='abort') {
      expect(events().filter(row=>row.type==='released')).toEqual([]);
      await api('POST',`/api/bots/${bot.id}/interrupt`,{all:true});
    }
    await expect.poll(async()=> (await api('GET','/api/bots?messages=0')).bots.find((row:any)=>row.id===bot.id)?.busy).not.toBe(true);
    expect(events().filter(row=>row.type==='released')).toHaveLength(1);
    await expect.poll(()=>events().filter(row=>row.type==='released')).toEqual([
      {type:'released',threadId:bot.threadId,generation:retained[0].generation},
    ]);
    if(ending!=='return')expect(events().filter(row=>row.type==='terminal')).toEqual([]);
    else expect(events().filter(row=>row.type==='terminal')).toHaveLength(1);
    await expect.poll(async()=> (await api('GET','/api/bots?messages=0')).bots.find((row:any)=>row.id===bot.id)?.busy).not.toBe(true);
    expect(events().filter(row=>row.type==='released')).toHaveLength(1);
    expect(events().filter(row=>row.type==='retired')).toEqual([{type:'retired',threadId:bot.threadId,generation:retained[0].generation,active:false,resolvable:false}]);
  });
});
