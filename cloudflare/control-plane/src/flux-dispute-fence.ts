// SPDX-License-Identifier: AGPL-3.0-or-later
// DISPUTE-FENCE-ACCOUNT: the open account-level email-proof dispute (table flux_account_dispute, migration 0147) as SQL, so each commit point
// of a Flux home checks it INSIDE its own statement (never a read followed by a write). The table is written only by the dispute and
// dispute-clear batches in flux-email-proof.ts.

// The two predicates live in the leaf flux-grant-fence.ts (the grant choke point needs them and that module imports nothing).
export { accountDisputeOpenSql, homeDisputeOpenSql } from "./flux-grant-fence";
import { homeDisputeOpenSql as homeOpen, accountDisputeOpenSql as accountOpen } from "./flux-grant-fence";

/** THE CHOKE POINT FOR CAP WRITES. An SQL predicate for the WHERE of an UPDATE of flux_home_keys (the bare columns are the CURRENT values;
 *  `newCap` and `newOff` are the SQL of the values the write sets). It holds when the home's owner has no open dispute, OR the write does not
 *  RAISE the effective limit (0 while spending is off, else the stored cap): so lowering, switching off, keeping the limit and re-sending the
 *  stored cap all pass, and every increase, switching spending on included, is refused inside the statement. Every cap write goes through it
 *  (test/dispute-fence-pin.test.ts fails when one does not). binds: in the order of the placeholders in `sql`. */
export function capRaiseFence(home: string, newCap: { sql: string; binds: unknown[] }, newOff: { sql: string; binds: unknown[] }): { sql: string; binds: unknown[] } {
  return {
    sql: `(NOT ${homeOpen("?")} OR (CASE WHEN ${newOff.sql}=1 THEN 0 ELSE ${newCap.sql} END)<=(CASE WHEN spending_off=1 THEN 0 ELSE cap_microcents END))`,
    binds: [home, ...newOff.binds, ...newCap.binds],
  };
}

/** Does the account have an open dispute now? For early, plain refusals; the statements above are what decide. */
export async function accountDisputeOpen(env: Env, owner: string): Promise<boolean> {
  return (await env.DB.prepare(`SELECT ${accountOpen("?")} AS d`).bind(owner).first<{ d: number }>())?.d === 1;
}
export async function homeDisputeOpen(env: Env, homeId: string): Promise<boolean> {
  return (await env.DB.prepare(`SELECT ${homeOpen("?")} AS d`).bind(homeId).first<{ d: number }>())?.d === 1;
}
