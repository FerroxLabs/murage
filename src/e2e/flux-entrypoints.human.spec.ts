import { expect, test } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigStatus } from '../state/store';
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";

// Real settings/Models/PasteKeys, controlled empty-workspace backend. The
// onboarding screen that used to open Models (Onboarding.tsx) was replaced by
// the first-run conversation in 0.1.58 (311387b1); Models opens here as the
// first-run Flux card and PasteKeys open it (toggleAppSettings, section models).
// This fixture verifies navigation and write boundaries, not provider readiness.
let server: ViteDevServer, origin: string, cache: string;
let failStatus = false;
let boxConfigured = false;
let writes: Array<{ path: string; body: Record<string, unknown> }> = [];
let pageErrors: string[] = [];
const proof = 'ab'.repeat(32);
const config: ConfigStatus = {
  composio: { configured: false, mode: 'managed' },
  box: { configured: false },
  vps: { configured: false, sshAlias: '' },
  rooms: { turnTimeoutMinutes: 15 },
  localVm: { mode: 'shared', maxInstances: 1 },
  flux: { configured: false },
  profile: { name: '', email: '' },
};
const instance = { instanceId: 'fuigo', driverKind: 'fuigoAgent', displayName: 'Fuigo', enabled: true, access: 'subscription', models: { default: '', options: [] }, snapshot: { state: 'available', authenticated: false }, install: {} };
test.beforeAll(async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  cache = mkdtempSync(join(tmpdir(), 'murage-flux-entry-vite-'));
  server = await createServer({ configFile: false, root, envFile: false, cacheDir: cache,
    resolve: { alias: { '@': `${root}/src` } }, server: { host: '127.0.0.1', strictPort: true, watch: null, hmr: false },
    plugins: [tailwindcss(), {
      name: 'flux-entrypoint-fixture',
      resolveId(id) { if (id === '/__flux-entry.js') return '\0flux-entrypoint-fixture'; },
      load(id) {
        if (id.endsWith('/src/styles.css')) return readFileSync(id, 'utf8').replace('@import "tailwindcss";', '@import "tailwindcss" source(none);\n@source "./components";');
        if (id !== '\0flux-entrypoint-fixture') return;
        return `import React from 'react';import {createRoot} from 'react-dom/client';import {StoreProvider,useStore} from '/src/state/store.tsx';import {SettingsModal} from '/src/components/SettingsModal.tsx';import '/src/styles.css';
          function Fixture(){const store=useStore();window.fixtureStore=store;return React.createElement(React.Fragment,null,store.state.appSettingsOpen&&React.createElement(SettingsModal),React.createElement('button',{type:'button',onClick:()=>store.dispatch({type:'toggleAppSettings',open:true,section:'models'})},'Open Models settings'));}
          createRoot(document.getElementById('root')).render(React.createElement(StoreProvider,null,React.createElement(Fixture)));`;
      },
      configureServer(vite) { vite.middlewares.use((req,res,next) => {
        const path = new URL(req.url ?? '/', 'http://fixture').pathname;
        const json = (value: unknown, status = 200) => { res.statusCode=status;res.setHeader('content-type','application/json');res.end(JSON.stringify(value)); };
        if (path === '/__flux-entry') { res.setHeader('content-type','text/html');res.end('<html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Flux entrypoint fixture</title></head><body><div id="root"></div><script type="module" src="/__flux-entry.js"></script></body></html>'); }
        else if (path === '/api/desktop-secret') json({ secret: proof });
        else if (path === '/api/config' && req.method === 'GET') json({ ...config, box: { configured: boxConfigured }, surface: req.headers['x-murage-surface-secret'] === proof ? 'desktop' : 'remote' });
        else if (path === '/api/config' && req.method === 'PUT') { let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{const change=JSON.parse(body);writes.push({path,body:change});if(Object.keys(change).length!==1||typeof change.box?.token!=='string'){json({error:'Unexpected fixture config change'},409);return;}boxConfigured=Boolean(change.box.token);json({...config,box:{configured:boxConfigured}});}); }
        else if (path === '/api/instances') json({ instances: [instance] });
        else if (path === '/api/bots') json({ bots: [], groups: [] });
        else if (path === '/api/flux-connection') json(failStatus ? { error: 'Fixture unavailable' } : { configured: false, revision: 'fixture', conflict: false, choices: [] }, failStatus ? 503 : 200);
        else if (path === '/api/provider-connections' && req.method === 'GET') json({ connections: [], storage: 'local-config' });
        else if (path === '/api/provider-connections/mutate') { let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{writes.push({path,body:JSON.parse(body)});json({connections:[],storage:'local-config'});}); }
        else if (path.startsWith('/api/') && !['GET','HEAD'].includes(req.method ?? 'GET')) { let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{writes.push({path,body:body?JSON.parse(body):{}});json({error:'Unexpected fixture write'},409);}); }
        else if (path.startsWith('/api/')) json({ error: 'Unused fixture read' },404);
        else next();
      }); },
    }],
  });
  await server.listen(0);const address=server.httpServer!.address();if(!address||typeof address==='string')throw Error('No fixture port');origin=`http://127.0.0.1:${address.port}`;
});
test.beforeEach(async ({page}) => { writes=[];failStatus=false;boxConfigured=false;pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));await page.route('https://**/*',route=>route.abort()); });
test.afterEach(()=>{expect(pageErrors).toEqual([]);});
test.afterAll(async()=>{await server?.close();if(cache)safeWipeSync(cache);});

async function openModels(page: import('@playwright/test').Page) {
  await page.goto(`${origin}/__flux-entry`, { waitUntil:'domcontentloaded' });
  await page.getByRole('button',{name:'Open Models settings',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Settings',exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Flux Router',exact:true})).toBeVisible();
  await expect(page.getByLabel('Flux Router key',{exact:true})).toBeEnabled();
}
// Connected apps run through Flux Router only (debd39ba2), so the scanner
// no longer files a connected-apps project key; the service-key row in these
// tests is a Box token, which still saves through PUT /api/config.
// 0.1.62: "Paste any keys" sits folded at the foot of Models (it was
// Tools & Connections > Advanced), so a pasted Flux key sends the cursor up
// to the Flux Router card on the same page.
test('Models Flux paste navigates without saving or carrying the pasted key',async({page},testInfo)=>{
  await openModels(page);
  await page.getByText('Paste any keys',{exact:true}).click();
  expect(pageErrors).toEqual([]);
  const key='sk-flux-'+ 'F'.repeat(40);
  await page.getByLabel('Paste keys to look through').fill(`FLUX_API_KEY=${key}\nBOX_TOKEN=box_${'c'.repeat(32)}`);
  await page.getByRole('button',{name:'Look for keys',exact:true}).click();
  await expect(page.getByText('Manage Flux Router in Models.',{exact:false})).toBeVisible();
  expect(writes).toEqual([]);
  await page.getByRole('button',{name:'Open Flux Router in Models',exact:true}).click();
  await expect(page.getByRole('alert').filter({hasText:'Save or dismiss the other pasted keys'})).toBeVisible();
  await expect(page.getByTestId('paste-key-row')).toHaveCount(2);
  // nothing moved: the cursor stays with the pasted keys
  await expect(page.getByLabel('Flux Router key',{exact:true})).not.toBeFocused();
  await page.setViewportSize({width:390,height:900});
  await page.screenshot({path:testInfo.outputPath('tools-pending-keys-390.png')});
  await page.getByTestId('paste-key-row').filter({hasText:'BOX_TOKEN'}).getByRole('button',{name:'Ignore',exact:true}).click();
  await expect(page.getByTestId('paste-key-row')).toHaveCount(1);
  await page.getByRole('button',{name:'Open Flux Router in Models',exact:true}).click();
  await expect(page.getByLabel('Flux Router key',{exact:true})).toHaveValue('');
  await expect(page.getByLabel('Flux Router key',{exact:true})).toBeFocused();
  expect(writes).toEqual([]);expect(await page.content()).not.toContain(key);
});
test('advanced key review preserves canonical Add and Replace mutations',async({page},testInfo)=>{
  await openModels(page);
  const disclosure=page.locator('summary').filter({hasText:'Paste any keys'});
  const input=page.getByLabel('Paste keys to look through');
  await expect(input).toBeHidden();
  await disclosure.focus();await page.keyboard.press('Enter');await expect(input).toBeVisible();
  const first='box_'+ 'c'.repeat(32), second='box_'+ 'd'.repeat(32), model='xai-'+ '7'.repeat(32);
  await input.fill(`BOX_TOKEN=${first}\nXAI_API_KEY=${model}`);
  await page.getByRole('button',{name:'Look for keys',exact:true}).click();
  await expect(input).toHaveValue('');await expect(page.getByTestId('paste-key-row')).toHaveCount(2);expect(writes).toEqual([]);
  await input.fill(`BOX_TOKEN=${first}`);await page.getByRole('button',{name:'Look for keys',exact:true}).click();
  await expect(page.getByTestId('paste-key-row')).toHaveCount(2);
  const service=page.getByTestId('paste-key-row').filter({hasText:'BOX_TOKEN'});
  await expect(service.getByRole('button',{name:'Add key',exact:true})).toBeEnabled();
  await expect(page.getByTestId('paste-key-row').filter({hasText:'XAI_API_KEY'}).getByRole('button',{name:'Add connection',exact:true})).toBeEnabled();
  for(const width of [390,820,1440]){
    await page.setViewportSize({width,height:900});await disclosure.scrollIntoViewIfNeeded();
    await page.screenshot({path:testInfo.outputPath(`advanced-review-${width}.png`)});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
  expect(await page.content()).not.toContain(first);expect(await page.content()).not.toContain(model);
  await service.getByRole('button',{name:'Add key',exact:true}).click();await expect(service.getByText('Saved',{exact:true})).toBeVisible();
  expect(writes).toHaveLength(1);expect(writes[0]).toEqual({path:'/api/config',body:{box:{token:first}}});
  await input.fill(`BOX_TOKEN=${second}`);await page.getByRole('button',{name:'Look for keys',exact:true}).click();
  await page.getByRole('button',{name:'Replace key',exact:true}).click();await expect(service.getByText('Saved',{exact:true})).toHaveCount(2);
  expect(writes).toHaveLength(2);expect(writes[1]).toEqual({path:'/api/config',body:{box:{token:second}}});
  await page.getByTestId('paste-key-row').filter({hasText:'XAI_API_KEY'}).getByRole('button',{name:'Add connection',exact:true}).click();
  await expect.poll(()=>writes.length).toBe(3);expect(writes[2]).toEqual({path:'/api/provider-connections/mutate',body:{action:'create',preset:'xai',key:model}});
  await disclosure.focus();await page.keyboard.press('Enter');await expect(input).toBeHidden();
  await page.keyboard.press('Enter');await expect(input).toHaveValue('');
});
test('ambiguous nonFlux keys retain provider choice; failure has no legacy Flux input',async({page})=>{
  await openModels(page);
  await page.getByLabel('Model API key',{exact:true}).fill('sk-'+ 'a'.repeat(32));
  const choices=page.getByRole('group',{name:'Which provider issued this key?',exact:true});
  await expect(choices.getByRole('button',{name:'OpenAI',exact:true})).toBeVisible();
  await expect(choices.getByRole('button',{name:'Flux Router',exact:true})).toHaveCount(0);
  await choices.getByRole('button',{name:'OpenAI',exact:true}).click();
  await page.getByRole('button',{name:'Add connection',exact:true}).click();
  await expect.poll(()=>writes.length).toBe(1);
  expect(writes[0].body).toMatchObject({action:'create',preset:'openai'});
  failStatus=true;await page.getByRole('button',{name:'Refresh connections',exact:true}).click();
  await expect(page.getByText('Flux Router setup is unavailable.',{exact:false})).toBeVisible();
  await expect(page.getByLabel('Flux Router key',{exact:true})).toBeDisabled();
  await expect(page.getByLabel('Flux Router default key',{exact:true})).toHaveCount(0);
  await page.getByLabel('Model API key',{exact:true}).fill('FLUX_API_KEY=sk-flux-'+ 'F'.repeat(40));
  await expect(page.getByText('Use the Flux Router card above to connect or replace your key.',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Add connection',exact:true})).toBeDisabled();
  expect(writes).toHaveLength(1);
});
