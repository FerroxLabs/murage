import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
import { startMailServer } from "./mail-server.ts";

const command = process.argv[2];
if (!command) throw new Error("Mail gate command is required");

const fixture = await startMailServer();
try {
  const { directory, host, name, imap, imaps, smtp, smtps, account, password } = fixture;
  const path = join(directory, "connection.json");
  writeFileSync(path, JSON.stringify({
    host, name, imap, imaps, smtp, smtps, account, password, caPath: join(directory, "ca.pem"),
  }), { mode: 0o600 });
  const child = spawn("bash", ["-c", command], {
    stdio: "inherit",
    env: { ...process.env, MURAGE_MAILTEST_FIXTURE: path },
  });
  const interrupt = () => child.kill("SIGINT");
  const terminate = () => child.kill("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
    process.exitCode = code ?? (signal ? 128 + constants.signals[signal] : 1);
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
} finally {
  await fixture.close();
}
