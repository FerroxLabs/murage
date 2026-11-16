// Producer owner: sc-safety (fixture relay protocol). Consumer owner: new3-g2 (fake engine workflows).
import type { ChildProcess } from "node:child_process";
const held = new Set<ChildProcess>();
process.once("exit", () => { for (const child of held) { try { child.kill(); } catch { /* already reaped */ } } });
/** A relay shim is the engine's persistent MCP connection, not the tool
 * server. Closing it before the fake emits its answer correctly seals the
 * real turn. Let the engine's own exit/retirement close that connection. */
export function holdFixtureRelayClient(child: ChildProcess, args: readonly string[] | undefined): boolean {
  if (!args?.some(arg => /^cli-mount-shim\.(?:ts|js|mjs|cjs)$/.test(arg.replace(/\\/g, "/").split("/").at(-1) ?? ""))) return false;
  held.add(child); child.once("exit", () => held.delete(child));
  child.unref();
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    const unref = stream && Reflect.get(stream, "unref");
    if (typeof unref === "function") Reflect.apply(unref, stream, []);
  }
  return true;
}
