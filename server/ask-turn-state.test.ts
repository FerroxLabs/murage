import { describe, expect, it, vi } from "vitest";
import { askTurnState, checkResendAction, parseResendAction, queuedCancelState,
  type AttemptSnapshot, type AttemptRead, type BindingSnapshot, type ResendAction, type SendActionDeps, type TurnStateEnvelope } from "./ask-turn-state.ts";

const scope = { ownerId: "owner", botId: "b1", threadId: "t1" };
const attempt = (patch: Partial<AttemptSnapshot> = {}): AttemptSnapshot => ({ ...scope, sendId: "s1", attemptId: "a1",
  revision: 3, bindingEpoch: 2, phase: "queued", delivery: "not_submitted", terminalOutcome: null,
  terminalReason: null, messageId: null, queueId: "q1", stopGen: null, restoreGen: null, ...patch });
const binding = (patch: Partial<BindingSnapshot> = {}): BindingSnapshot => ({ ...scope, sendId: "s1", attemptId: "a1",
  bindingEpoch: 2, generation: "generation", providerInstanceId: "engine", providerTurnId: "turn", active: true,
  ownsGeneration: true, approval: false, ...patch });
function fixture(a: AttemptRead = attempt(), b: BindingSnapshot | null = null) {
  const deps = { authorize: vi.fn(() => ({ remove: true, stop: true, resend: true })),
    withReadSnapshot: <T>(read: () => T): T => read(), readAttempt: vi.fn(() => a), readBinding: vi.fn(() => b),
    indexReady: vi.fn(() => true), capabilities: { turnStateContract: 1, scopedTurnStop: 1, sendActionContract: 1, queueRemovable: true },
    readAction: vi.fn<SendActionDeps["readAction"]>(() => null) };
  const read = (sendId = "s1", hint = "foreign-turn") => {
    const result = askTurnState(scope, sendId, hint, deps);
    expect(result.status).toBe(200);
    return result.body as TurnStateEnvelope;
  };
  return { deps, read };
}
const action = (patch: Partial<ResendAction> = {}): ResendAction => ({ contract: 1, actionId: "press", threadId: "t1",
  sendId: "s1", attemptId: "a1", receiptRevision: 3, bindingEpoch: 2, kind: "resend", replacementSendId: "s2", confirmDuplicate: false, ...patch });
const failed = (patch: Partial<AttemptSnapshot> = {}) => attempt({ phase: "terminal", terminalOutcome: "failed", ...patch });

describe("STATE-1 send-keyed receipt projection", () => {
  it.each([
    [attempt(), null, "queued"],
    [attempt({ phase: "starting" }), null, "sending"],
    [attempt({ phase: "running", delivery: "submitted" }), binding(), "running"],
    [attempt({ phase: "running", delivery: "submitted" }), binding({ approval: true }), "approval"],
    [failed(), null, "failed"],
    [failed({ delivery: "submitted" }), null, "submitted_but_failed"],
    [failed({ delivery: "uncertain" }), null, "unknown"],
    [failed({ terminalOutcome: "refused" }), null, "refused"],
    [failed({ terminalOutcome: "removed" }), null, "cancelled"],
    [failed({ terminalOutcome: "stopped", delivery: "uncertain" }), null, "stopped"],
    [failed({ terminalOutcome: "completed", delivery: "submitted" }), null, "ended"],
    [failed({ terminalOutcome: "completed", delivery: "uncertain" }), null, "unknown"],
    [failed({ terminalOutcome: "abandoned_uncertain" }), null, "unknown"],
    [attempt({ phase: "stopping" }), binding(), "unknown"],
    [attempt({ phase: "held" }), null, "unknown"],
    [attempt({ phase: "running" }), null, "unknown"],
  ] as const)("projects %j as %s", (a, b, state) => {
    const { read } = fixture(a, b);
    const result = read();
    expect(result.state).toBe(state);
    expect(result).toMatchObject({ contract: 1, botId: "b1", threadId: "t1", sendId: "s1", attemptId: "a1", receiptRevision: 3, bindingEpoch: 2,
      messageId: a.messageId, queueId: a.queueId, delivery: a.delivery, terminalOutcome: a.terminalOutcome, reason: null,
      stopGen: a.stopGen, restoreGen: a.restoreGen, retryAfterMs: null });
    expect(Object.keys(result).sort()).toEqual(["contract", "botId", "threadId", "sendId", "attemptId", "receiptRevision", "bindingEpoch", "messageId", "queueId", "turnId", "state", "delivery", "terminalOutcome", "reason", "stopGen", "restoreGen", "actions", "retryAfterMs"].sort());
  });
  it("rejects missing/retired and foreign owner, bot, thread or send without leaking linkage", () => {
    for (const a of [{kind:"missing"}, {kind:"retired"}, attempt({ownerId:"other"}), attempt({botId:"other"}), attempt({threadId:"other"}), attempt({sendId:"other"})] as AttemptRead[]) {
      const {read,deps} = fixture(a);
      expect(read()).toMatchObject({ state:"unknown", attemptId:null, turnId:null, receiptRevision:null, messageId:null, queueId:null,
        actions:{remove:false,stop:false,resend:false,openChat:true} });
      expect(deps.readBinding).not.toHaveBeenCalled();
    }
  });
  it("never selects the hint; restamp follows only the receipt's current binding", () => {
    const {read,deps} = fixture(attempt({phase:"running"}), binding());
    expect(read().turnId).toBe("turn");
    expect(deps.readAttempt).toHaveBeenLastCalledWith(scope,"s1");
    deps.readAttempt.mockReturnValue(attempt({phase:"running",bindingEpoch:3,revision:4}));
    expect(read("s1","turn")).toMatchObject({state:"unknown",turnId:null,bindingEpoch:3,receiptRevision:4});
    deps.readBinding.mockReturnValue(binding({bindingEpoch:3,providerTurnId:"replacement"}));
    expect(read("s1","turn")).toMatchObject({state:"running",turnId:"replacement"});
  });
  it("requires exact live binding ownership for Stop and approvals", () => {
    for (const patch of [{ownerId:"other"},{botId:"other"},{threadId:"other"},{sendId:"other"},{attemptId:"other"},{bindingEpoch:1},{active:false},{ownsGeneration:false},{providerTurnId:undefined},{generation:""},{providerInstanceId:""}]) {
      const {read} = fixture(attempt({phase:"running"}), binding({...patch,approval:true}));
      expect(read()).toMatchObject({state:"unknown",actions:{stop:false}});
      expect(read().turnId).toBe("active" in patch || "ownsGeneration" in patch ? "turn" : null);
    }
  });
  it("uses one snapshot and never guesses completion from idle or transcript rows", () => {
    const {deps,read} = fixture(attempt({phase:"running",messageId:"m1"}));
    const snapshot = vi.fn();
    deps.withReadSnapshot = read => { snapshot(); return read(); };
    expect(read().state).toBe("unknown");
    expect(snapshot).toHaveBeenCalledOnce();
  });
  it("STATE-1: provider ID allocation during setup is still sending, not proof the answer started", () => {
    const {read} = fixture(attempt({phase:"starting",delivery:"not_submitted"}),binding());
    expect(read()).toMatchObject({state:"sending",delivery:"not_submitted",turnId:"turn"});
  });
  it("STATE-1: a completed receipt retains its own closed provider turn after reload", () => {
    const {read} = fixture(failed({terminalOutcome:"completed",delivery:"submitted",messageId:"m1"}), binding({active:false,ownsGeneration:false,closed:true}));
    expect(read()).toMatchObject({state:"ended",turnId:"turn",messageId:"m1",actions:{remove:false,stop:false,resend:false,openChat:true}});
  });
  it("not-ready retains the saved identity and exact live Stop", () => {
    const {read,deps} = fixture(attempt({phase:"running"}),binding());
    deps.indexReady.mockReturnValue(false);
    expect(read()).toMatchObject({state:"indexing",retryAfterMs:5000,attemptId:"a1",turnId:"turn",actions:{stop:true,resend:false}});
  });
  it("storage errors return unavailable, never ended or a fake receipt", () => {
    const {deps} = fixture();
    deps.readAttempt.mockImplementation(() => {throw new Error("locked");});
    expect(askTurnState(scope,"s1",undefined,deps)).toEqual({status:503,body:{code:"turn_state_unavailable",retryAfterMs:5000}});
  });
  it("DOOR-1 authorizes the exact subject before any receipt, binding or index read", () => {
    const {deps} = fixture();
    const deny = {...deps,authorize:vi.fn(() => null)};
    expect(askTurnState(scope,"s1",undefined,deny).status).toBe(404);
    expect(deny.authorize).toHaveBeenCalledWith(scope);
    expect(deps.readAttempt).not.toHaveBeenCalled();
    expect(deps.readBinding).not.toHaveBeenCalled();
    expect(deps.indexReady).not.toHaveBeenCalled();
  });
});

describe("F7-ML4 cancelled receipt ordering and CANCEL-16", () => {
  for (const name of ["F7-ML4-ACKED-QUEUED-REMOVE", "F7-ML4-LOSTACK-AFTER-REMOVE"]) it(name, () => {
    const {read,deps} = fixture(failed({terminalOutcome:"removed",messageId:null,queueId:null}));
    deps.indexReady.mockImplementation(() => {throw new Error("index not available");});
    expect(read()).toMatchObject({state:"cancelled",terminalOutcome:"removed",actions:{remove:false,stop:false,resend:false}});
    expect(queuedCancelState(read())).toEqual({state:"cancelled"});
    expect(deps.indexReady).not.toHaveBeenCalled();
  });
  it.each([
    ["queued","sending"],["sending","sending"],["indexing","sending"],["running","started"],["approval","started"],
    ["ended","started"],["submitted_but_failed","started"],["stopped","started"],["cancelled","cancelled"],["failed","failed"],["refused","refused"],["unknown","missing"],
  ] as const)("CANCEL-16: authorized 404 %s stays %s", (state, expected) => {
    const {read} = fixture(attempt({messageId:"m1"}));
    expect(queuedCancelState({...read(),state})).toEqual({state:expected,messageId:"m1"});
  });
});

describe("LEGACY-CAP and permitted actions", () => {
  it("missing/unsupported versions never enable a mutation", () => {
    for (const capabilities of [{}, {turnStateContract:2,scopedTurnStop:1,sendActionContract:1,queueRemovable:true}]) {
      for (const [a,b] of [[attempt(),null],[attempt({phase:"running"}),binding()],[failed(),null]] as const) {
        const {deps,read} = fixture(a,b);
        Object.assign(deps,{capabilities});
        expect(read().actions).toEqual({remove:false,stop:false,resend:false,openChat:true});
      }
    }
  });
  it("absent individual capabilities disable only that mutation", () => {
    for (const [a,b,cap,actionName] of [[attempt(),null,"queueRemovable","remove"],[attempt({phase:"running"}),binding(),"scopedTurnStop","stop"],[failed(),null,"sendActionContract","resend"]] as const) {
      const {deps,read} = fixture(a,b);
      expect(read().actions[actionName]).toBe(true);
      Object.assign(deps.capabilities,{[cap]:undefined});
      expect(read().actions[actionName]).toBe(false);
    }
  });
  it("permissions restrict removal, Stop and resend independently", () => {
    for (const [a,b] of [[attempt(),null],[attempt({phase:"running"}),binding()],[failed(),null]] as const) {
      const {deps,read} = fixture(a,b);
      deps.authorize.mockReturnValue({remove:false,stop:false,resend:false});
      expect(read().actions).toEqual({remove:false,stop:false,resend:false,openChat:true});
    }
  });
  it("uncertain resend requires closure and a durable fence", () => {
    const {read,deps} = fixture(failed({delivery:"uncertain"}));
    expect(read().actions.resend).toBe(false);
    deps.readAttempt.mockReturnValue(failed({delivery:"uncertain",stopGen:"stopped"}));
    expect(read().actions.resend).toBe(true);
    deps.readBinding.mockReturnValue(binding());
    expect(read().actions.resend).toBe(false);
  });
});

describe("ACTION-1 exact action identity and fences", () => {
  it("returns the same completed action after a fence change; never retargets", () => {
    const {deps} = fixture(failed({stopGen:"new-fence"}));
    const result = {replacementSendId:"s2",replacementAttemptId:"a2"};
    deps.readAction.mockReturnValue({request:action(),status:"done",result});
    expect(checkResendAction(scope,action(),deps)).toEqual({kind:"existing",result});
    expect(deps.readAttempt).not.toHaveBeenCalled();
    for (const patch of [{replacementSendId:"s3"},{attemptId:"a2"},{bindingEpoch:3},{receiptRevision:4},{sendId:"s3"},{confirmDuplicate:true},{stopGen:"new-fence"}]) {
      expect(checkResendAction(scope,action(patch),deps)).toMatchObject({kind:"error",code:"stale_action"});
    }
  });
  it("pending actions cannot cross Stop or restore fences", () => {
    for (const patch of [{stopGen:"new"},{restoreGen:"new"}]) {
      const {deps} = fixture(failed(patch));
      deps.readAction.mockReturnValue({request:action(),status:"pending",result:null});
      expect(checkResendAction(scope,action(),deps)).toMatchObject({kind:"error",code:"stale_action"});
      expect(checkResendAction(scope,action({...patch,actionId:"new-press"}),{...deps,readAction:()=>null})).toMatchObject({kind:"ready"});
    }
  });
  it("changed revision, binding and attempt fail before any replacement", () => {
    for (const patch of [{revision:4},{bindingEpoch:3},{attemptId:"a2"}]) {
      const {deps} = fixture(failed(patch));
      expect(checkResendAction(scope,action(),deps)).toMatchObject({kind:"error",status:409,code:"stale_action"});
    }
  });
  it("known unsent permits a new action, but an owned or incomplete attempt needs Stop", () => {
    const {deps} = fixture(failed());
    expect(checkResendAction(scope,action(),deps)).toMatchObject({kind:"ready",request:action(),receipt:{state:"failed"}});
    deps.readBinding.mockReturnValue(binding());
    expect(checkResendAction(scope,action(),deps)).toMatchObject({kind:"error",code:"stop_required"});
    deps.readBinding.mockReturnValue(null);
    deps.readAttempt.mockReturnValue(attempt({phase:"starting"}));
    expect(checkResendAction(scope,action(),deps)).toMatchObject({kind:"error",code:"stop_required"});
  });
  it("uncertain or submitted requires a fence and explicit duplicate confirmation", () => {
    for (const delivery of ["uncertain","submitted"] as const) {
      const {deps} = fixture(failed({delivery}));
      expect(checkResendAction(scope,action(),deps)).toMatchObject({kind:"error",code:"stop_required"});
      deps.readAttempt.mockReturnValue(failed({delivery,stopGen:"closed"}));
      expect(checkResendAction(scope,action({stopGen:"closed"}),deps)).toMatchObject({kind:"error",code:"duplicate_confirmation_required"});
      expect(checkResendAction(scope,action({stopGen:"closed",confirmDuplicate:true}),deps)).toMatchObject({kind:"ready"});
    }
  });
  it("submitted failure with proven provider closure can resend after confirmation without inventing a Stop fence", () => {
    const {deps,read} = fixture(failed({delivery:"submitted"}),binding({active:false,ownsGeneration:false,closed:true}));
    expect(read().actions.resend).toBe(true);
    expect(checkResendAction(scope,action(),deps)).toMatchObject({kind:"error",code:"duplicate_confirmation_required"});
    expect(checkResendAction(scope,action({confirmDuplicate:true}),deps)).toMatchObject({kind:"ready"});
    deps.readBinding.mockReturnValue(binding({active:false,ownsGeneration:true,closed:true}));
    expect(read().actions.resend).toBe(false);
    expect(checkResendAction(scope,action({confirmDuplicate:true}),deps)).toMatchObject({kind:"error",code:"stop_required"});
  });
  it("dismissed/retired sends stay gone", () => {
    const {deps} = fixture(failed({terminalOutcome:"removed"}));
    expect(checkResendAction(scope,action(),deps)).toMatchObject({kind:"error",code:"target_dismissed"});
    deps.readAttempt.mockReturnValue({kind:"retired"});
    expect(checkResendAction(scope,action(),deps)).toMatchObject({kind:"error",status:410,code:"retired_send_id"});
  });
  it("rechecks authorization even for a recorded action", () => {
    const {deps} = fixture();
    expect(checkResendAction(scope,action(),{...deps,authorize:()=>null})).toMatchObject({kind:"error",status:404});
    expect(deps.readAction).not.toHaveBeenCalled();
    expect(deps.readAttempt).not.toHaveBeenCalled();
  });
  it("wrong thread fails before lookup and a foreign returned receipt fails closed", () => {
    const {deps} = fixture(failed({ownerId:"other"}));
    expect(checkResendAction(scope,action({threadId:"other"}),deps)).toMatchObject({kind:"error",code:"bad_scope"});
    expect(deps.readAction).not.toHaveBeenCalled();
    expect(checkResendAction(scope,action(),deps)).toMatchObject({kind:"error",code:"stale_action"});
  });
  it("normalizes object key order for same-action fingerprints, preserving every target field", () => {
    const {deps} = fixture(failed());
    const result = {replacementSendId:"s2"};
    deps.readAction.mockReturnValue({request:action(),status:"done",result});
    expect(checkResendAction(scope,Object.fromEntries(Object.entries(action()).reverse()),deps)).toEqual({kind:"existing",result});
  });
});

describe("ACTION-1 malformed bodies", () => {
  it("rejects malformed action identities, numbers, fences and replacement IDs", () => {
    for (const patch of [{contract:2},{actionId:""},{sendId:[]},{attemptId:"a".repeat(513)},{receiptRevision:-1},{receiptRevision:1.5},{bindingEpoch:Number.MAX_SAFE_INTEGER+1},
      {replacementSendId:"s1"},{confirmDuplicate:undefined},{stopGen:null},{restoreGen:[]},{threadId:" t1"}]) {
      expect(parseResendAction({...action(),...patch})).toBeNull();
    }
    expect(parseResendAction(null)).toBeNull();
    expect(parseResendAction([])).toBeNull();
  });
});
