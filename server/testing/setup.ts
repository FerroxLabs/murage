// Vitest setup — every test file gets a throwaway home directory so
// DATA_DIR (~/.openmausbot) never touches the real one. os.homedir()
// reads HOME (POSIX) / USERPROFILE (Windows) at call time, and this file
// runs before any test module imports server/config.ts.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach } from "vitest";

const home = mkdtempSync(join(tmpdir(), "omb-test-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

// SQLite keeps the database file open for the lifetime of its handle.
// Windows will not remove a directory containing an open database, so close
// the per-test handle before the next test resets its throwaway data dir.
const { closeMessageDb } = await import("../message-db.ts");
afterEach(closeMessageDb);

afterAll(async () => {
  closeMessageDb();
  // Windows holds a directory that is a live process's cwd, and a
  // just-killed CLI lets go a beat after the kill call returns (rmSync's own
  // maxRetries does not cover an EPERM on the directory itself). Retry
  // briefly — and never fail a green suite over a temp dir.
  let lastError: unknown;
  for (let i = 0; i < 20; i++) {
    try {
      return rmSync(home, { recursive: true, force: true });
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  console.warn(
    `test cleanup could not remove ${home}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
});
