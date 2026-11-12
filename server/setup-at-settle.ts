import { decide } from './outside-authority.ts';
import type { Ledger, SettleVerdict, SetupEntry } from './turn-settle.ts';
interface SetupHooks { open: () => boolean; option: () => boolean; apply: () => boolean | Promise<boolean>; push: () => void }
export class SetupAtSettle {
  private pending = new Map<string, Array<{ entry: SetupEntry; hooks: SetupHooks }>>();
  private ledger: Ledger;
  constructor(ledger: Ledger) { this.ledger = ledger; }
  file(generation: string, input: Omit<SetupEntry, 'origin'>, hooks: SetupHooks): boolean {
    const row = this.ledger.rows.get(generation);
    if (!row || row.settled || !input.option) return false;
    const entry = { ...input, origin: row.origin };
    row.setup.push(entry);
    this.pending.set(generation, [...(this.pending.get(generation) ?? []), { entry, hooks }]);
    return input.push_suppressed;
  }
  settle(generation: string, verdict: SettleVerdict) {
    const pending = this.pending.get(generation) ?? []; this.pending.delete(generation);
    for (const { entry, hooks } of pending) {
      const [result, notify] = decide({ kind: 'setup_at_settle', entry }, { verdict, option_now: hooks.option(), card_open: hooks.open() });
      const finish = (applied: boolean) => {
        if (!applied && hooks.open() && (notify === 'push' || result === 'resolve')) hooks.push();
      };
      if (result === 'resolve') {
        try {
          const applied = hooks.apply();
          if (typeof applied === 'boolean') finish(applied);
          else void applied.then(finish, () => finish(false));
        } catch { finish(false); }
      } else finish(false);
    }
  }
}
