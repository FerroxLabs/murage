import type { DatabaseSync, SQLInputValue } from "node:sqlite";

type CrashPlan = {
  table: string;
  where: Readonly<Record<string, SQLInputValue>>;
  side: "before" | "after";
  nth?: number;
};
export type CommitPlan = CrashPlan | { observe: true };

function identifier(name: string) {
  return `"${name.replaceAll('"', '""')}"`;
}

export function commitGate(db: DatabaseSync, plan: CommitPlan, onCommit?: () => void): DatabaseSync {
  const crash = "side" in plan ? plan : undefined;
  const marker = "temp._mail_fixture_write";
  let commits = 0;
  if (crash) {
    const quote = db.prepare("SELECT quote(?) AS literal");
    const table = identifier(crash.table);
    db.exec(`CREATE TEMP TABLE ${marker} (matched INTEGER PRIMARY KEY)`);
    for (const event of ["INSERT", "UPDATE", "DELETE"] as const) {
      const row = event === "DELETE" ? "OLD" : "NEW";
      const matches = Object.entries(crash.where).map(([column, value]) =>
        `${row}.${identifier(column)} IS ${quote.get(value)?.literal}`
      ).join(" AND ");
      db.exec(`CREATE TEMP TRIGGER _mail_fixture_${event} AFTER ${event} ON main.${table}
        ${matches ? `WHEN ${matches}` : ""}
        BEGIN INSERT OR IGNORE INTO _mail_fixture_write VALUES (1); END;`);
    }
  }

  function exec(sql: string) {
    if (crash && /^\s*BEGIN\b/i.test(sql) && !db.isTransaction) db.exec(`DELETE FROM ${marker}`);
    if (!/^\s*(?:COMMIT|END)(?:\s+TRANSACTION)?\s*;?\s*$/i.test(sql) || !db.isTransaction) {
      return db.exec(sql);
    }
    const matched = crash && db.prepare(`SELECT 1 FROM ${marker}`).get();
    const nth = crash?.nth ?? 1;
    if (matched && commits + 1 === nth && crash.side === "before") process.kill(process.pid, "SIGKILL");
    db.exec(sql);
    if (matched && ++commits === nth && crash.side === "after") process.kill(process.pid, "SIGKILL");
    if ("observe" in plan) onCommit?.();
  }

  return new Proxy(db, {
    get(target, key) {
      if (key === "exec") return exec;
      const member = Reflect.get(target, key, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
}
