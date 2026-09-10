import { chromium } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
const root=fileURLToPath(new URL("../",import.meta.url)), output=path.join(root,".planning/0150-recovery-joined-ui");
await mkdir(output,{recursive:true});
const assets=Object.fromEntries(await Promise.all(["index.html","renderer.js","recovery.css"].map(async name=>[name,await readFile(path.join(root,"electron/recovery",name))])));
const browser=await chromium.launch({headless:true}), results=[];
try { for(const skin of ["light","dark"]) for(const width of [390,820,1440]) {
  const page=await browser.newPage({viewport:{width,height:900}}), errors=[]; page.on("pageerror",error=>errors.push(error.message));
  await page.route("**/*",route=>{const name=new URL(route.request().url()).pathname.slice(1); assert.ok(assets[name]); return route.fulfill({body:assets[name],contentType:name.endsWith(".js")?"text/javascript":name.endsWith(".css")?"text/css":"text/html"});});
  await page.addInitScript(({skin})=>{
    window.fixtureCalls=[];
    const state={available:false,separateAvailable:true,captureAvailable:true,busy:false,selection:null,context:{skin,reason:"Foreign-host ownership requires recovery.",dataDirectory:"C:\\Users\\Fixture\\.murage",ownership:{claimKind:"primary",recordedHost:"<img src=x>",currentHost:"FIXTURE",code:"LEASE_FOREIGN_HOST"}}};
    window.murageRecovery={action:async(action,id)=>{window.fixtureCalls.push({action,id}); if(action==="capture-separate")state.error="RECOVERY_CAPTURE_CANCELLED"; return structuredClone(state);}};
  },{skin});
  await page.goto("http://recovery.fixture/index.html",{waitUntil:"networkidle"});
  const capture=page.getByRole("button",{name:"Create separate recovery copy",exact:true}); await capture.waitFor(); assert.equal(await capture.isEnabled(),true);
  for(const action of ["backup","rollback","review-installation","choose-backup"])assert.equal(await page.locator(`button[data-action="${action}"]`).isDisabled(),true);
  assert.equal(await page.locator("#ownership-summary img").count(),0);
  await capture.focus(); assert.equal(await capture.evaluate(element=>element===document.activeElement),true);
  await page.screenshot({path:path.join(output,`recovery-${width}-${skin}.png`),fullPage:true});
  await capture.press("Enter"); await page.getByRole("alert").waitFor();
  assert.ok((await page.getByRole("alert").innerText()).includes("startup selection remain unchanged"));
  assert.deepEqual(await page.evaluate(()=>window.fixtureCalls.map(value=>value.action)),["state","capture-separate"]);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)); assert.deepEqual(errors,[]);
  results.push({skin,width,result:"PASS",scope:"actual recovery renderer; mocked main bridge; native UAC separate"}); await page.close();
} await writeFile(path.join(output,"result.json"),JSON.stringify(results,null,2)); console.log("PASS 6 recovery layouts and keyboard/cancel/disabled flows"); }
finally {await browser.close();}
