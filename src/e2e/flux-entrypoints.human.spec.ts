import { expect, test } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigStatus } from '../state/store';
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";

// Real onboarding/settings/Models/PasteKeys, controlled empty-workspace backend.
// This fixture verifies navigation and write boundaries, not provider readiness.
let server: ViteDevServer, origin: string, cache: string;
let failStatus = false;
let composioConfigured = false;
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
        return `import React from 'react';import {createRoot} from 'react-dom/client';import {StoreProvider,useStore} from '/src/state/store.tsx';import {Onboarding} from '/src/components/Onboarding.tsx';import {SettingsModal} from '/src/components/SettingsModal.tsx';import '/src/styles.css';
          window.onboardingDone=0;
          function Fixture(){const store=useStore();window.fixtureStore=store;return React.createElement(React.Fragment,null,store.state.appSettingsOpen&&React.createElement(SettingsModal),React.createElement(Onboarding,{onDone:()=>window.onboardingDone++}));}
          createRoot(document.getElementById('root')).render(React.createElement(StoreProvider,null,React.createElement(Fixture)));`;
      },
      configureServer(vite) { vite.middlewares.use((req,res,next) => {
        const path = new URL(req.url ?? '/', 'http://fixture').pathname;
        const json = (value: unknown, status = 200) => { res.statusCode=status;res.setHeader('content-type','application/json');res.end(JSON.stringify(value)); };
        if (path === '/__flux-entry') { res.setHeader('content-type','text/html');res.end('<html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Flux entrypoint fixture</title></head><body><div id="root"></div><script type="module" src="/__flux-entry.js"></script></body></html>'); }
        else if (path === '/api/desktop-secret') json({ secret: proof });
        else if (path === '/api/config' && req.method === 'GET') json({ ...config, composio: { ...config.composio, configured: composioConfigured }, surface: req.headers['x-murage-surface-secret'] === proof ? 'desktop' : 'remote' });
        else if (path === '/api/config' && req.method === 'PUT') { let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{const change=JSON.parse(body);writes.push({path,body:change});if(Object.keys(change).length!==1||typeof change.composio?.apiKey!=='string'){json({error:'Unexpected fixture config change'},409);return;}composioConfigured=Boolean(change.composio.apiKey);json({...config,composio:{...config.composio,configured:composioConfigured}});}); }
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
test.beforeEach(async ({page}) => { writes=[];failStatus=false;composioConfigured=false;pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));await page.route('https://**/*',route=>route.abort()); });
test.afterEach(()=>{expect(pageErrors).toEqual([]);});
test.afterAll(async()=>{await server?.close();if(cache)safeWipeSync(cache);});

async function openFromOnboarding(page: import('@playwright/test').Page) {
  await page.goto(`${origin}/__flux-entry`, { waitUntil:'domcontentloaded' });
  await page.getByLabel('Choose your first outcome').getByRole('button').first().click();
  await page.getByLabel('Choose an engine').getByRole('button', {name:/Fuigo/}).click();
  await expect(page.locator('input[type=password]')).toHaveCount(0);
  await page.getByRole('button',{name:'Open Flux Router in Models',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Settings',exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Flux Router',exact:true})).toBeVisible();
  await expect(page.getByLabel('Flux Router key',{exact:true})).toBeEnabled();
}
test('onboarding opens the one Models card and resumes its selected engine',async({page},testInfo)=>{
  await openFromOnboarding(page);
  expect(await page.evaluate(()=>(window as any).onboardingDone)).toBe(0);
  for(const skin of ['light','dark'])for(const width of [390,1440]){
    await page.setViewportSize({width,height:900});await page.evaluate(value=>{document.documentElement.dataset.skin=value;},skin);
    await page.screenshot({path:testInfo.outputPath(`${skin}-${width}.png`)});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
  await page.getByRole('dialog',{name:'Settings',exact:true}).getByRole('button',{name:'Close settings',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Choose an engine',exact:true})).toBeVisible();
  await expect(page.getByLabel('Choose an engine').getByRole('button',{name:/Fuigo/})).toHaveAttribute('aria-pressed','true');
  await expect(page.getByRole('button',{name:'Open Flux Router in Models',exact:true})).toBeVisible();
  for(const skin of ['light','dark'])for(const width of [390,1440]){
    await page.setViewportSize({width,height:900});await page.evaluate(value=>{document.documentElement.dataset.skin=value;},skin);
    await page.getByRole('button',{name:'Open Flux Router in Models',exact:true}).scrollIntoViewIfNeeded();
    await page.screenshot({path:testInfo.outputPath(`setup-${skin}-${width}.png`)});
  }
  expect(writes).toEqual([]);
});
test('Tools Flux paste navigates without saving or carrying the pasted key',async({page},testInfo)=>{
  await openFromOnboarding(page);
  const dialog=page.getByRole('dialog',{name:'Settings',exact:true});
  await dialog.getByRole('button',{name:'Tools & Connections',exact:true}).click();
  await expect(page.getByLabel('Box API key',{exact:true})).toBeVisible();
  await page.getByText('Advanced: Add or replace keys',{exact:true}).click();
  expect(pageErrors).toEqual([]);
  const key='sk-flux-'+ 'F'.repeat(40);
  await page.getByLabel('Paste keys to look through').fill(`FLUX_API_KEY=${key}\nCOMPOSIO_API_KEY=ak_${'c'.repeat(32)}`);
  await page.getByRole('button',{name:'Look for keys',exact:true}).click();
  await expect(page.getByText('Manage Flux Router in Models.',{exact:false})).toBeVisible();
  expect(writes).toEqual([]);
  await page.getByRole('button',{name:'Open Flux Router in Models',exact:true}).click();
  await expect(page.getByRole('alert').filter({hasText:'Save or dismiss the other pasted keys'})).toBeVisible();
  await expect(page.getByTestId('paste-key-row')).toHaveCount(2);
  await expect(page.getByLabel('Flux Router key',{exact:true})).toHaveCount(0);
  await page.setViewportSize({width:390,height:900});
  await page.screenshot({path:testInfo.outputPath('tools-pending-keys-390.png')});
  await page.getByTestId('paste-key-row').filter({hasText:'COMPOSIO_API_KEY'}).getByRole('button',{name:'Ignore',exact:true}).click();
  await expect(page.getByTestId('paste-key-row')).toHaveCount(1);
  await page.getByRole('button',{name:'Open Flux Router in Models',exact:true}).click();
  await expect(page.getByLabel('Flux Router key',{exact:true})).toHaveValue('');
  expect(writes).toEqual([]);expect(await page.content()).not.toContain(key);
});
test('advanced key review preserves canonical Add and Replace mutations',async({page},testInfo)=>{
  await openFromOnboarding(page);
  await page.getByRole('dialog',{name:'Settings',exact:true}).getByRole('button',{name:'Tools & Connections',exact:true}).click();
  const disclosure=page.getByText('Advanced: Add or replace keys',{exact:true});
  const input=page.getByLabel('Paste keys to look through');
  await expect(input).toBeHidden();
  await disclosure.focus();await page.keyboard.press('Enter');await expect(input).toBeVisible();
  const first='ak_'+ 'c'.repeat(32), second='ak_'+ 'd'.repeat(32), model='xai-'+ '7'.repeat(32);
  await input.fill(`COMPOSIO_API_KEY=${first}\nXAI_API_KEY=${model}`);
  await page.getByRole('button',{name:'Look for keys',exact:true}).click();
  await expect(input).toHaveValue('');await expect(page.getByTestId('paste-key-row')).toHaveCount(2);expect(writes).toEqual([]);
  await input.fill(`COMPOSIO_API_KEY=${first}`);await page.getByRole('button',{name:'Look for keys',exact:true}).click();
  await expect(page.getByTestId('paste-key-row')).toHaveCount(2);
  const service=page.getByTestId('paste-key-row').filter({hasText:'COMPOSIO_API_KEY'});
  await expect(service.getByRole('button',{name:'Add key',exact:true})).toBeEnabled();
  await expect(page.getByTestId('paste-key-row').filter({hasText:'XAI_API_KEY'}).getByRole('button',{name:'Add connection',exact:true})).toBeEnabled();
  for(const width of [390,820,1440]){
    await page.setViewportSize({width,height:900});await disclosure.scrollIntoViewIfNeeded();
    await page.screenshot({path:testInfo.outputPath(`advanced-review-${width}.png`)});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
  expect(await page.content()).not.toContain(first);expect(await page.content()).not.toContain(model);
  await service.getByRole('button',{name:'Add key',exact:true}).click();await expect(service.getByText('Saved',{exact:true})).toBeVisible();
  expect(writes).toHaveLength(1);expect(writes[0]).toEqual({path:'/api/config',body:{composio:{apiKey:first}}});
  await input.fill(`COMPOSIO_API_KEY=${second}`);await page.getByRole('button',{name:'Look for keys',exact:true}).click();
  await page.getByRole('button',{name:'Replace key',exact:true}).click();await expect(service.getByText('Saved',{exact:true})).toHaveCount(2);
  expect(writes).toHaveLength(2);expect(writes[1]).toEqual({path:'/api/config',body:{composio:{apiKey:second}}});
  await page.getByTestId('paste-key-row').filter({hasText:'XAI_API_KEY'}).getByRole('button',{name:'Add connection',exact:true}).click();
  await expect.poll(()=>writes.length).toBe(3);expect(writes[2]).toEqual({path:'/api/provider-connections/mutate',body:{action:'create',preset:'xai',key:model}});
  await disclosure.focus();await page.keyboard.press('Enter');await expect(input).toBeHidden();
  await page.keyboard.press('Enter');await expect(input).toHaveValue('');
});
test('ambiguous nonFlux keys retain provider choice; failure has no legacy Flux input',async({page})=>{
  await openFromOnboarding(page);
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
