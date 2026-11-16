// Producer owner: sc-safety (immutable relay observation). Consumer owner: new3-g2 (fake ACP behavior).
import { afterEach, expect, it } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDirSync } from "./cleanup.ts";
const helper = existsSync(new URL("./fixture-mount-metadata.ts", import.meta.url)) ? await import("./fixture-mount-metadata.ts") : undefined;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mount-observation-")); roots.push(root);
  const socket = join(root, "relay");
  const entry = { name: "agents", command: "fixture-shim", args: ["fixture"], env: [{ name: "MURAGE_RELAY_SOCKET", value: socket }, { name: "MURAGE_RELAY_TICKET", value: "fixture" }] };
  type MountEntry = typeof entry;
  const observe = helper?.withFixtureMountMetadata ?? ((entry: MountEntry | null) => entry);
  return { socket, entry, observe };
}
it("CROSS-SC-METADATA depth and service flags come from the observed immutable mount", () => {
  const {socket,entry,observe}=fixture();
  writeFileSync(socket+'.fixture-metadata.json',JSON.stringify({mounts:{agents:{MURAGE_TURN_DEPTH:"1",MURAGE_EMAIL:"read",MURAGE_VENUE_POST:"1",MURAGE_PROJECT_ROLE:"member"}}}));
  const view=observe(entry)!;
  expect(view.env).toEqual([...entry.env,{name:"MURAGE_TURN_DEPTH",value:"1"},{name:"MURAGE_EMAIL",value:"read"},{name:"MURAGE_VENUE_POST",value:"1"},{name:"MURAGE_PROJECT_ROLE",value:"member"}]);
  expect(view.command).toBe(entry.command); expect(view.args).toBe(entry.args);
  expect(entry.env).toHaveLength(2);
});
it("CROSS-SC-METADATA the observation cannot add credentials or borrow another mount", () => {
  const {socket,entry,observe}=fixture();
  writeFileSync(socket+'.fixture-metadata.json',JSON.stringify({mounts:{agents:{MURAGE_TURN_DEPTH:"1",MURAGE_COMMS_TOKEN:"fixture"},other:{MURAGE_EMAIL:"write"}}}));
  const view=observe(entry)!;
  expect(view.env?.find(row=>row.name==="MURAGE_TURN_DEPTH")?.value).toBe("1");
  expect(view.env?.find(row=>row.name==="MURAGE_COMMS_TOKEN")).toBeUndefined();
  expect(view.env?.find(row=>row.name==="MURAGE_EMAIL")).toBeUndefined();
  expect(observe(null)).toBeNull();
});
