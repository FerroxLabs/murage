// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { test, expect, type Page, type Locator } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-murage.ts";
import { openSidebar } from "./fixtures.ts";
import type { ProjectRead } from "../lib/project-client";

let fixture: VerificationServer, vite: ViteDevServer, origin: string, headers: Record<string,string>;
let member: {id:string;name:string};
const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"),"utf8");
const widths = [390,820,1440];
const gate = () => join(fixture.info.dataDir,"tmp","close-reply");
test.beforeAll(async () => {
  fixture = await launchVerificationServer(process.env,undefined,{instrumentationSource: `
    const {Store}=await import(${JSON.stringify(new URL('../../server/store.ts',import.meta.url).href)});
    const {database}=await import(${JSON.stringify(new URL('../../server/database.ts',import.meta.url).href)});
    const {createProjectRows}=await import(${JSON.stringify(new URL('../../server/project-new.ts',import.meta.url).href)});
    const {materializeProjectCreation}=await import(${JSON.stringify(new URL('../../server/project-migration.ts',import.meta.url).href)});
    const {readFileSync,writeFileSync}=await import('node:fs');const {join}=await import('node:path');
    const configPath=join(process.env.MURAGE_DATA_DIR,'config.json');const config=JSON.parse(readFileSync(configPath,'utf8'));
    config.features={...config.features,projectsLead:true,projectsGoals:true,projectsBoard:true,roomsQueue:true,projectsAutonomy:true};writeFileSync(configPath,JSON.stringify(config));
    process.env.FAKE_CLAUDE_MODE='slow';process.env.FAKE_CLAUDE_REPLY_GATE=join(process.env.MURAGE_DATA_DIR,'tmp','close-reply');
    const store=new Store(()=>({instanceId:'verification',model:'sonnet'}));
    const chief=store.createBot({name:'Fixture Chief'},{seedMessages:false});store.patchBot(chief.id,{chiefOfStaff:true,chiefScope:'workspace',computer:'off',browser:false,composio:false});
    for(const width of [390,820,1440])for(const variant of ['plain','stop','end','keyboard']){
      const bot=store.createBot({name:'Lead '+width+' '+variant},{seedMessages:false});store.patchBot(bot.id,{computer:'off',browser:false,composio:false});
      const id='lifecycle-'+width+'-'+variant;
      createProjectRows(database(),{clientId:id,name:id,purpose:'Synthetic lifecycle fixture',members:[bot.id],leadBotId:bot.id,mode:variant==='stop'?'goal':'chat',...(variant==='stop'?{goal:{title:'Paused goal'}}:{})},[{id:bot.id,name:bot.name}],Date.now());
      materializeProjectCreation(store,id);
      if(variant==='stop')database().prepare("UPDATE project_goals SET state='paused' WHERE group_id=?").run(id);
    }
  `});
  const proof=await (await fetch(fixture.info.url+'/api/desktop-secret')).json() as {secret:string};
  headers={"x-murage-surface":"desktop","x-murage-surface-secret":proof.secret};
  const options=await (await fetch(fixture.info.url+'/api/projects/new-options',{headers})).json() as {members:Array<{id:string;name:string}>};
  member=options.members.find(bot=>bot.name==='Fixture Chief')!;
  const root=fileURLToPath(new URL('../../',import.meta.url));
  vite=await createServer({configFile:false,root,envFile:false,cacheDir:join(fixture.info.dataDir,'vite-cache'),resolve:{alias:{'@':join(root,'src')}},plugins:[react(),tailwindcss()],server:{host:'127.0.0.1',port:0,watch:null,hmr:false,proxy:{'/api':{target:fixture.info.url}}}});
  await vite.listen(0);const address=vite.httpServer!.address();if(!address||typeof address==='string')throw new Error('No fixture UI port');origin=`http://127.0.0.1:${address.port}`;
});
test.afterAll(async()=>{try{await vite?.close();}finally{await fixture?.close();}});
async function enter(page:Page,width:number,group?:string){
  await page.setViewportSize({width,height:900});
  await page.addInitScript(()=>localStorage.setItem('murage-email-gate','skipped'));
  await page.route('https://**/*',route=>route.abort());
  await page.goto(origin);
  if(group){const sidebar=await openSidebar(page);await sidebar.getByText(group,{exact:true}).click();}
}
async function openNew(page:Page){
  const sidebar=await openSidebar(page);await sidebar.getByRole('button',{name:'New or share',exact:true}).click();
  await sidebar.getByRole('button',{name:/^New Project/}).click();
  return page.getByRole('dialog',{name:'New project',exact:true});
}
async function inspect(page:Page,dialog:Locator,name:string){
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth+1)).toBe(true);
  await page.addScriptTag({content:axeSource});
  const serious=await page.evaluate(async()=>{
    const axe=(window as unknown as {axe:{run(context:Element,options:unknown):Promise<{violations:Array<{id:string;impact:string}>}>}}).axe;
    return (await axe.run(document.querySelector('dialog[open]')!,{})).violations.filter(v=>v.impact==='critical'||v.impact==='serious').map(v=>v.id);
  });
  expect(serious).toEqual([]);
  await page.screenshot({path:test.info().outputPath(name+'.png'),fullPage:true});
}
async function readProject(id:string):Promise<ProjectRead>{return (await fetch(`${fixture.info.url}/api/groups/${id}/project`,{headers})).json();}
async function create(page:Page,dialog:Locator){
  const response=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/projects');
  await dialog.getByRole('button',{name:'Create project',exact:true}).click();
  const result=await response;expect(result.ok()).toBe(true);const {group}=await result.json() as {group:{id:string}};
  await expect(page.getByRole('dialog',{name:'Project created',exact:true})).toBeVisible();return group.id;
}
async function lifecycleDialog(page:Page,group:string,action:'Close project'|'End project'){
  await page.getByRole('main').getByRole('button',{name:`More actions for ${group}`,exact:true}).click();await page.getByRole('menuitem',{name:action,exact:true}).click();
  return page.getByRole('dialog',{name:action,exact:true});
}
async function tabTo(page:Page,target:Locator){
  for(let i=0;i<300;i++){if(await target.evaluate(node=>node===document.activeElement))return;await page.keyboard.press('Tab');}
  throw new Error('Keyboard could not reach the control');
}
for(const width of widths){
  for(const mode of ['goal','chat','ongoing','bots'] as const)test(`plain ${mode} creation at ${width}`,async({page})=>{
    await enter(page,width);const dialog=await openNew(page);await dialog.getByLabel('Purpose',{exact:true}).fill(`Project ${mode} ${width}`);
    await dialog.getByRole('button',{name:'Fill in the form myself'}).click();await dialog.getByLabel('How will you use this project?').selectOption(mode);
    await dialog.getByRole('checkbox',{name:member.name,exact:true}).check();if(mode!=='bots')await dialog.getByRole('combobox',{name:'Lead',exact:true}).selectOption(member.id);
    if(mode==='goal'){await dialog.getByLabel('Goal title',{exact:true}).fill('Deliver a report');await dialog.getByRole('button',{name:'Add done criterion'}).click();await dialog.getByLabel('Done criterion 1').fill('Report exists');await expect(dialog.getByRole('checkbox',{name:'Start now',exact:true})).toBeChecked();}
    await inspect(page,dialog,`new-${mode}-${width}`);const id=await create(page,dialog);const project=await readProject(id);
    expect(project.settings).toMatchObject({mode:mode==='ongoing'?'ongoing':'conversation',leadBotId:mode==='bots'?null:member.id,parts:{board:mode!=='chat'}});
    // Start now is on by default: this fixture turns project work on, so the goal starts with the project
    if(mode==='goal'){expect(project.goal).toMatchObject({title:'Deliver a report',state:'planning'});await expect(page.getByRole('dialog',{name:'Project created',exact:true}).getByText('The goal has started. The lead is planning it now.')).toBeVisible();}
    else expect(project.goal).toBeNull();
  });
  test(`editable Chief proposal at ${width}`,async({page})=>{
    await enter(page,width);let calls=0;await page.route('**/api/projects/proposal',route=>{calls++;return route.fulfill({json:{proposal:{members:[member.id],leadBotId:member.id,mode:'ongoing',brief:{summary:'Proposed summary',doneMeans:'Report delivered',rules:'Be brief'},budget:{minutes:120,tokens:3000000},planOutline:['Write a report']}}});});
    const dialog=await openNew(page);await dialog.getByLabel('Purpose',{exact:true}).fill('Owner purpose');await dialog.getByRole('button',{name:'Ask Fixture Chief to propose'}).click();await dialog.getByRole('textbox',{name:'Summary',exact:true}).fill('Owner edited summary');
    await dialog.getByRole('textbox',{name:'First plan',exact:true}).fill('Owner edited step\nVerify the report');
    await dialog.getByLabel('Work minutes',{exact:true}).fill('45');await dialog.getByLabel('Tokens',{exact:true}).fill('12345');
    const id=await create(page,dialog);expect(calls).toBe(1);const project=await readProject(id);expect(project.brief).toMatchObject({summary:'Owner edited summary',rules:'Be brief\n\nFirst plan:\nOwner edited step\nVerify the report'});
    expect(project.budgets).toEqual(expect.arrayContaining([expect.objectContaining({maxWorkMinutes:45,maxTokens:12345})]));
  });
  test(`unread Chief draft prefills the plain form at ${width}`,async({page})=>{
    await enter(page,width);await page.route('**/api/projects/proposal',route=>route.fulfill({json:{reason:"The Chief's draft could not be read. What it wrote is in the brief below. Check it and fill in the project.",draft:'Ada leads the report.'}}));
    const dialog=await openNew(page);await dialog.getByLabel('Purpose',{exact:true}).fill('Owner purpose');await dialog.getByRole('button',{name:'Ask Fixture Chief to propose'}).click();
    await expect(dialog.getByRole('status')).toHaveText("The Chief's draft could not be read. What it wrote is in the brief below. Check it and fill in the project.");
    const brief=dialog.getByRole('textbox',{name:'Brief from the Chief',exact:true});await expect(brief).toHaveValue('Ada leads the report.');await inspect(page,dialog,`chief-draft-${width}`);await brief.fill('Ada leads the report. Owner edit.');
    await dialog.getByLabel('How will you use this project?').selectOption('bots');await dialog.getByRole('checkbox',{name:'Fixture Chief',exact:true}).check();
    const id=await create(page,dialog);expect((await readProject(id)).brief).toMatchObject({summary:'Owner purpose',rules:'Ada leads the report. Owner edit.'});
  });
  for(const variant of ['plain','stop'] as const)test(`Close ${variant}, Closing, Closed and Reopen at ${width}`,async({page})=>{
    const group=`lifecycle-${width}-${variant}`;rmSync(gate(),{force:true});await enter(page,width,group);
    const dialog=await lifecycleDialog(page,group,'Close project');await inspect(page,dialog,`close-${variant}-${width}`);
    await dialog.getByRole('button',{name:variant==='stop'?'Stop the goal and close':'Close project',exact:true}).click();
    await expect(page.getByRole('status').filter({hasText:/^Closing: waiting for/})).toBeVisible();expect((await readProject(group)).closing).toBe(true);
    await page.getByRole('main').getByRole('button',{name:`More actions for ${group}`,exact:true}).click();await expect(page.getByRole('menuitem',{name:'Close project',exact:true})).toHaveCount(0);await expect(page.getByRole('menuitem',{name:'End project',exact:true})).toHaveCount(0);await page.keyboard.press('Escape');
    writeFileSync(gate(),'release');await expect(page.getByRole('status').filter({hasText:'This project is closed.'})).toBeVisible({timeout:30000});
    if(variant==='stop')expect((await readProject(group)).goal?.state).toBe('stopped');
    await page.getByRole('button',{name:'Reopen',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'Project reopened.'})).toBeVisible();expect((await readProject(group)).settings).toMatchObject({closedAt:null,runState:'paused'});
  });
  test(`End project confirmation at ${width}`,async({page})=>{
    const group=`lifecycle-${width}-end`;await enter(page,width,group);const dialog=await lifecycleDialog(page,group,'End project');await inspect(page,dialog,`end-${width}`);
    await expect(dialog).toContainText('History stays readable.');await dialog.getByRole('button',{name:'End project',exact:true}).click();await expect(dialog).toHaveCount(0);expect((await readProject(group)).lifecycle).toBe('ended');
  });
  test(`keyboard Tab Enter Escape and focus return for each dialog at ${width}`,async({page})=>{
    const group=`lifecycle-${width}-keyboard`;await enter(page,width,group);const sidebar=await openSidebar(page);const trigger=sidebar.getByRole('button',{name:'New or share',exact:true});
    // On a phone the drawer may close behind the dialog; then its menu button takes focus back
    // (src/lib/return-focus.ts). Either way focus lands on a visible, usable opener, never the page.
    const returned={toBeFocused:async()=>expect.poll(()=>page.evaluate(()=>{const a=document.activeElement as HTMLElement|null;
      if(!a||a===document.body||a.closest('[inert]')||!a.checkVisibility())return 'lost';return a.getAttribute('aria-label')??a.textContent?.trim();})).toMatch(width===390?/^(New or share|Open bot list)$/:/^New or share$/)};
    await tabTo(page,trigger);await page.keyboard.press('Enter');await tabTo(page,sidebar.getByRole('button',{name:/^New Project/}));await page.keyboard.press('Enter');
    let dialog=page.getByRole('dialog',{name:'New project',exact:true});await expect(dialog).toBeVisible();await tabTo(page,dialog.getByLabel('Purpose',{exact:true}));await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await returned.toBeFocused();
    if(width===390)await openSidebar(page);await trigger.click();await sidebar.getByRole('button',{name:/^New Project/}).click();
    dialog=page.getByRole('dialog',{name:'New project',exact:true});await dialog.getByRole('button',{name:'Close New project',exact:true}).click();await expect(dialog).toHaveCount(0);await returned.toBeFocused();
    // Selecting the fixture closes the phone drawer before traversing the header.
    await sidebar.getByText(group,{exact:true}).click();
    const more=page.getByRole('main').getByRole('button',{name:`More actions for ${group}`,exact:true});
    for(const action of ['Close project','End project'] as const){
      await tabTo(page,more);await page.keyboard.press('Enter');await tabTo(page,page.getByRole('menuitem',{name:action,exact:true}));await page.keyboard.press('Enter');
      dialog=page.getByRole('dialog',{name:action,exact:true});await expect(dialog).toBeVisible();await tabTo(page,dialog.getByRole('button',{name:action,exact:true}));await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(more).toBeFocused();
      dialog=await lifecycleDialog(page,group,action);await dialog.getByRole('button',{name:`Close ${action}`,exact:true}).click();await expect(dialog).toHaveCount(0);await expect(more).toBeFocused();
    }
  });
}
