import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { bootDataRoots, dataRootSeams } from "./data-roots.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

// P9 seam: realpath of one chosen folder answers in upper case, the way Windows answers for a DATA_DIR the lease case-folded.
const realpathCase = vi.hoisted(() => ({ folder: "", linkAt: "", inoAt: "" }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const realpath = (async (path: Parameters<typeof actual.realpath>[0], ...rest: unknown[]) => {
    const value = await Reflect.apply(actual.realpath, actual, [path, ...rest]) as string;
    return realpathCase.folder && String(path) === realpathCase.folder ? value.toUpperCase() : value;
  }) as typeof actual.realpath;
  // The fiction is a case-insensitive disk: the upper-case spelling of that one folder is the folder itself for stat and lstat.
  const unfold = (path: unknown) => realpathCase.folder && String(path) === realpathCase.folder.toUpperCase() ? realpathCase.folder : path;
  const stat = (async (path: Parameters<typeof actual.stat>[0], ...rest: unknown[]) => Reflect.apply(actual.stat, actual, [unfold(path), ...rest])) as typeof actual.stat;
  // An ancestor the test says is a link (linkAt) or another object than its real folder (inoAt): the part of the disk the case fold cannot show.
  const lstat = (async (path: Parameters<typeof actual.lstat>[0], ...rest: unknown[]) => {
    const value = await Reflect.apply(actual.lstat, actual, [unfold(path), ...rest]) as import("node:fs").BigIntStats;
    if (realpathCase.linkAt && String(path) === realpathCase.linkAt) return Object.assign(Object.create(value), { isSymbolicLink: () => true });
    if (realpathCase.inoAt && String(path) === realpathCase.inoAt) return Object.assign(Object.create(value), { ino: value.ino + 1n });
    return value;
  }) as typeof actual.lstat;
  return { ...actual, realpath, stat, lstat, default: { ...actual, realpath, stat, lstat } };
});
import { managedFuigoReceipt } from "./fuigo-native-update.ts";

it("S5 site 8 rebases the rollback CLI atomically and refuses unmatched previous paths without rewriting", async () => {
  mkdirSync(DATA_DIR, { recursive: true });
  const old = join(DATA_DIR, "old-root");
  writeFileSync(join(DATA_DIR, ".murage-root.json"), JSON.stringify({ schema: 1, root: old, previous: [] }));
  bootDataRoots();
  const root = join(DATA_DIR, "managed-engines");
  const cli = join(root, "fuigo", "fuigo", "1.0.9-abc", "fuigo");
  mkdirSync(dirname(cli), { recursive: true });
  writeFileSync(cli, "fixture");
  const file = join(dirname(cli), "manifest.json");
  const receipt = { schema: 1, instanceId: "fuigo", version: "1.0.9", binarySha256: "a".repeat(64), proof: { version: "1.0.9", protocolVersion: 1, loadSession: true, sessionCreated: true }, previousManagedCli: join(old, "managed-engines", "fuigo", "fuigo", "1.0.9-def", "fuigo") };
  writeFileSync(file, JSON.stringify(receipt));
  const expected = join(root, "fuigo", "fuigo", "1.0.9-def", "fuigo");
  expect((await managedFuigoReceipt(root, "fuigo", cli))?.previousManagedCli).toBe(expected);
  expect(JSON.parse(readFileSync(file, "utf8")).previousManagedCli).toBe(expected);
  receipt.previousManagedCli = join(old, "elsewhere", "fuigo");
  const bytes = JSON.stringify(receipt);
  writeFileSync(file, bytes);
  expect((await managedFuigoReceipt(root, "fuigo", cli))?.previousManagedCli).toBeUndefined();
  expect(readFileSync(file, "utf8")).toBe(bytes);
});

// P9 (fuigo-native-update.ts:253): the store folder is compared with its realpath in comparable() form. Only the win32 case
// fold is new; any link in the path still differs, so the receipt stays unread.
const temps: string[] = [];
afterAll(() => { for (const dir of temps) removeTempDirSync(dir); });
function canonicalTemp(prefix: string): string { const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix))); temps.push(dir); return dir; }
function store(base: string): { root: string; cli: string } {
  const root = join(base, "managed-engines"), cli = join(root, "fuigo", "fuigo", "1.0.9-abc", "fuigo");
  mkdirSync(dirname(cli), { recursive: true }); writeFileSync(cli, "fixture");
  writeFileSync(join(dirname(cli), "manifest.json"), JSON.stringify({ schema: 1, instanceId: "fuigo", version: "1.0.9", binarySha256: "a".repeat(64), proof: { version: "1.0.9", protocolVersion: 1, loadSession: true, sessionCreated: true } }));
  return { root, cli };
}
async function receiptAs(platform: NodeJS.Platform, root: string, cli: string) {
  const before = dataRootSeams.platform; dataRootSeams.platform = () => platform;
  try { return await managedFuigoReceipt(root, "fuigo", cli); } finally { dataRootSeams.platform = before; }
}
const linkType = process.platform === "win32" ? "junction" : "dir";

it("P9 win32: a store whose realpath differs only in case (a case-folded DATA_DIR) gives its receipt; null before P9", async () => {
  const { root, cli } = store(canonicalTemp("p9-case-"));
  realpathCase.folder = dirname(cli);
  try {
    expect((await receiptAs("win32", root, cli))?.version).toBe("1.0.9");
    // the fold is win32 only: on a case-sensitive platform the same answer is another folder
    expect(await receiptAs("linux", root, cli)).toBeNull();
  } finally { realpathCase.folder = ""; }
});

// P9 identity: equal comparable() forms are not enough on a case-sensitive Windows directory. A link 1.0.9-abc -> sibling
// 1.0.9-ABC realpaths to a spelling that case-folds to the link's own, so the fold alone would accept it.
it("P9 win32: a link whose target differs from it only in case is refused (case-folded equality also needs identity)", async ({ skip }) => {
  const base = canonicalTemp("p9-caselink-"), real = store(base);
  const versions = dirname(dirname(real.cli)), upper = join(versions, "1.0.9-ABC");
  renameSync(dirname(real.cli), upper);
  // a case-insensitive disk (default Windows and macOS) cannot hold a link beside its own upper-case spelling: nothing to prove there
  if (existsSync(join(versions, "1.0.9-abc"))) skip();
  symlinkSync(upper, join(versions, "1.0.9-abc"), linkType);
  const cli = join(versions, "1.0.9-abc", "fuigo");
  expect(await receiptAs("win32", real.root, cli)).toBeNull();
  expect(await receiptAs("linux", real.root, cli)).toBeNull();
});

// The walk in sameFolder (fuigo-native-update.ts) is reached only when realpath differs from the folder by the case fold. The store's
// two-component gate keeps real links out of the version folder's own ancestors, so the fiction says what lstat reports for one ancestor.
describe.each([["a link", "linkAt"], ["another object than its real folder (dev/ino)", "inoAt"]] as const)("P9 win32: case-folded equality and an ancestor that is %s", (_label, field) => {
  it.each(["store root", "id folder"] as const)(`refuses when the %s is it (null), and answers when it is not`, async level => {
    const { root, cli } = store(canonicalTemp("p9-walk-"));
    const folder = dirname(cli), ancestor = level === "id folder" ? join(root, "fuigo", "fuigo") : root;
    realpathCase.folder = folder;
    try {
      expect((await receiptAs("win32", root, cli))?.version).toBe("1.0.9");
      realpathCase[field] = ancestor;
      expect(await receiptAs("win32", root, cli)).toBeNull();
    } finally { realpathCase.folder = ""; realpathCase.linkAt = ""; realpathCase.inoAt = ""; }
  });
});

it.each(["linux", "darwin", "win32"] as const)("P9 %s: a link in the store path still gives no receipt; the real folder does", async platform => {
  const base = canonicalTemp("p9-link-"), real = store(join(base, "real"));
  expect((await receiptAs(platform, real.root, real.cli))?.version).toBe("1.0.9");
  const versions = join(base, "linked", "managed-engines", "fuigo", "fuigo");
  mkdirSync(versions, { recursive: true });
  symlinkSync(dirname(real.cli), join(versions, "1.0.9-abc"), linkType);
  expect(await receiptAs(platform, join(base, "linked", "managed-engines"), join(versions, "1.0.9-abc", "fuigo"))).toBeNull();
});

it.runIf(process.platform === "win32")("P9 win32 (real): a junction in the store path gives no receipt", async () => {
  const base = canonicalTemp("p9-junction-"), real = store(join(base, "real"));
  expect((await managedFuigoReceipt(real.root, "fuigo", real.cli))?.version).toBe("1.0.9");
  const versions = join(base, "linked", "managed-engines", "fuigo", "fuigo");
  mkdirSync(versions, { recursive: true });
  symlinkSync(dirname(real.cli), join(versions, "1.0.9-abc"), "junction");
  expect(await managedFuigoReceipt(join(base, "linked", "managed-engines"), "fuigo", join(versions, "1.0.9-abc", "fuigo"))).toBeNull();
});

// Intended for an ancestor link such as macOS /var -> /private/var: DATA_DIR is canonical (the lease resolves it), so the managed
// store under it is spelled canonically and its receipt is read. A spelling through the ancestor link is not the store's own
// realpath and is refused (null), the same fail-closed answer as any other link; P9 changes only the win32 case fold.
it("P9: a store reached through a linked ancestor folder gives no receipt; its canonical spelling does", async () => {
  const base = canonicalTemp("p9-ancestor-"), real = join(base, "private-var");
  mkdirSync(real); symlinkSync(real, join(base, "var"), linkType);
  const canonical = store(join(real, "home"));
  expect((await managedFuigoReceipt(canonical.root, "fuigo", canonical.cli))?.version).toBe("1.0.9");
  const viaLink = join(base, "var", "home", "managed-engines");
  expect(await managedFuigoReceipt(viaLink, "fuigo", join(viaLink, "fuigo", "fuigo", "1.0.9-abc", "fuigo"))).toBeNull();
});

it.runIf(process.platform === "darwin")("P9 darwin (real): a tmpdir under /var that realpaths to /private/var", async () => {
  const lexical = mkdtempSync(join(tmpdir(), "p9-var-")), canonical = realpathSync.native(lexical); temps.push(canonical);
  const real = store(canonical);
  expect((await managedFuigoReceipt(real.root, "fuigo", real.cli))?.version).toBe("1.0.9");
  if (canonical !== lexical) {
    const root = join(lexical, "managed-engines");
    expect(await managedFuigoReceipt(root, "fuigo", join(root, "fuigo", "fuigo", "1.0.9-abc", "fuigo"))).toBeNull();
  }
});
