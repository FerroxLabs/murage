#!/usr/bin/env python3
# usage: mut.py NAME  -> applies mutant NAME to /root/fuigo-builds/park-A/mut/server/email/binding-service.ts; prints expected failing tests
import sys
F='/root/fuigo-builds/park-A/mut/server/email/binding-service.ts'
M={
 'T4':("const covered = open.length === covers.length && open.every(tomb => covers.some(c => c.inboxId === tomb.inboxId && c.revision === tomb.revision));","const covered = true;","T4a T4b T4c"),
 'T4c':("const covered = open.length === covers.length && open.every(tomb => covers.some(c => c.inboxId === tomb.inboxId && c.revision === tomb.revision));","const covered = open.every(tomb => tomb.createdAt <= this.now());","T4a T4c (timestamp compare)"),
 'T6':("this.store.tx(() => { const fresh = this.store.getPark(botId); if (fresh?.keepOp === keepOp) this.store.casPark(botId, fresh.parkRev, { state: fresh.authorizedBy ? \"remove_authorized\" : \"parked\", keepOp: null, keepCovers: null, keepFailure: code }); });","/* mutant: no rollback */","T6"),
 'T22':("      if (park.remoteDeletedAt !== null) {\n        this.store.casPark(botId, park.parkRev, { state: park.authorizedBy","      if (false as boolean) {\n        this.store.casPark(botId, park.parkRev, { state: park.authorizedBy","T22"),
 'T23':("if (park.remoteDeletedAt !== null) { this.store.tx(() => { const fresh = this.store.getPark(park.botId); if (fresh?.state === \"keep_pending\")","if ((false as boolean)) { this.store.tx(() => { const fresh = this.store.getPark(park.botId); if (fresh?.state === \"keep_pending\")","T23"),
 'T26':("    if (this.options.secrets.botKey(botId)?.keyId === park.keyId) this.options.secrets.clearBotKey(botId);\n    this.cp(\"C14\");","    this.cp(\"C14\");","T26 C12 C13 C14"),
 'T27':("      const answer = await this.gate.deleteInbox(authority, null, park.inboxId);","      const answer = { kind: \"ok\", body: {} } as never;","T27"),
 'T29':("const state: BindingState = latest.step === \"restored\" ?","const state: BindingState = (false as boolean) ?","T29 (plain path)"),
 'C5':("        if (park.keepOp && !this.keepRuns.has(park.botId)) await this.runKeep(park.botId, park.keepOp).catch(() => undefined);","","C4 C5 (a crashed Keep is never resumed)"),
 'C7':("      this.cp(\"C7\");\n      const answer = await this.gate.deleteInbox(authority, start);","      this.cp(\"C7\");\n      await this.gate.deleteInbox(authority, start);\n      const answer = await this.gate.deleteInbox(authority, start);","C7 C8 (double DELETE)"),
}
n=sys.argv[1]; old,new,exp=M[n]
s=open(F).read(); assert s.count(old)==1,(n,s.count(old))
open(F,'w').write(s.replace(old,new)); print("expect red:",exp)
