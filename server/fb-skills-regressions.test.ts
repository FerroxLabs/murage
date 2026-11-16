import { afterAll, beforeAll, expect, it } from "vitest";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
let fixture: VerificationServer;
let headers: Record<string, string>;
const calls: unknown[] = [];
beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    import {mkdirSync,writeFileSync} from 'node:fs';
    import {join} from 'node:path';
    const root=join(process.env.MURAGE_DATA_DIR,'fixture-skills'); mkdirSync(root);
    process.env.MURAGE_SKILL_LIBRARY=root;
    for(let i=0;i<600;i++) {
      const id='planning-'+String(i).padStart(3,'0'); const dir=join(root,id); mkdirSync(dir);
      const description=i===599?'Unique tail marker':'Plan supplied tasks';
      writeFileSync(join(dir,'manifest.json'),JSON.stringify({id,name:id,version:'1.0.0',description,defaultEnabled:false,triggerTerms:['planning','topic-'+(i%20)],requiredCapabilities:[]}));
      writeFileSync(join(dir,'SKILL.md'),'---\\nname: '+id+'\\ndescription: '+description+'\\n---\\nRead supplied notes and draft a plan.\\n');
    }
  ` });
  const proof = await (await fetch(fixture.info.url + "/api/desktop-secret")).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret, "content-type": "application/json" };
  console.log("FB fixture", fixture.info);
}, 120_000);
afterAll(async () => {
  await fixture?.close();
  const out = process.env.FB_SKILLS_EVIDENCE_DIR;
  if (out && fixture) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "api-workflow.json"), JSON.stringify({ fixture: fixture.info, calls }, null, 2));
    copyFileSync(fixture.info.logPath, join(out, "api-server.log"));
  }
});
async function api(path: string, body?: unknown): Promise<any> {
  const response = await fetch(fixture.info.url + path, { headers, ...(body ? { method: "POST", body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  calls.push({ method: body ? "POST" : "GET", path, body, status: response.status, result });
  expect(response.status).toBe(200); return result;
}
it("FB1 API: all starters expose their actual instructions without importing", async () => {
  const before = await api("/api/bots");
  const { profiles } = await api("/api/starter-profiles", { action: "catalog" });
  for (const profile of profiles) {
    const review = await api("/api/starter-profiles", { action: "preview", profileId: profile.id, selection: { agents: profile.agents.map((a: any) => a.key), skills: [], instructions: [], routines: [] } });
    const pkg = JSON.parse(readFileSync(`library/packages/${profile.id}.json`, "utf8")).package;
    for (const playbook of pkg.playbooks) expect(review.profileText).toContain(playbook.instructions);
  }
  expect(await api("/api/bots")).toEqual(before);
});
for (const surface of ["library", "picker"]) it(`FB${surface === "library" ? 2 : 3} API: ${surface} reaches every skill in a 600-skill topic and searches within it`, async () => {
  const refs: string[] = [];
  const endpoint = surface === "library" ? "/api/library/search?term=planning" : "/api/skills?category=planning";
  const first = await api(`${endpoint}&limit=60&offset=0`);
  const second = await api(`${endpoint}&limit=60&offset=60`);
  expect((second.skills ?? second.library).map((s: any) => s.id ?? s.ref)).not.toEqual((first.skills ?? first.library).map((s: any) => s.id ?? s.ref));
  for (let offset = 0; offset < 600; offset += 60) {
    const result = await api(`${endpoint}&limit=60&offset=${offset}`);
    const page = result.pagination;
    expect(page).toMatchObject({ total: 600, offset, limit: 60 });
    const rows = result.skills ?? result.library;
    expect(rows).toHaveLength(60); refs.push(...rows.map((s: any) => s.id ?? s.ref));
  }
  expect(new Set(refs).size).toBe(600);
  const result = await api(`${endpoint}&q=Unique`);
  expect(result.pagination.total).toBe(1);
  expect((result.skills ?? result.library)[0].id ?? result.library[0].ref).toContain("planning-599");
  expect((await api(`${endpoint}&q=nonexistentneedle`)).pagination.total).toBe(0);
});
it("FB3 API: the picker offers every topic from Browse templates", async () => {
  const browse = await api("/api/library/browse");
  expect(browse.facets).toHaveLength(21);
  const picker = await api("/api/skills");
  expect(picker.categories).toEqual(browse.facets.map((f: any) => ({ name: f.term, count: f.count })));
  const lastTopic = await api("/api/skills?category=topic-19");
  expect(lastTopic.pagination.total).toBe(30);
  expect(lastTopic.library).toHaveLength(30);
  expect((await api("/api/skills?category=topic-18&q=Unique")).pagination.total).toBe(0);
});

it("FB2/FB3 API: free search pages past 60 results and bounds malformed page requests", async () => {
  for (const endpoint of ["/api/library/search?q=planning", "/api/skills?q=planning"]) {
    const page = await api(endpoint + "&offset=540&limit=60");
    expect(page.pagination).toEqual({ offset: 540, limit: 60, total: 600 });
    expect(page.skills ?? page.library).toHaveLength(60);
    const bounded = await api(endpoint + "&offset=-2&limit=999999");
    expect(bounded.pagination).toEqual({ offset: 0, limit: 100, total: 600 });
    expect(bounded.skills ?? bounded.library).toHaveLength(100);
    expect((await api(endpoint + "&offset=999999&limit=60")).pagination.offset).toBe(540);
  }
});
