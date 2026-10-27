// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// BOOT-SETTLE-108 crash fixture (server/boot-settle-108.crash.test.ts): a process that opens the test's data directory, does one step of the boot settling,
// an owner action or a dispatch, and dies at the named point (exit code 9). Spawned only by that test, with MURAGE_DATA_DIR set to its temporary directory.
// Usage: boot-settle-108-child.ts <scenario> <hand-off id>
const [scenario, id = ""] = process.argv.slice(2);
const dataDir = process.env.MURAGE_DATA_DIR;
if (!dataDir || !process.env.BOOT_SETTLE_108_CHILD) { process.stderr.write("refusing: not started by the boot-settle crash test\n"); process.exit(2); }

const { database } = await import("../database.ts");
const delegations = await import("../delegations.ts");
const { completeRequest } = await import("../room-requests.ts");
const { Store } = await import("../store.ts");
const { afterCommit } = await import("../tx-scope.ts");
const { configureHandoffDispatch, dispatchHandoff } = await import("../handoff-dispatch.ts");
const { fakeHost, rememberRun, writePrompt } = await import("./handoff-turn.ts");
type CommsBus = import("../comms-visibility.ts").CommsBus;
type HandoffTurnOptions = import("../handoff-dispatch.ts").HandoffTurnOptions;

const die = (): never => process.exit(9);
const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
delegations._loadPending();
database();
const botName = () => "Helper";

/** A store whose held-line patch dies inside its transaction, after every write of the change it carries (before COMMIT). */
const dyingStore = {
  patchMessage: (thread: string, message: string, patch: Parameters<typeof store.patchMessage>[2], within?: () => void) =>
    store.patchMessage(thread, message, patch, () => { within?.(); die(); }),
};
/** A store whose first held-line patch dies right after the outer COMMIT, before anything is announced. */
let armed = true;
const afterCommitStore = {
  patchMessage: (thread: string, message: string, patch: Parameters<typeof store.patchMessage>[2], within?: () => void) =>
    store.patchMessage(thread, message, patch, () => { if (armed) { armed = false; afterCommit(die); } within?.(); }),
};
/** The room's completion of a cancelled partner, dying after the outer COMMIT and before its follow-ups. */
const cancelThenDie = (db: Parameters<typeof completeRequest>[0], request: string, outcome: { state: "cancelled"; now: number; outcomeNote: string }) => {
  completeRequest(db, request, outcome);
  afterCommit(die);
};
const bus = { store, broadcast: () => {}, canDispatch: () => true, canStartHandoff: () => true } as unknown as CommsBus;
const approvalBus = { store, broadcast: () => {} } as never;

switch (scenario) {
  case "expiry-before-commit": {
    let patches = 0;
    const counting = { patchMessage: (t: string, m: string, p: Parameters<typeof store.patchMessage>[2], within?: () => void) => store.patchMessage(t, m, p, () => { if (++patches === 150) die(); within?.(); }) };
    delegations.reconcileStartedDelegations({ store: counting, botName });
    break;
  }
  case "expiry-after-commit":
    delegations.reconcileStartedDelegations({ store: afterCommitStore, botName });
    break;
  case "receipt-saved":
    // the receipt has reached disk (recordDelegationReceipt saves it first); the process dies inside the settle, before its SQL commits
    delegations.onDelegationReceipt(() => die());
    delegations.reconcileStartedDelegations({ store, botName });
    break;
  case "dismiss-before-commit":
    delegations.dismissHeldDelegation(id, dyingStore);
    break;
  case "dismiss-after-commit":
    delegations.dismissHeldDelegation(id, store, { cancelPartner: cancelThenDie });
    break;
  case "send-before-commit":
    // the same store, except that the held line's patch dies inside the Send again transaction (after the partner, the replacement and the row)
    delegations.resendHeldDelegation({ ...bus, store: new Proxy(store, { get: (target, key) => {
      if (key === "patchMessage") return dyingStore.patchMessage;
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    } }) } as unknown as CommsBus, id);
    break;
  case "send-after-commit":
    delegations.resendHeldDelegation(bus, id, { cancelPartner: cancelThenDie });
    break;
  case "owed-wake-death": {
    // the real asker wakes, restored from the test's file; once restored, the first write of a wake to disk dies (the settle's line has committed by then)
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { AskerWakes } = await import("../asker-wake.ts");
    const { wakeAfterRecoveredReceipt } = await import("../handoff-boundary.ts");
    let restored = false;
    const wakes = new AskerWakes(() => { if (restored) die(); });
    const onDisk = JSON.parse(readFileSync(join(dataDir, "bs108-asker-wakes.json"), "utf8")) as Record<string, Parameters<typeof wakes.restore>[1]>;
    for (const [threadId, snapshot] of Object.entries(onDisk)) wakes.restore(threadId, snapshot, new Set());
    restored = true;
    const port = { register: () => true, consume: (t: string) => wakes.consume(t), returned: (t: string, th: string, r: Parameters<typeof wakes.deliver>[1]) => { wakes.deliver(t, r); return wakes.durable(th); } };
    delegations.onOwedHandoffReply((receipt) => ({ id: `line-${receipt.id}` }));
    delegations.onDelegationReceipt((receipt, delivered) => () => wakeAfterRecoveredReceipt(port, receipt, delivered?.id));
    delegations.reconcileStartedDelegations({ store, botName });
    break;
  }
  case "dispatch-prompt":
  case "dispatch-submit":
    configureHandoffDispatch({
      ...fakeHost(bus, () => {}, { stamp: false }),
      startTurn: async (_botId: string, text: string, turn: HandoffTurnOptions) => {
        const run = turn.delegationRun;
        rememberRun(run);
        writePrompt(bus, run, turn.threadId, text);                 // the prompt and the start, one commit
        if (scenario === "dispatch-submit") run.submitted();         // the submission stamp, its own commit
        die();
      },
    }, { bus, approvalBus });
    await dispatchHandoff(id, { bus, approvalBus });
    break;
  default:
    process.stderr.write(`unknown scenario ${scenario}\n`);
    process.exit(3);
}
// a scenario whose death point was never reached says so
process.stdout.write("NOT_REACHED\n");
process.exit(0);
