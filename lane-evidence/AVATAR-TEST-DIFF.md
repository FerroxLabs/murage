# Avatar test diff evidence

Review Medium 2, 2026-11-06. Base: `a5450e2b532fdb4e66dc8aaf1a1c83f20422dc41`.

## Scope and stat

Captured with `git diff --stat a5450e2b53 HEAD` at HEAD `d9c6674c42ef5878161c8e3e36a14c05edee5da6` (before adding this evidence and its audit test).

```text
 .github/workflows/ci.yml                           |   2 +-
 ci/extended-tests.txt                              |   1 -
 ci/gate-tests.txt                                  |   4 +
 extensions/murage-browser/runtime.mjs              |  18 +-
 .../murage-browser/sidepanel/PANEL-CONTRACT.md     |   3 +
 extensions/murage-browser/sidepanel/controller.mjs |  24 +-
 extensions/murage-browser/sidepanel/panel.css      |   2 +-
 .../sidepanel/sidepanel.node-test.mjs              |  28 ++
 extensions/murage-browser/sidepanel/view.mjs       |   8 +-
 package.json                                       |   2 +-
 scripts/after-pack-memory.test.mjs                 |   6 +
 scripts/after-pack.mjs                             |   2 +-
 scripts/browser-extension-idle.node-test.mjs       |  15 +-
 scripts/browser-extension-x1.node-test.mjs         |  36 +++
 scripts/bundle-server.mjs                          |   1 +
 .../fixtures/browser-extension-protocol-1.0.0.ts   |  99 +++++++
 server/attachment-read.ts                          |   8 +
 server/browser-extension-avatar.test.ts            | 286 +++++++++++++++++++++
 server/browser-extension-broker.test.ts            |  13 +-
 server/browser-extension-broker.ts                 |   1 +
 server/browser-extension-integration.ts            |   5 +-
 server/browser-extension-panel-avatar-encoder.ts   |  50 ++++
 server/browser-extension-panel-avatar-source.ts    |  32 +++
 server/browser-extension-panel-avatar.test.ts      |  94 +++++++
 server/browser-extension-panel-avatar.ts           | 199 ++++++++++++++
 server/browser-extension-service.ts                |  73 +++++-
 server/index.ts                                    |  10 +-
 server/proxy-paths.test.ts                         |   7 +
 shared/browser-extension-protocol.ts               |   2 +-
 shared/spawned-proxies.d.mts                       |   1 +
 shared/spawned-proxies.mjs                         |   1 +
 31 files changed, 1007 insertions(+), 26 deletions(-)
```

## Changed assertions and timeouts

No pre-existing assertion or timeout was removed or modified. Added assertions are listed verbatim below in the complete zero-context diffs of every changed pre-existing test file. No existing timing threshold was weakened. Newly created test files are not pre-existing tests.

Reproduce each inventory with `git diff --no-ext-diff --unified=0 a5450e2b53 HEAD -- <file>`.

### extensions/murage-browser/sidepanel/sidepanel.node-test.mjs

Adds picture rendering and controller fetch/deduplication assertions; existing assertions unchanged.

```diff
diff --git a/extensions/murage-browser/sidepanel/sidepanel.node-test.mjs b/extensions/murage-browser/sidepanel/sidepanel.node-test.mjs
index 28e651828a..171317943a 100644
--- a/extensions/murage-browser/sidepanel/sidepanel.node-test.mjs
+++ b/extensions/murage-browser/sidepanel/sidepanel.node-test.mjs
@@ -76,0 +77,28 @@ test('header has the Murage mark, the brand and the lighter for-Chrome suffix',
+test('CHROME-PANEL-AVATAR: the bot card shows the bot picture the app sent, and the letter when there is none or it is not a plain image', () => {
+  const pic = 'data:image/webp;base64,UklGRgAAAABXRUJQ';
+  const withPic = one(draw({ botName: 'Sable', botAvatar: pic }).root, 'avatar');
+  const img = one(withPic, 'avatar-image'); assert.ok(img, 'an <img> is drawn'); assert.equal(img.tagName, 'IMG');
+  assert.equal(img.getAttribute('src'), pic); assert.equal(img.getAttribute('alt'), '');
+  assert.equal(withPic.textContent, '', 'no letter under the picture'); assert.equal(withPic.getAttribute('aria-hidden'), 'true');
+  for (const bad of [undefined, '', 'https://tracker.example/p.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'javascript:alert(1)', `data:image/png;base64,${'A'.repeat(16384)}`, 7]) {
+    const av = one(draw({ botName: 'Sable', botAvatar: bad }).root, 'avatar');
+    assert.equal(byRole(av, 'avatar-image').length, 0, String(bad).slice(0, 40)); assert.equal(av.textContent, 'S');
+  }
+  assert.match(readFileSync(new URL('panel.css', here), 'utf8'), /\.av img\{[^}]*object-fit:cover/);
+});
+test('CHROME-PANEL-AVATAR (Astra r1 scale): the controller asks for the shown bot picture once per id; statuses carry ids only', async () => {
+  const pic = 'data:image/webp;base64,UklGRgAAAABXRUJQ', asked = [];
+  const bindings = [{ bindingId: 'a', botName: 'Sable', state: 'active', botAvatarId: '0123456789abcdef' }, { bindingId: 'b', botName: 'Ember', state: 'active', botAvatarId: 'fedcba9876543210' }];
+  const views = [];
+  const c = createController({ extensionId: 'me', onChange: v => views.push(v), send: async m => { if (m.action === 'avatar') { asked.push(m.bindingId); return { result: { botAvatarId: m.bindingId === 'a' ? '0123456789abcdef' : 'fedcba9876543210', botAvatar: pic } }; } return { result: { connected: true, bindings } }; } });
+  const push = () => c.push({ type: PUSH_TYPE, status: { version: 1, connected: true, bindings } }, { id: 'me' });
+  for (let i = 0; i < 5; i++) { push(); await new Promise(r => setTimeout(r, 0)); }
+  assert.deepEqual(asked, ['a'], 'only the bot shown, only once');
+  assert.equal(c.view().bindings.find(b => b.bindingId === 'a').botAvatar, pic);
+  assert.ok(!('botAvatar' in c.view().bindings.find(b => b.bindingId === 'b')));
+  c.select('b'); await new Promise(r => setTimeout(r, 0)); assert.deepEqual(asked, ['a', 'b']);
+  // A picture the runtime answers with the wrong id or a non-image is not drawn.
+  const bad = createController({ extensionId: 'me', send: async m => m.action === 'avatar' ? { result: { botAvatarId: 'ffffffffffffffff', botAvatar: pic } } : { result: {} } });
+  bad.push({ type: PUSH_TYPE, status: { version: 1, connected: true, bindings: bindings.slice(0, 1) } }, { id: 'me' }); await new Promise(r => setTimeout(r, 0));
+  assert.ok(!('botAvatar' in bad.view().bindings[0]));
+});
```

### scripts/after-pack-memory.test.mjs

Adds a required-helper fixture file and an assertion that missing packaged encoder is rejected; existing assertions unchanged.

```diff
diff --git a/scripts/after-pack-memory.test.mjs b/scripts/after-pack-memory.test.mjs
index a453b7964e..80b5804c72 100644
--- a/scripts/after-pack-memory.test.mjs
+++ b/scripts/after-pack-memory.test.mjs
@@ -21,0 +22 @@ function fixture(platform,arch,flat=false){
+  fs.writeFileSync(path.join(server,"browser-extension-panel-avatar-encoder.js"),"// fixture module presence only\n");
@@ -146,0 +148,5 @@ it("requires the exact WebAssembly executor on every target, Intel macOS include
+
+it("requires the panel avatar encoder helper in the packaged runtime", async () => {
+  const f=fixture("linux","x64");fs.unlinkSync(path.join(f.root,"server/browser-extension-panel-avatar-encoder.js"));
+  await expect(validatePackagedMemoryRuntime(f.root,"linux","x64")).rejects.toThrow("browser-extension-panel-avatar-encoder.js");
+});
```

### scripts/browser-extension-idle.node-test.mjs

Adds optional parser injection and E5 historical parser/hash/disconnect assertions; existing assertions (including version 1.0.1) unchanged.

```diff
diff --git a/scripts/browser-extension-idle.node-test.mjs b/scripts/browser-extension-idle.node-test.mjs
index 7aa47d8187..ea7745562c 100644
--- a/scripts/browser-extension-idle.node-test.mjs
+++ b/scripts/browser-extension-idle.node-test.mjs
@@ -1,0 +2,2 @@
+import { createHash } from 'node:crypto';
+import { parseBrowserExtensionMessage as oldParser } from './fixtures/browser-extension-protocol-1.0.0.ts';
@@ -16 +18 @@ function event() {
-async function fixture({ stored = {}, now = 1_000_000, random = 0.5, absent = true, busy = () => false, storageFails = false } = {}) {
+async function fixture({ stored = {}, now = 1_000_000, random = 0.5, absent = true, busy = () => false, storageFails = false, parseCommand } = {}) {
@@ -21 +23 @@ async function fixture({ stored = {}, now = 1_000_000, random = 0.5, absent = tr
-    handlePanel: async () => ({}), handleRequest: async () => ({ result: {} }),
+    handlePanel: async () => ({}), handleRequest: async message => { parseCommand?.(message); return { result: {} }; },
@@ -227,0 +230,9 @@ test('manifest excludes incognito profiles and is version 1.0.1', () => {
+
+test('E5: historical 1.0.0 parser rejects avatar and the real worker disconnects',async()=>{
+ const bytes=readFileSync(new URL('./fixtures/browser-extension-protocol-1.0.0.ts',import.meta.url));
+ assert.equal(createHash('sha256').update(bytes).digest('hex'),'4048cf7a81586eab1e9775acf0db06a29f8658740ef2d2113286ff0f04adf69b');
+ const frame={version:1,type:'command',id:'request',bindingId:'bot',generation:1,operation:'avatar',params:{avatarId:''}};
+ assert.throws(()=>oldParser(frame));
+ const f=await fixture({absent:false,parseCommand:oldParser});let disconnected=false;
+ f.ports[0].disconnect=()=>{disconnected=true;};await f.ports[0].onMessage.fire(frame);assert.equal(disconnected,true);
+});
```

### scripts/browser-extension-x1.node-test.mjs

Adds E1–E4/E6/E7 memory-only state, validation, generation, clear, restart, and capability assertions; existing assertions unchanged.

```diff
diff --git a/scripts/browser-extension-x1.node-test.mjs b/scripts/browser-extension-x1.node-test.mjs
index fa5c53740c..68c33e014a 100644
--- a/scripts/browser-extension-x1.node-test.mjs
+++ b/scripts/browser-extension-x1.node-test.mjs
@@ -578,0 +579,36 @@ test('R1: the resumed event carries resumedAt, the generation ownerResume made,
+
+const avatarData = 'data:image/webp;base64,AAAA';
+const avatarId = 'aaaaaaaaaaaaaaaa';
+test('E1/E2/E3/E4/E6: avatar only changes memory, validates and clears independently of panel', async () => {
+  const f = fixture(); await f.init();
+  const before = await f.command('status'); const writes = f.setCalls.length;
+  const sent = f.sent.length;
+  assert.deepEqual((await f.command('avatar', { avatarId, data: avatarData })).result, { avatarId });
+  assert.equal(f.setCalls.length, writes); assert.ok(f.sent.length > sent);
+  const after = await f.command('status');
+  assert.deepEqual({ ...after.result, avatarId: before.result.avatarId }, before.result);
+  assert.equal(after.result.avatarId, avatarId);
+  assert.deepEqual(await f.runtime.handlePanel({action:'avatar',bindingId:'bot_a'}),{botAvatarId:avatarId,botAvatar:avatarData});
+  for (const params of [{avatarId:'bad',data:avatarData},{avatarId,data:'data:image/svg+xml;base64,AAAA'},{avatarId,data:'https://example.com/a.png'},{avatarId,data:'A'.repeat(16385)}]) {
+    assert.equal((await f.command('avatar',params)).error.code,'invalid_params');
+    assert.equal((await f.command('status')).result.avatarId,avatarId);
+  }
+  assert.equal((await f.command('avatar',{avatarId:''},2)).error.code,'stale_generation');
+  // A save for another reason must strip both avatar fields.
+  await f.bind();
+  assert.equal(JSON.stringify(persisted(f)).includes('botAvatar'),false);
+  const withoutPicture=fixture();await withoutPicture.init();await withoutPicture.bind();
+  assert.equal(JSON.stringify(persisted(f)),JSON.stringify(persisted(withoutPicture)), 'serialized storage shape and bytes are independent of the picture');
+  // initialize on the original fake API reproduces a worker restart over its saved state.
+  const restarted = createBrowserExtensionRuntime(f.api); await restarted.initialize();
+  const restored = await restarted.handlePanel({action:'status'});
+  assert.equal(JSON.stringify(restored).includes(avatarData),false);
+  await restarted.connection(true);
+  const restoredSummary=await restarted.handleRequest({version:1,type:'command',id:`${'b'.repeat(32)}_1`,bindingId:'bot_a',generation:1,operation:'status',params:{}});
+  assert.equal(restoredSummary.result.avatarId,'');
+  assert.equal((await f.command('avatar',{avatarId:''})).result.avatarId,'');
+  await f.bind(); await f.command('status',{panel:{botAvatarId:avatarId,botAvatar:avatarData}});
+  assert.equal((await f.command('status')).result.avatarId,'');
+});
+
+test('E7: hello advertises panel_avatar_v1',async()=>{const f=fixture();await f.runtime.initialize();assert.ok((await f.runtime.connection(true)).capabilities.includes('panel_avatar_v1'));});
```

### server/browser-extension-broker.test.ts

Adds avatar capacity refusal and connection-preservation assertions inside request-id rotation coverage and T19c for the final pending slot. Existing assertions unchanged. The fixture root accepts MURAGE_TEST_TMPDIR for lane-local socket tests; no timing threshold changes.

```diff
diff --git a/server/browser-extension-broker.test.ts b/server/browser-extension-broker.test.ts
index 26caf1409d..3cf69cf49a 100644
--- a/server/browser-extension-broker.test.ts
+++ b/server/browser-extension-broker.test.ts
@@ -10 +10 @@ import { removeTempDir } from "./testing/cleanup.ts";
-const SHORT_ROOT = process.platform === 'win32' ? os.tmpdir() : realpathSync('/tmp');
+const SHORT_ROOT = process.platform === 'win32' ? os.tmpdir() : realpathSync(process.env.MURAGE_TEST_TMPDIR ?? '/tmp');
@@ -243,0 +244,4 @@ describe('Astra 13: a connection that used all its request ids is rotated', () =
+      if (i === 3) {
+        await expect(broker.request('profile', { ...command, operation: 'avatar', id: 'cosmetic', params: { avatarId: '' } })).rejects.toThrow('broker_busy');
+        expect(broker.profiles()).toHaveLength(1);
+      }
@@ -279,0 +284,7 @@ describe("Vultr live bug 1: one oversize or too-deep response never destroys the
+
+it('T19c: avatar cannot take the last pending slot, a bind can',async()=>{
+ const f=await fixture();const jobs=Array.from({length:31},(_,i)=>f.broker.request('profile',{...command,id:'pending'+i}).catch(()=>undefined));
+ await expect(f.broker.request('profile',{...command,id:'avatar',operation:'avatar',params:{avatarId:''}})).rejects.toThrow('broker_busy');
+ const bind=f.broker.request('profile',{...command,id:'last-bind',operation:'bind'}).catch(()=>undefined);
+ await expect.poll(()=>f.messages.length).toBe(32);expect(f.broker.profiles()).toHaveLength(1);f.host.stop();await Promise.all([...jobs,bind]);
+});
```

### server/proxy-paths.test.ts

Adds encoder source, bundle entry and packaged inventory assertions; existing assertions unchanged.

```diff
diff --git a/server/proxy-paths.test.ts b/server/proxy-paths.test.ts
index 0ea0668bb7..c90573a555 100644
--- a/server/proxy-paths.test.ts
+++ b/server/proxy-paths.test.ts
@@ -26,0 +27,7 @@ it("resolves a worker path with no backslash or drive assumption (the same join
+
+it("packages and resolves the panel avatar child through the shared launch inventory", () => {
+  expect(SPAWNED_PROXIES.panelAvatarEncoder).toBe(join(SERVER_ROOT, "browser-extension-panel-avatar-encoder.ts"));
+  expect(existsSync(SPAWNED_PROXIES.panelAvatarEncoder)).toBe(true);
+  expect(readFileSync(join(repo, "scripts/bundle-server.mjs"), "utf8")).toContain('"browser-extension-panel-avatar-encoder.ts"');
+  expect(readFileSync(join(repo, "scripts/after-pack.mjs"), "utf8")).toContain('path.join(server, "browser-extension-panel-avatar-encoder.js")');
+});
```

## Protected records

`git diff a5450e2b53 HEAD -- FIX-LEDGER.md HANDOFF-CHROME-PANEL-AVATAR.md` produces empty output (exit 0). Both files have an empty diff against the base. The audit test checks this independently.

## Regression proof

Historical note: that lock file was removed in 7042939bdd because CI cannot run it. Before this file existed, it exited 1 with ENOENT for AVATAR-TEST-DIFF.md. After adding this complete inventory it passes. The check also verifies every recorded pre-existing test diff and protected-record preservation.
