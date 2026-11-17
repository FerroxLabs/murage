// HTTP authentication and the real owner route/controller, with no native browser.
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchVerificationServer, type VerificationServer } from '../scripts/control-murage.ts';
import { CloudSessions, type CloudScope } from './cloud-sessions.ts';

const origin = 'https://home.example.test';
let fixture: VerificationServer, db: DatabaseSync, botId: string;
const credentials = new Map<string, Record<string, string>>();
async function call(who: string, method: string, path: string, body?: unknown) {
  return new Promise<{status:number; body:any}>((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const req = request(fixture.info.url + path, {method, headers:{host:'home.example.test', origin,
      'content-type':'application/json', ...credentials.get(who), ...(encoded ? {'content-length':String(Buffer.byteLength(encoded))} : {})}}, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => { try { resolve({status:res.statusCode!, body:JSON.parse(Buffer.concat(chunks).toString())}); } catch(error) { reject(error); } });
    });
    req.on('error', reject); req.end(encoded);
  });
}
beforeAll(async () => {
  // The mutation run changes only the isolated child's route principal. It
  // proves this test reaches index.ts, beyond the pure helper tests.
  const mutant = process.env.S1_AUTH_MUTANT === '1';
  fixture = await launchVerificationServer({}, undefined, {
    cloud:{publicOrigin:origin, bootstrapSecret:'fixture-popout-bootstrap-32-characters'},
    instrumentationSource:`
      const fs=await import('node:fs'),path=await import('node:path');
      const configFile=path.join(process.env.MURAGE_DATA_DIR,'config.json');
      const config=JSON.parse(fs.readFileSync(configFile,'utf8')); config.features={browser:true}; fs.writeFileSync(configFile,JSON.stringify(config));
      const {registerHooks}=await import('node:module');
      registerHooks({load(url,context,next){
        if(url.endsWith('/browser-native-relay.ts'))return {format:'module',shortCircuit:true,source:'export function createNativeBrowser(){return {connect:async()=>"fixture-stream",protected:async()=>false,request:async()=>({}),command:async()=>({}),input:()=>{},resetStream:()=>{},close:async()=>{}}}'};
        const result=next(url,context);
        if(!url.endsWith('/server/index.ts'))return result;
        let source=String(result.source);
        const binding='async function unifiedBrowserBinding(botId: string, profile: string | undefined) {';
        if(source.split(binding).length!==2)throw Error('Browser binding fixture anchor changed');
        source=source.replace(binding,binding+' { const key=unifiedBrowserKey(store.bot(botId)); const spec={command:"fixture",args:[],env:{}}; await unifiedBrowser.register(key,spec); return {key,spec}; }');
        if(${JSON.stringify(mutant)}) {
          const proof='scope: cloudIdentity(req.headers)?.scope';
          if(source.split(proof).length!==2)throw Error('Owner principal fixture anchor changed');
          source=source.replace(proof,'scope: cloudIdentity(req.headers)?.scope === "browser" ? "owner-desktop" : cloudIdentity(req.headers)?.scope');
        }
        return {...result,source};
      }});
    `,
  });
  db = new DatabaseSync(join(fixture.info.dataDir, 'messages.db'));
  db.exec('PRAGMA busy_timeout=5000');
  const sessions = new CloudSessions(db, undefined, origin);
  const key = generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'}).toString();
  db.prepare("INSERT OR IGNORE INTO cloud_meta VALUES ('account','fixture-owner')").run();
  // Persist realistic sessions in the isolated fixture. Every request still
  // passes the production bearer/cookie resolver and route authentication.
  for (const scope of ['owner-desktop','owner-phone','browser','service'] as CloudScope[]) {
    const id=randomUUID();
    db.prepare('INSERT INTO cloud_devices (id,account,scope,publicKey,assertionKey,revoked,addedAt,lastSeenAt) VALUES (?,?,?,?,?,0,?,?)').run(id,'fixture-owner',scope,key,key,Date.now(),Date.now());
    const {accessToken}=sessions.issue(id);
    credentials.set(scope,scope==='browser'?{cookie:`__Host-murage=${accessToken}`}:{authorization:`Bearer ${accessToken}`});
  }
  const created = await call('owner-desktop','POST','/api/bots',{name:'Owner route fixture'});
  expect(created.status).toBe(201); botId=created.body.bot.id;
},60_000);
afterAll(async () => { db?.close(); await fixture?.close(); });

it('authenticates both owner devices through the real route and refuses browser cookies without changing the hold', async () => {
  const route=`/api/bots/${botId}/browser`;
  const initial=await call('owner-desktop','GET',route);
  expect(initial.status).toBe(200); expect(initial.body.held).toBe(false);
  const expected = { expectedRevision: initial.body.selectionRevision, expectedKey: initial.body.sessionKey };
  for (const action of ['take','reclaim','release']) {
    const refused=await call('browser','POST',route,{...expected,action,owner:initial.body.owner,scope:'owner-desktop',desktop:true,generation:initial.body.generation,control:initial.body.control});
    expect(refused.status).toBe(401); expect(refused.body.code).toBe('desktop_only');
    const unchanged=await call('owner-desktop','GET',route);
    expect(unchanged.body).toMatchObject({held:false,control:initial.body.control,owner:initial.body.owner});
  }
  const taken=await call('owner-desktop','POST',route,{...expected,action:'take',owner:'forged-body-owner'});
  expect(taken.status).toBe(200); expect(taken.body).toMatchObject({held:true,owned:true,canReclaim:true});
  expect(taken.body.owner).not.toBe('forged-body-owner');
  const phone=await call('owner-phone','GET',route);
  expect(phone.body).toMatchObject({owner:taken.body.owner,held:true,owned:true,canReclaim:false});
  for (const action of ['take','release','reclaim','input']) {
    const refused=await call('browser','POST',route,{...expected,action,owner:taken.body.owner,generation:taken.body.generation,control:taken.body.control,event:{type:'input_keyboard',eventType:'char',text:'fixture'}});
    expect(refused.status).toBe(401);
    expect((await call('owner-desktop','GET',route)).body).toMatchObject({held:true,owner:taken.body.owner,control:taken.body.control});
  }
  for (const who of ['service','anonymous']) expect((await call(who,'POST',route,{...expected,action:'take'})).status).toBe(403);
  const released=await call('owner-phone','POST',route,{...expected,action:'release',generation:phone.body.generation,control:phone.body.control});
  expect(released.status).toBe(200); expect(released.body.held).toBe(false);
},30_000);
