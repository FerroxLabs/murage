import subprocess,sys,re,os
L=os.environ.get('MUTK_LANE','/root/fuigo-builds/swarm-b/mc63-ks-r32p')
W=L+'/wt/server/email/'
BS=W+'binding-service.ts'; RD=W+'exec-spec/keystore/reducer.ts'; IV=W+'exec-spec/keystore/invariants.current.ts'
K='server/email/exec-spec/keystore/'
PROD='npx vitest run server/email/reconnect-r32h.test.ts server/email/reconnect-r32k.test.ts'
SPEC='npx vitest run '+' '.join(K+f for f in ['r32h-product.test.ts','r32h.test.ts','r32h-opus.test.ts'])
WIT='npx vitest run '+K+'witness-pass.test.ts'
ROT='npx vitest run server/email/rotation-durable.test.ts server/email/binding-service.test.ts'
SAVE='this.options.secrets.setBotKey(botId, { token: minted.body.key, keyId: minted.body.key_id });'
NOTE='this.noteMinted(botId, minted.body.key_id);'
LOG=L+'/mj-tmp.log'
RAW='/tmp/v.raw'
KEEP='^ +(×|✓)|FAIL|Tests  |Test Files|Error|Failed|Unhandled|Cannot find|No test suite|Startup'
def run(cmd):
    """r3.2n (Astra Low). Vitest runs WITHOUT a pipe in front of it: its own exit status is echoed as VITEST_RC=<n>, and only afterwards is the raw output grepped.
    Fresh log per run. Returns the log text, or None when the wrapper itself failed."""
    if os.path.exists(LOG): os.remove(LOG)
    full=f"{cmd} > {RAW} 2>&1; echo VITEST_RC=$?; grep -E '{KEEP}' {RAW} | grep -v '✓' | head -150"
    p=subprocess.run(['bash',L+'/run.sh','mj-tmp','4000','6',full],capture_output=True,text=True,cwd=L)
    if p.returncode!=0 or not os.path.exists(LOG): return None
    return open(LOG).read()
LOADERR=re.compile(r'Startup Error|Failed to (resolve|load)|Cannot find (module|package)|ERR_MODULE_NOT_FOUND|No test suite found|Failed Suites|Unhandled|Transform failed|Error: .*(import|module)',re.I)
def suite_level_text(text):
    """The log with every test-level failure block removed. A block starts at `FAIL <file> > <suite> > <test>` and ends at the next marker: another FAIL line (a file-level FAIL
    ends it too), a `×` line, a Vitest header rule (a line starting with the box-drawing dash), VITEST_RC, or the Test Files / Tests summary."""
    keep=[]; inblock=False
    for l in text.splitlines():
        if re.match(r'\s*FAIL\b',l): inblock=' > ' in l
        elif re.match(r'\s*(×|⎯|VITEST_RC|Test Files|Tests\b)',l): inblock=False
        if not inblock: keep.append(l)
    return '\n'.join(keep)
def classify(text,base_total=None):
    """Returns (verdict, reason), verdict in green|red|bad. A run is RED only after a CLEAN suite completion: Vitest's own rc, a Test Files line and a Tests line,
    every FAIL line a test-level one (file > suite > test), no load error of any kind, and the same TOTAL test count as the green baseline of the same command
    (a suite that failed to load runs fewer tests). Anything else is bad."""
    if text is None: return ('bad','wrapper failed')
    rc=re.search(r'^VITEST_RC=(\d+)',text,re.M)
    if not rc: return ('bad','no VITEST_RC line (vitest status not captured)')
    vrc=int(rc.group(1))
    tf=re.search(r'Test Files\s+(.*)',text); tl=re.search(r'^\s*Tests\s+(.*)\((\d+)\)',text,re.M)
    if not tf or not tl: return ('bad','no Test Files / Tests summary (run did not complete)')
    fails=[l for l in text.splitlines() if re.match(r'\s*FAIL\b',l)]
    filelevel=[l for l in fails if ' > ' not in l]
    if filelevel: return ('bad','file-level FAIL (suite did not load): '+filelevel[0].strip()[:120])
    # r3.2p (Astra Low): load-error detection reads only the runner/suite-level part of the log. The lines of a TEST-level failure block (from `FAIL file > suite > test` to the next
    # marker) are removed first, so an assertion message or a ReferenceError that merely mentions an import or a module is not scored as a load error.
    suite_level=suite_level_text(text)
    if LOADERR.search(suite_level): return ('bad','load error: '+LOADERR.search(suite_level).group(0)[:80])
    total=int(tl.group(2))
    # r3.2o (Astra Low B): LOCATION decides, not the exception name. A ReferenceError or runtime SyntaxError raised INSIDE a test is a test-level failure (FAIL file > suite > test, same total): a genuine kill.
    # A module that failed to load shows as a file-level FAIL / fewer tests, both rejected above/below.
    if base_total is not None and total!=base_total: return ('bad','test count %d != baseline %d (a suite did not load fully)'%(total,base_total))
    failed_tests=bool(re.search(r'^ +×',text,re.M)) or ' failed' in tl.group(1) or bool(fails)
    if vrc==0 and not failed_tests:
        if re.search(r'^\s*(Error|TypeError|ReferenceError|SyntaxError|RangeError)\b',text,re.M): return ('bad','error line in a run that reports success')
        return ('green','')
    if vrc!=0 and failed_tests:
        # r3.2o (Astra Low A): a kill needs a successful baseline of the same command to compare the total against
        if base_total is None: return ('bad','no successful baseline for this command (cannot score a kill)')
        return ('red','')
    return ('bad','inconsistent: vitest rc=%d with failed_tests=%s'%(vrc,failed_tests))
BASE={}
def baseline(label,cmds):
    bad=0
    for c in cmds:
        t=run(c); v,why=classify(t,BASE.get(c))
        if v=='green' and c not in BASE: BASE[c]=int(re.search(r'^\s*Tests\s+.*\((\d+)\)',t,re.M).group(1))
        print('== '+label,c.replace('npx vitest run ','')[:90],'OK total=%s'%BASE.get(c) if v=='green' else 'NOT GREEN: %s %s'%(v,why))
        if v!='green': print(t); bad+=1
    return bad
def move(src,site_indent,anchor_after):
    """MOVE noteMinted: remove the noteMinted line at exactly this indent, re-insert it after the save line at the same indent."""
    pre='\n'+' '*site_indent
    line=pre+NOTE
    assert src.count(line+'\n')>=1
    return None
# (name, file, old, new, cmd)  old/new are exact strings; count must be exactly 1
M=[
# ---- carried (faithful rebuilds) ----
('newId-per-press',BS,'if (!fresh) {','if (false) {',PROD),
('skip-stray-delete',BS,'if (!(await this.revokeStray(botId, live, usedOp)))','if (false)',PROD),
('hold-skipped-revokes',BS,'live !== heldId && live !== this.rotation','live !== "never-matches" && live !== this.rotation',PROD),
('alert-no-key',BS,'`This bot already has another email key, ${keyId}. Revoke','`This bot already has another email key. Revoke',PROD),
('delete-unknown-X',BS,'own !== undefined && this.now() - own.at >= KEY_IDEMPOTENCY_WINDOW_MS;','(own === undefined || this.now() - own.at >= KEY_IDEMPOTENCY_WINDOW_MS);',PROD),
('revoke-inside-24h',BS,'own !== undefined && this.now() - own.at >= KEY_IDEMPOTENCY_WINDOW_MS;','own !== undefined;',PROD),
('copy-lines-swapped',BS,'live === heldId ? rotationHeldKeyDetail(live) : rotationOtherKeyDetail(live)','live === heldId ? rotationOtherKeyDetail(live) : rotationHeldKeyDetail(live)',PROD),
('owner-line-shows-secret',BS,': rotationOtherKeyDetail(live) }',': rotationOtherKeyDetail(live) + JSON.stringify(minted.error.fields) }',PROD),
('minted-after-save-setup',BS,'\n        '+NOTE+'\n        '+SAVE,'\n        '+SAVE+'\n        '+NOTE,PROD+' server/email/binding-service.test.ts'),
('rotation-order',BS,'\n      '+NOTE+'\n      const check','\n      const check',PROD),   # + re-insert after the 6-space save (see below)
('reconnect-order',BS,'\n    '+NOTE+'\n    // r3.2j (Astra 1) + r3.2k','\n    // r3.2j (Astra 1) + r3.2k',PROD),  # + re-insert after the 4-space save
('restamp-at-on-renote',BS,'if (list.find(item => item.keyId === keyId) === undefined) list.push({ keyId, at: now });','list.splice(0, list.length, ...list.filter(item => item.keyId !== keyId)); list.push({ keyId, at: now });',PROD),
('count-cap-20',BS,'JSON.stringify(kept)','JSON.stringify(kept.slice(-20))',PROD),
('no-serialize',BS,'return this.serial(botId, () => this.reconnectOnce(botId));','return this.reconnectOnce(botId);',PROD),
('no-current-op-check',BS,'if (!this.reconnectOpIsCurrent(botId, opId)) return false;','if (false) return false;',PROD),
('second-409-unrouted',BS,'for (let attempt = 0; minted.kind === "refused"','for (let attempt = 0; attempt < 1 && minted.kind === "refused"',PROD),
('spec-stray-inside-24h',RD,'if (isProtected(h, K) || !(now >= ownMint.at + H24))','if (isProtected(h, K))',SPEC),
('spec-no-alert-unknown-X',RD,'alertOnce(acts, b, "rotation_live_conflict"); // r3.2i','{} // r3.2i',SPEC),
('resolveUnknown-last-send',RD,'if (now >= i.at + H24) {\n    br("unk.windowLost")','if (now >= (u.last ?? i.at) + H24) {\n    br("unk.windowLost")',SPEC),
('spec-L1-protected-not-held',RD,'if (isProtected(h, K) || !(now >= ownMint.at + H24))','if (!(now >= ownMint.at + H24))',SPEC),
('spec-L1-guard-restored',RD,'&& i.newKeyId !== K && !tombstoned(h, K) && ownMint) {','&& i.newKeyId !== K && !isProtected(h, K) && !tombstoned(h, K) && ownMint) {',SPEC),
('spec-L2-ownKnown-silent',RD,'br("c409.ownKnownHold"); hold(h, b, i, "rotation_live_conflict", acts); }','br("c409.ownKnownHold"); alertOnce(acts, b, "rotation_live_conflict"); }',SPEC),
('spec-L2-ownKnown-no-alert-at-all',RD,'br("c409.ownKnownHold"); hold(h, b, i, "rotation_live_conflict", acts); }','br("c409.ownKnownHold"); }',SPEC),
('spec-prev-X-not-twin',RD,'if (!neverMinted && ownKnown(h).has(K))','if (ownKnown(h).has(K))',SPEC),
('spec-hold-queues-DELETE',RD,'if (isProtected(h, K) || !(now >= ownMint.at + H24)) { br("c409.mintHoldLive"); hold(h, b, i, "rotation_live_conflict", acts); return; }','if (isProtected(h, K) || !(now >= ownMint.at + H24)) { br("c409.mintHoldLive"); hold(h, b, i, "rotation_live_conflict", acts); emitCall(h, b, i, { kind: "delete", keyId: K, actor: "auto", cause: { by: "retire" } }, acts); return; }',SPEC),
# ---- r3.2k ----
('k-h1-no-generation-check',BS,'return !!current && sameBinding(current, start) && current.state === "restored_unverified";','return !!current;',PROD),
('k-h1-no-clear-on-removal',BS,'      this.store.clearCursor(RECONNECT_OP_SCOPE + start.botId);\n      this.store.clearCursor(ROTATE_SCOPE + start.botId);\n','',PROD),
('k-h1-no-clear-on-setup',BS,'      this.store.clearCursor(RECONNECT_OP_SCOPE + botId);\n      this.store.clearCursor(ROTATE_SCOPE + botId);\n      this.store.insertBinding(','      this.store.insertBinding(',PROD),
('k-h2-no-durable-wait',BS,'    if (!(await this.options.secrets.durable())) return { ok: false, code: "save_pending", status: 503 };\n','',PROD),
('k-h2-no-boot-resume',BS,'if (row.state === "restored_unverified" && this.reconnectPending(row.botId)) await this.reconnect(row.botId).catch(() => undefined);','',PROD),
('k-h2-no-clear-after-commit',BS,'    if (next) this.store.clearCursor(RECONNECT_OP_SCOPE + botId); // committed','    // committed',PROD),
('k-h2-no-recheck-after-durable',BS,'    if (!this.reconnectMaySave(botId, usedOp, row)) return { ok: false, code: "unavailable", status: 503 };\n    const latest','    const latest',PROD),
('k-m1-rotate-not-serial',BS,'return this.serial(botId, () => this.rotateKeyOnce(botId, canRotate));','return this.rotateKeyOnce(botId, canRotate);',PROD),
('k-m1-boot-rotation-not-serial',BS,'await this.serial(row.botId, async () => { const intent = this.rotation(row.botId); if (intent) await this.finishRotation(row.botId, intent); });','{ const intent = this.rotation(row.botId); if (intent) await this.finishRotation(row.botId, intent); }',PROD),
('k-m1-rotation-no-current-op-check',BS,'if (!start || !now || !LIVE_BINDING_STATES.has(now.state) || !sameBinding(now, start) || this.rotation(botId)?.opId !== intent.opId) return { ok: false, code: "not_active" };','if (!now || !LIVE_BINDING_STATES.has(now.state)) return { ok: false, code: "not_active" };',PROD),
('k-m4-no-cap',BS,'const strayOk = attempt < 3 && live','const strayOk = live',PROD),
('k-l1-intent-key-unprotected',BS,' && live !== this.rotation(botId)?.oldKeyId','',PROD),
('k-spec-m3-durable-X-bare-hold',RD,'durableKey(h, b) === K && d.mintLog.some((m) => m.keyId === K)) { br("c409.mintHoldLive")','durableKey(h, b) === K) { br("c409.mintHoldLive")',SPEC),
('k-spec-i13-24h-dropped-from-predicate',IV,'return !!entry && prev.now >= entry.at + H24;','return !!entry;',WIT),
('k-spec-i13-unminted-allowed',IV,'return !!entry && prev.now >= entry.at + H24;','return !entry || prev.now >= entry.at + H24;',WIT),
# ---- r3.2l ----
('l-m1-list-twin-no-drop',RD,'      dropQueued(h, (a) => a.a === "call" && a.bot === rb && a.kind !== "list" && (a.actor === "auto" || a.actor === "reconcile"));\n','',SPEC),
('l-m2-c409-twin-no-drop',RD,'      dropQueued(h, (a) => a.a === "call" && a.bot === b && a.kind !== "list" && (a.actor === "auto" || a.actor === "reconcile"));\n','',SPEC),
('l-m3-no-state-clause',BS,'return !!current && sameBinding(current, start) && current.state === "restored_unverified";','return !!current && sameBinding(current, start);',PROD),
('l-reconnect-no-sameBinding-either-check',BS,'return !!current && sameBinding(current, start) && current.state === "restored_unverified";','return !!current && current.state === "restored_unverified";',PROD),
('l-reconnect-no-presave-check',BS,'    if (!this.reconnectMaySave(botId, usedOp, row)) return { ok: false, code: "unavailable", status: 503 };\n    this.options.secrets.setBotKey(','    this.options.secrets.setBotKey(',PROD),
('l-rot-no-sameBinding-presave',BS,'!sameBinding(now, start) || this.rotation','this.rotation',PROD),
('l-rot-no-opcheck-presave',BS,'|| this.rotation(botId)?.opId !== intent.opId) return { ok: false, code: "not_active" };\n      this.options.secrets.setBotKey(',') return { ok: false, code: "not_active" };\n      this.options.secrets.setBotKey(',PROD),
('l-m4-no-recheck-after-durable',BS,'      if (!start || !latest || !LIVE_BINDING_STATES.has(latest.state) || !sameBinding(latest, start) || this.rotation(botId)?.opId !== intent.opId) return { ok: false, code: "not_active" };\n','      if (!latest || !LIVE_BINDING_STATES.has(latest.state)) return { ok: false, code: "not_active" };\n',PROD),
('l-m4-no-sameBinding-after-durable',BS,'!sameBinding(latest, start) || this.rotation','this.rotation',PROD),
('l-m4-no-opcheck-after-durable',BS,'!sameBinding(latest, start) || this.rotation(botId)?.opId !== intent.opId) return','!sameBinding(latest, start)) return',PROD),
('l-pending-op-age-dropped',BS,' && this.now() - saved.at < KEY_IDEMPOTENCY_WINDOW_MS;',';',PROD),
('l-i13-via409-not-propagated',RD,'const via409 = !!i.from409?.includes(K);','const via409 = false;',SPEC),
('l-i13-from409-not-recorded',RD,'(i.from409 ??= []).includes(K) || i.from409.push(K); ','',SPEC),
# ---- r3.2m ----
('m-m1-no-state-after-durable',BS,'!LIVE_BINDING_STATES.has(latest.state) || ','',PROD),
('m-m1-no-state-before-save',BS,'!LIVE_BINDING_STATES.has(now.state) || ','',PROD),
('m-m2-no-removed-guard',RD,'      if (!liveBinding(h, b)) { br("c409.removedNoTwin"); return; }\n','',SPEC),
('m-i6c-409-no-live-filter',IV,'&& liveBinding(h, op.bot) ? [{ bot: op.bot, key: k, fromList: false }] : [];','? [{ bot: op.bot, key: k, fromList: false }] : [];',WIT),
('m-i14-always-true',IV,'h.durable.bindings[b].state !== "removed" || !defined(h.durable.twinKeyLive[b])));','true));',WIT),
('m-pending-boundary-le-boot',BS,'typeof saved.at === "number" && this.now() - saved.at < KEY_IDEMPOTENCY_WINDOW_MS;','typeof saved.at === "number" && this.now() - saved.at <= KEY_IDEMPOTENCY_WINDOW_MS;',PROD),
('m-pending-boundary-le-reuse',BS,'this.now() - saved.at < KEY_IDEMPOTENCY_WINDOW_MS) return saved.opId;','this.now() - saved.at <= KEY_IDEMPOTENCY_WINDOW_MS) return saved.opId;',PROD),
('m-list-twin-auto-only',RD,'a.bot === rb && a.kind !== "list" && (a.actor === "auto" || a.actor === "reconcile"));','a.bot === rb && a.kind !== "list" && a.actor === "auto");',SPEC),
('m-c409-twin-auto-only',RD,'a.bot === b && a.kind !== "list" && (a.actor === "auto" || a.actor === "reconcile"));','a.bot === b && a.kind !== "list" && a.actor === "auto");',SPEC),
('m-sameBinding-no-opId',BS,'a.inboxId === b.inboxId && a.opId === b.opId && a.emailKeyRef === b.emailKeyRef','a.inboxId === b.inboxId && a.emailKeyRef === b.emailKeyRef',PROD),
('m-from409-lost-on-boot',RD,'m.running = true; delete (m as MemX).busy;','m.running = true; delete (m as MemX).busy; for (const ii of Object.values(h.durable.intents)) delete (ii as IntentX).from409;',SPEC),
# ---- r3.2n ----
('n-l1-no-unk-alert',RD,'      else if (i && !mine && i.unk) alertOnce(acts, b, "rotation_live_conflict");\n','',SPEC),
('n-l1-alert-without-unk',RD,'else if (i && !mine && i.unk) alertOnce(','else if (i && !mine) alertOnce(',SPEC),
('n-l3-oracle-trusts-flag',IV,'if (c.cause.via409 !== true && !observed409) return true;','if (c.cause.via409 !== true) return true;',WIT),
('n-l3-oracle-only-prev-ops',IV,'[prev, next].some((w) => Object.values(w.ops)','[prev].some((w) => Object.values(w.ops)',WIT),
('n-l3-reducer-flag-wrong-key',RD,'(i.from409 ??= []).includes(K) || i.from409.push(K); ','(i.from409 ??= []).includes(K) || i.from409.push(K + "x"); ',SPEC),
('n-l3-reducer-flag-cause-dropped',RD,'(via409 ? ({ by: "stray", opId: entry.opId, via409: true } as const) : ({ by: "stray", opId: entry.opId } as const))','({ by: "stray", opId: entry.opId } as const)',SPEC),
# ---- r3.2o ----
('o-l1-alert-mint-only',RD,'else if (i && !mine && i.unk) alertOnce(','else if (i && !mine && i.unk && ev.kind === "mint") alertOnce(',SPEC),
('o-l3-oracle-any-home',IV,'o.home === c.home && o.kind === "mint" && o.delivered.some((r) => r.code === 409','o.kind === "mint" && o.delivered.some((r) => r.code === 409',WIT),
# ---- r3.2p ----
('p-l1-alert-bot-key-exists-only',RD,'else if (i && !mine && i.unk) alertOnce(','else if (i && !mine && i.unk && r.error === "bot_key_exists") alertOnce(',SPEC),
('p-l3-oracle-no-key-equality',IV,'o.delivered.some((r) => r.code === 409 && r.error === "bot_key_exists" && r.keyId === keyId)','o.delivered.some((r) => r.code === 409 && r.error === "bot_key_exists")',WIT),
('p-l3-from409-lost-on-second-boot',RD,'m.running = true; delete (m as MemX).busy;','m.running = true; delete (m as MemX).busy; for (const ii of Object.values(h.durable.intents)) { const x = ii as IntentX & { bootSeen?: boolean }; if (x.bootSeen) delete x.from409; x.bootSeen = true; }',SPEC),
]
def selftest():
    """Proves the classifier: canned logs, then a real run whose test file has a broken import."""
    good='VITEST_RC=0\n Test Files  3 passed (3)\n      Tests  93 passed (93)\n'
    cases=[
     ('green',good,'green'),
     ('red: test-level FAIL, rc 1','VITEST_RC=1\n FAIL  a.test.ts > s > t\n   ×  s > t\n Test Files  1 failed | 2 passed (3)\n      Tests  1 failed | 92 passed (93)\n','red'),
     ('pipe masked: load failure, rc 0 (the old runner took this as passing)','VITEST_RC=0\n FAIL  a.test.ts\nError: Failed to resolve import "./x" from "a.test.ts"\n Test Files  1 failed | 2 passed (3)\n      Tests  60 passed (60)\n','bad'),
     ('load failure, rc 1, other tests pass','VITEST_RC=1\n FAIL  a.test.ts [ a.test.ts ]\nError: Failed to resolve import\n Test Files  1 failed | 2 passed (3)\n      Tests  60 passed (60)\n','bad'),
     ('ordinary Error line with all tests passing','VITEST_RC=0\nTypeError: Cannot read properties of undefined\n Test Files  3 passed (3)\n      Tests  93 passed (93)\n','bad'),
     ('no VITEST_RC','Test Files  3 passed (3)\n      Tests  93 passed (93)\n','bad'),
     ('rc 1 with no failure at all','VITEST_RC=1\n Test Files  3 passed (3)\n      Tests  93 passed (93)\n','bad'),
     ('test-level ReferenceError is a genuine kill (same total)','VITEST_RC=1\n FAIL  a.test.ts > s > t\nReferenceError: zz is not defined\n   ×  s > t\n Test Files  1 failed | 2 passed (3)\n      Tests  1 failed | 92 passed (93)\n','red'),
     ('test-level runtime SyntaxError (bad JSON.parse) is a genuine kill','VITEST_RC=1\n FAIL  a.test.ts > s > t\nSyntaxError: Unexpected token } in JSON at position 3\n   ×  s > t\n Test Files  1 failed | 2 passed (3)\n      Tests  1 failed | 92 passed (93)\n','red'),
     ('load-time ReferenceError: file-level FAIL, fewer tests','VITEST_RC=1\n FAIL  a.test.ts [ a.test.ts ]\nReferenceError: zz is not defined\n Test Files  1 failed | 2 passed (3)\n      Tests  60 passed (60)\n','bad'),
     ('red but fewer tests than baseline','VITEST_RC=1\n FAIL  a.test.ts > s > t\n   ×  s > t\n Test Files  1 failed | 2 passed (3)\n      Tests  1 failed | 60 passed (61)\n','bad'),
     # r3.2p (Astra Low): classification is by failure LOCATION, so a test-level message is never read as a load error
     ('test-level ReferenceError whose message names a module (moduleState)','VITEST_RC=1\n FAIL  a.test.ts > s > t\nReferenceError: moduleState is not defined\n   ×  s > t\n Test Files  1 failed | 2 passed (3)\n      Tests  1 failed | 92 passed (93)\n','red'),
     ('test-level assertion message that contains "import"','VITEST_RC=1\n FAIL  a.test.ts > s > t\nAssertionError: expected the import map to equal 1\n   ×  s > t\n Test Files  1 failed | 2 passed (3)\n      Tests  1 failed | 92 passed (93)\n','red'),
     ('test-level failure followed by a suite-level load error under a header rule (still bad)','VITEST_RC=1\n FAIL  a.test.ts > s > t\n   ×  s > t\n ⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯\n FAIL  b.test.ts [ b.test.ts ]\nError: Failed to resolve import "./x" from "b.test.ts"\n Test Files  1 failed | 2 passed (3)\n      Tests  1 failed | 92 passed (93)\n','bad'),
     ('test-level failure, then a Failed Suites header with no file-level FAIL (still bad)','VITEST_RC=1\n FAIL  a.test.ts > s > t\nAssertionError: x\n   ×  s > t\n ⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯\n Test Files  1 failed | 2 passed (3)\n      Tests  1 failed | 92 passed (93)\n','bad'),
    ]
    ok=True
    nb='VITEST_RC=1\n FAIL  a.test.ts > s > t\n   ×  s > t\n Test Files  1 failed | 2 passed (3)\n      Tests  1 failed | 92 passed (93)\n'
    cases.append(('NO successful baseline: an ordinary assertion failure must not score RED',nb,'bad',None))
    for c in cases:
        name,text,want=c[:3]; bt=c[3] if len(c)>3 else 93
        v,why=classify(text,bt); good_=v==want; ok&=good_
        print('SELFTEST canned',name,'->',v,'(want %s)'%want,'OK' if good_ else 'WRONG',why)
    # real: a test file with a deliberately broken import must be BAD, never RED
    tf=W+'exec-spec/keystore/r32h.test.ts'; orig=open(tf).read()
    print('SELFTEST real: baseline of SPEC'); ok&=baseline('selftest',[SPEC])==0
    open(tf,'w').write('import "./zz-does-not-exist-r32n.ts";\n'+orig)
    try: t=run(SPEC)
    finally: open(tf,'w').write(orig)
    v,why=classify(t,BASE.get(SPEC)); print('SELFTEST real broken-import ->',v,why); print(t); ok&=(v=='bad')
    # control: a real mutation on the same suite is RED
    mf=RD; mo=open(mf).read(); old='      if (!liveBinding(h, b)) { br("c409.removedNoTwin"); return; }\n'
    assert mo.count(old)==1; open(mf,'w').write(mo.replace(old,''))
    try: t=run(SPEC)
    finally: open(mf,'w').write(mo)
    v,why=classify(t,BASE.get(SPEC)); print('SELFTEST real genuine mutant ->',v,why); ok&=(v=='red')
    print('SELFTEST',"PASS" if ok else "FAIL"); sys.exit(0 if ok else 1)
if sys.argv[1:2]==['--selftest']: selftest()
only=sys.argv[1:]
CMDS=[]
for x in M:
    if x[4] not in CMDS and (not only or x[0] in only): CMDS.append(x[4])
bad=baseline('GREEN before',CMDS)
killed=0; ran=0
for name,f,old,new,cmd in M:
    if only and name not in only: continue
    ran+=1
    if cmd not in BASE: print('== MUTANT',name,'BAD: no successful baseline for its command, not scored'); bad+=1; continue
    src=open(f).read(); bak=src
    if src.count(old)!=1: print('== MUTANT',name,'NOT APPLIED (count %d)'%src.count(old)); bad+=1; continue
    src=src.replace(old,new)
    if name=='rotation-order':
        a='\n      '+SAVE; assert src.count(a)==1; src=src.replace(a,a+'\n      '+NOTE)
    if name=='reconnect-order':
        a='\n    '+SAVE; assert src.count(a)==1; src=src.replace(a,a+'\n    '+NOTE)
    open(f,'w').write(src)
    try: out=run(cmd)
    finally: open(f,'w').write(bak)
    v,why=classify(out,BASE.get(cmd))
    if v=='bad': print('== MUTANT',name,'BAD (not a clean run):',why); print((out or '')[:600]); bad+=1; continue
    print('== MUTANT',name,'RED' if v=='red' else 'SURVIVED'); print('\n'.join(l for l in out.splitlines() if '×' in l or 'Tests' in l)[:1500])
    sys.stdout.flush()
    if v=='red': killed+=1
    else: bad+=1
bad+=baseline('GREEN after',CMDS)
print('MUTANT SUMMARY killed=%d/%d bad=%d'%(killed,ran,bad))
sys.exit(1 if bad else 0)
