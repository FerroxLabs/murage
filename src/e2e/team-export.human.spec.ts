import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
let server: ViteDevServer, origin: string, cache: string;
test.beforeAll(async()=>{
  const root=fileURLToPath(new URL('../../',import.meta.url));cache=mkdtempSync(join(tmpdir(),'murage-export-ui-'));
  server=await createServer({configFile:false,root,cacheDir:cache,envFile:false,resolve:{alias:{'@':`${root}/src`}},server:{host:'127.0.0.1',watch:null,hmr:false},plugins:[tailwindcss(),{
    name:'export-fixture',resolveId(id){if(id==='/__export.js')return '\0fixture-export';},load(id){if(id!=='\0fixture-export')return;return `import React from 'react';import {createRoot} from 'react-dom/client';import {TeamExportDialog} from '/src/components/TeamExportDialog.tsx';import '/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(TeamExportDialog,{onClose:()=>{},onExported:()=>{}}));`;},
    configureServer(vite){vite.middlewares.use((req,res,next)=>{if(req.url!=='/__export')return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/__export.js"></script>');});},
  }]});await server.listen(0);const address=server.httpServer!.address();if(!address||typeof address==='string')throw new Error('No fixture port');origin=`http://127.0.0.1:${address.port}`;
});
test.afterAll(async()=>{await server?.close();rmSync(cache,{recursive:true,force:true});});
const options={bots:[{id:'a',key:'a',name:'Researcher',playbookKeys:['research']}],playbooks:[{key:'research',name:'Research playbook'}],routines:[{id:'r',key:'r',name:'Daily review',botId:'a',supported:true}]};
test('selection review gates downloads and stale previews require another review',async({page},testInfo)=>{
  await page.setViewportSize({width:390,height:844});
  await page.route('**/api/desktop-secret',route=>route.fulfill({json:{secret:'fixture-secret'}}));
  const requests:any[]=[];let stale=true;
  await page.route('**/api/teams/export',async route=>{
    const body=route.request().postDataJSON();requests.push(body);
    if(body.action==='options')return route.fulfill({json:options});
    if(body.action==='preview')return route.fulfill({json:{name:'Selected',members:1,previewHash:'review-hash',markdown:'# Exact selected instructions',scan:{blocked:false,reviewRequired:true,findings:[{path:'instructions.md',rule:'environment-lookup',line:1}]}}});
    if(stale){stale=false;return route.fulfill({status:409,json:{error:'Contents changed.'}});}
    return route.fulfill({json:{name:'Selected',members:1,markdown:'# Selected package'}});
  });
  await page.goto(`${origin}/__export`);
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('button',{name:'Preview selection'})).toBeDisabled();
  await page.getByRole('checkbox',{name:'Researcher',exact:true}).check();
  await page.getByRole('button',{name:'Preview selection'}).click();
  await expect(page.getByRole('button',{name:'Download package'})).toBeDisabled();
  await page.getByText('Review exported text',{exact:true}).click();
  await expect(page.getByText('# Exact selected instructions',{exact:true})).toBeVisible();
  await page.getByRole('checkbox',{name:'Research playbook',exact:true}).check();
  await expect(page.getByRole('button',{name:'Download package'})).toHaveCount(0);
  await page.getByRole('button',{name:'Preview selection'}).click();
  await page.getByRole('checkbox',{name:/I reviewed the warnings/}).check();
  await page.getByRole('button',{name:'Download package'}).click();
  await expect(page.getByRole('alert')).toContainText('Preview the selection again');
  await expect(page.getByRole('button',{name:'Download package'})).toHaveCount(0);
  await page.getByRole('button',{name:'Preview selection'}).click();
  await expect(page.getByRole('checkbox',{name:/I reviewed the warnings/})).not.toBeChecked();
  await page.getByRole('checkbox',{name:/I reviewed the warnings/}).check();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('export-reviewed-mobile.png')});
  const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'Download package'}).click();
  expect((await downloaded).suggestedFilename()).toBe('selected.emberbot.md');
  expect(requests.filter(item=>item.action==='download').at(-1)).toMatchObject({selection:{botIds:['a'],playbookKeys:['research'],routineIds:[]},previewHash:'review-hash',acknowledgeWarnings:true});
});
test('blocked scan never renders payload content or enables download',async({page})=>{
  await page.route('**/api/desktop-secret',route=>route.fulfill({json:{secret:'fixture-secret'}}));
  await page.route('**/api/teams/export',route=>route.fulfill({json:route.request().postDataJSON().action==='options'?options:{name:'Blocked',members:1,previewHash:'blocked',markdown:'FAKE_SECRET_MUST_NOT_RENDER',scan:{blocked:true,reviewRequired:true,findings:[{path:'instructions.md',rule:'provider-token'}]}}}));
  await page.goto(`${origin}/__export`);await page.getByRole('checkbox',{name:'Researcher',exact:true}).check();
  await page.getByRole('button',{name:'Preview selection'}).click();
  await expect(page.getByRole('alert')).toContainText('Export blocked');
  await expect(page.getByRole('button',{name:'Download package'})).toBeDisabled();
  await expect(page.getByText('FAKE_SECRET_MUST_NOT_RENDER')).toHaveCount(0);
});

test("ZIP export selects only chosen bots' skills and binds reviewed files to an authenticated download", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/desktop-secret", route => route.fulfill({ json: { secret: "fixture-secret" } }));
  await page.route("**/api/teams/export", route => route.fulfill({ json: options }));
  const requests: any[] = [];
  const zipBytes = Buffer.from("504b0506000000000000000000000000000000000000", "hex");
  let stale = true;
  await page.route("**/api/packages/export", async route => {
    const body = route.request().postDataJSON(); requests.push(body);
    if (body.action === "options") return route.fulfill({ json: { ...options,
      skills: [{ id: "a:research", botId: "a", name: "Research files", license: "MIT", dependencies: null }, { id: "other:private", botId: "other", name: "Unselected private files", dependencies: null }],
    } });
    if (body.action === "preview") return route.fulfill({ json: {
      name: "Selected ZIP", members: 1, previewHash: "zip-review-hash",
      scan: { blocked: false, reviewRequired: false, findings: [] },
      files: body.selection.skillIds.length ? [{ path: "skills/research/SKILL.md", bytes: 31, sha256: "a".repeat(64), content: "# Exact selected skill contents" }] : [],
      reviewWarnings: body.selection.skillIds.length ? ["Dependency metadata is unknown. Review the selected skill files."] : [],
    } });
    expect(route.request().headers()["x-murage-surface"]).toBe("desktop");
    expect(route.request().headers()["x-murage-surface-secret"]).toBe("fixture-secret");
    if (stale) { stale = false; return route.fulfill({ status: 409, json: { error: "Selected skill changed." } }); }
    return route.fulfill({ contentType: "application/zip", body: zipBytes });
  });
  await page.goto(origin + "/__export");
  await page.getByRole("radio", { name: "ZIP package (.zip)", exact: true }).check();
  await expect(page.getByText("Select a bot to choose its skills.")).toBeVisible();
  await page.getByRole("checkbox", { name: "Researcher", exact: true }).check();
  const skill = page.getByRole("checkbox", { name: /Research files/ });
  await expect(skill).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: /Unselected private files/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Preview selection" }).click();
  expect(requests.at(-1).selection.skillIds).toEqual([]);
  await skill.check();
  await expect(page.getByRole("button", { name: "Download ZIP package" })).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Researcher", exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "Researcher", exact: true }).check();
  await expect(skill).not.toBeChecked();
  await skill.check();
  await page.getByRole("button", { name: "Preview selection" }).click();
  await expect(page.getByRole("button", { name: "Download ZIP package" })).toBeDisabled();
  await expect(page.getByLabel("Dependency review warnings")).toContainText("Dependency metadata is unknown");
  await page.getByText("Review included files (1)", { exact: true }).click();
  await expect(page.getByText("# Exact selected skill contents", { exact: true })).toBeVisible();
  await page.getByRole("checkbox", { name: /I reviewed the warnings/ }).check();
  await page.getByRole("button", { name: "Download ZIP package" }).click();
  await expect(page.getByRole("alert")).toContainText("Preview the selection again");
  await expect(page.getByRole("button", { name: "Download ZIP package" })).toHaveCount(0);
  await page.getByRole("button", { name: "Preview selection" }).click();
  await expect(page.getByRole("checkbox", { name: /I reviewed the warnings/ })).not.toBeChecked();
  await page.getByRole("checkbox", { name: /I reviewed the warnings/ }).check();
  await page.getByText("Review included files (1)", { exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("zip-export-reviewed-mobile.png") });
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download ZIP package" }).click();
  const file = await downloaded;
  expect(file.suggestedFilename()).toBe("selected-zip.zip");
  expect(readFileSync((await file.path())!)).toEqual(zipBytes);
  expect(requests.at(-1)).toMatchObject({ action: "download", selection: { botIds: ["a"], playbookKeys: [], routineIds: [], skillIds: ["a:research"] }, previewHash: "zip-review-hash", acknowledgeWarnings: true });
});

test("blocked ZIP review hides all file contents and prevents download", async ({ page }) => {
  await page.route("**/api/desktop-secret", route => route.fulfill({ json: { secret: "fixture-secret" } }));
  await page.route("**/api/teams/export", route => route.fulfill({ json: options }));
  await page.route("**/api/packages/export", route => route.fulfill({ json: route.request().postDataJSON().action === "options"
    ? { ...options, skills: [] }
    : { name: "Blocked", members: 1, previewHash: "blocked", scan: { blocked: true, reviewRequired: true, findings: [{ path: "manifest.json", rule: "provider-token" }] }, files: [{ path: "private.txt", bytes: 10, sha256: "b".repeat(64), content: "ZIP_SECRET_MUST_NOT_RENDER" }], reviewWarnings: [] },
  }));
  await page.goto(origin + "/__export");
  await page.getByRole("radio", { name: "ZIP package (.zip)", exact: true }).check();
  await page.getByRole("checkbox", { name: "Researcher", exact: true }).check();
  await page.getByRole("button", { name: "Preview selection" }).click();
  await expect(page.getByRole("alert")).toContainText("Export blocked");
  await expect(page.getByRole("button", { name: "Download ZIP package" })).toBeDisabled();
  await expect(page.getByText("ZIP_SECRET_MUST_NOT_RENDER")).toHaveCount(0);
  await expect(page.getByText(/Review included files/)).toHaveCount(0);
});
