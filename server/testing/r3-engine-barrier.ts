// Fake-engine receipt is not acceptance. Release this gate only after revoke
// and the adapter's stop request have landed. No production importers.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
export const r3Root = process.env.FAKE_R3_BARRIER;
export let r3Holding = false;
let retiring = false;
export function r3HoldRetirement(): boolean {
  const file = process.env.FAKE_R3_RETIRE;
  if (!file) return false;
  if (retiring) return true;
  retiring = true; r3Holding = true;
  process.on("SIGTERM", () => writeFileSync(`${file}.stopping`, String(process.pid)));
  writeFileSync(`${file}.waiting`, String(process.pid));
  const deadline = Date.now() + 15_000;
  const poll = setInterval(() => {
    if (existsSync(`${file}.release`) || Date.now() > deadline) {
      clearInterval(poll); process.exit(0);
    }
  }, 5);
  return true;
}
export function r3Record(event: string, detail?: unknown): void {
  if (r3Root) appendFileSync(`${r3Root}.journal`, JSON.stringify({ pid: process.pid, event, detail }) + "\n");
}
export async function r3Barrier(frame: unknown): Promise<void> {
  if (!r3Root) return;
  r3Holding = true;
  process.on("SIGTERM", () => r3Record("SIGTERM"));
  r3Record("received", frame);
  writeFileSync(`${r3Root}.waiting`, String(process.pid));
  const deadline = Date.now() + 15_000;
  while (!existsSync(`${r3Root}.release`)) {
    if (Date.now() > deadline) throw Error("R3 engine acceptance gate timed out");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  r3Record("released");
  // Keep TERM handled until exit: deliberately attempt output after Stop.
}
