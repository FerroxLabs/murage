import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { APPROVAL_IDENTITY_SITES as registry } from "../codemap/approval-identity-sites.ts";
import { C1_DEFAULT, PINNED_KIND, HERMES_C2 } from "../shared/tool-identity.ts";
import { hermesAskMatcher } from "./drivers/acp/hermes.ts";

const root = process.cwd();
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function files(dir: string): string[] {
  return readdirSync(dir, {withFileTypes:true}).flatMap(e => e.isDirectory() ? (e.name === "testing" ? [] : files(join(dir,e.name))) : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [join(dir,e.name)] : []);
}
const script = readFileSync(join(root,"codemap/tool-identity-sites-r12.sh"),"utf8");
const patterns = script.split("<<'PATTERNS'\n")[1]!.split("\nPATTERNS")[0]!.split("\n").map(line => {
  const at=line.indexOf("|"); return {tag:line.slice(0,at).split(" ")[0]!, regex:new RegExp(line.slice(at+1))};
});
describe("r1.2 structural inventory", () => {
  it("4: all 16 baseline patterns have one disposition per hit (including zero-hit P13)", () => {
    expect(patterns).toHaveLength(16);
    const base=readFileSync(join(root,"codemap/tool-identity-sites-r12.out"),"utf8");
    const hits=base.split("\n").filter(line => /^P\d+ /.test(line));
    expect(registry.baseline).toHaveLength(hits.length);
    expect(registry.baseline.filter(r=>r.tag==="P10")).toHaveLength(83);
    for (const hit of hits) {
      const [,tag,file,no,source]=/^(P\d+) ([^:]+):(\d+):(.*)$/.exec(hit)!;
      expect(registry.baseline.find(r=>r.tag===tag && r.file===file && r.line===Number(no))).toMatchObject({hash:hash(`${tag} ${file}:${source}`),disposition:expect.any(String)});
    }
  });
  it("4: a new live hit without a disposition fails", () => {
    const hits: string[]=[];
    for (const file of [...files(join(root,"server")),...files(join(root,"shared"))]) {
      const path=relative(root,file).replaceAll("\\","/");
      const sourceFile=readFileSync(file);
      // Match sites.sh / rg's binary-file exclusion (fuigo.ts contains NUL).
      if (sourceFile.includes(0)) continue;
      const lines=sourceFile.toString("utf8").split("\n");
      for (const {tag,regex} of patterns) for (const [index,line] of lines.entries()) {
        if (!regex.test(line)) continue;
        // sites.sh truncates the entire grep hit at 220 characters.
        const hit=Buffer.from(`${tag} ${path}:${index+1}:${line}`).subarray(0,220).toString("utf8");
        const source=hit.slice(hit.indexOf(":",hit.indexOf(":" )+1)+1);
        const key=hash(`${tag} ${path}:${source}`);
        hits.push(key);
        // MAIN RULING INT-CONFLICT-DEFAULT c83707eb9b a62419d6d5: current dispositions follow reviewed wipe/driver/log sites; all sixteen patterns and exact coverage remain.
        expect(registry.current.some(r=>r.hash===key), `${tag} ${path}:${index+1}`).toBe(true);
      }
    }
    expect(hits.sort()).toEqual(registry.current.map(r=>r.hash).sort());
  });
  it("C1 excludes default-other tools; C2 stays edit-only and hook-excluded", () => {
    expect(C1_DEFAULT).toHaveLength(7);
    for (const name of C1_DEFAULT) expect(["read","search","fetch"]).toContain(PINNED_KIND[name]);
    expect(HERMES_C2).toEqual(["write_file","patch"]);
    const match=new RegExp(`^(?:${hermesAskMatcher(false)})$`);
    for(const name of [...C1_DEFAULT,...HERMES_C2]) expect(match.test(name),name).toBe(false);
    for(const name of ["memory","todo_list","clarify","session_search","tool_describe","video_analyze","show_tip","read_terminal","read_window_below","x_search"]) expect(match.test(name),name).toBe(true);
  });
});
