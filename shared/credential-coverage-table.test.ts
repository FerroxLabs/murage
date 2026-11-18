// secret-scan: fixture
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { credentialCoverage, checkCoverageCase, type CoverageCase } from "../server/testing/credential-coverage.ts";
import { SENSITIVE_PATHS } from "./sensitive-paths.ts";
import { dataCredentialHit } from "./data-credential-paths.ts";
import { credentialGlobHit, globKeyRead } from "./sensitive-globs.ts";
const table = readFileSync("docs/verification/gate-credential-writers-1018.md", "utf8");
const annotated = table.split("\n").filter(line => line.includes(" | coverage=")).join("\n");
it("checks every annotated representative destination through the production matchers", () => {
  const rows = credentialCoverage(annotated);
  expect(rows.length).toBeGreaterThan(20);
  for (const row of rows) {
    if (row.source.startsWith("deploy/cloud-home/")) {
      expect(row.cases.every(c => c.platform === "linux"), row.source).toBe(true);
    } else if (row.source.startsWith("electron/browser-extension-windows.mjs:") || row.source.startsWith("native/browser-extension/")) {
      expect(row.cases.some(c => c.platform === "win32"), row.source).toBe(true);
    } else {
      expect(row.cases.some(c => c.platform === "win32"), row.source).toBe(true);
      expect(row.cases.some(c => c.platform === "darwin"), row.source).toBe(true);
    }
  }
});
it("rejects missing columns, unknown entries and destinations outside the named entry", () => {
  const row = annotated.split("\n")[0]!;
  expect(() => credentialCoverage(row.split(" | coverage=")[0]!)).toThrow("missing coverage");
  expect(() => credentialCoverage(row.replace(/"cover":"[^"]+"/, '"cover":"not-a-rule"'))).toThrow("unknown cover");
  expect(() => credentialCoverage(row.replace(/"path":"[^"]+"/, '"path":"/ordinary/file"'))).toThrow("outside root");
});
it("BUILD-FIX 7: every A/B/C line declares checked coverage", () => {
  expect(credentialCoverage(table)).toHaveLength(168);
});
// Register each destination separately so one matcher finding cannot hide the remaining audit.
for (const line of table.split("\n").filter(line => /^[^ |]+:\d+ \| [ABC] \| /.test(line))) {
  const [source] = line.split(" | ");
  const marker = line.indexOf(" | coverage=");
  if (marker < 0) continue; // the whole-table assertion reports the missing column
  const cases = JSON.parse(line.slice(marker + " | coverage=".length)) as CoverageCase[];
  it.each(cases)(`${source}: $platform $branch $path`, row => checkCoverageCase(row, source!));
}
it.each([
  "/home/jane/.factory/mcp.json.42.tmp",
  "/home/jane/.gemini/config/.mcp_config.json.murage-42-123456789.tmp",
])("covers the actual owner writer temporary destination %s", path => {
  checkCoverageCase({ platform: "linux", root: "/home/jane", path, glob: path.slice(0, path.lastIndexOf("/")) + "/*", cover: "rule:owner-engine-config" }, "owner atomic writer");
});

// Convergence stop: a data-list ** must represent a FILE below its parent.
// These inert operands can only name directories; adding inventory entries
// cannot repair the matcher's zero-segment acceptance of native/**.
it.each([
  ["linux", "/data"],
  ["linux", "/relocated/data"],
  ["darwin", "/Users/Jane Doe/Library/Application Support/murage"],
  ["win32", "C:/Users/Jane Doe/AppData/Roaming/murage"],
] as const)("does not treat a directory-only native glob as a credential file on %s at %s", (platform, root) => {
  const options = { platform, roots: { temp: [], data: [root] } };
  expect(credentialGlobHit([root + "/native/*/config.*"], options)).not.toBeNull();
  expect(credentialGlobHit([root + "/nat*"], options)).toBeNull();
});

it.each([
  ["linux", "/data"],
  ["darwin", "/Users/Jane Doe/Library/Application Support/murage"],
  ["win32", "C:/Users/Jane Doe/AppData/Roaming/murage"],
] as const)("BUILD-FIX 14: data globstars require a file on %s", (platform, root) => {
  const options = { platform, roots: { temp: [], data: [root] } };
  const topLevel = credentialGlobHit([root + "/*"], options);
  expect(topLevel).toBe("murage-data-credentials:mcp-access.token");
  expect(topLevel).not.toBe("murage-data-credentials:native/**");
  expect(credentialGlobHit([root + "/nat*"], options)).toBeNull(); // ls /data/nat*
  for (const entry of ["native", "whatsapp/auth", "flux-connector-backups"]) {
    const directoryGlob = root + "/" + entry.slice(0, -1) + "[" + entry.at(-1) + "]";
    expect(credentialGlobHit([directoryGlob], options), directoryGlob).toBeNull();
    expect(credentialGlobHit([directoryGlob + "/x"], options)).toBe("murage-data-credentials:" + entry + "/**");
    expect(credentialGlobHit([root + "/" + entry + "/**"], options)).toBe("murage-data-credentials:" + entry + "/**");
    // Literal file paths are checked by the production coverage matcher.
    checkCoverageCase({ platform, root, path: root + "/" + entry + "/x", cover: entry + "/**" }, "BUILD-FIX 14 file");
  }
});
it("BUILD-FIX 14: runtime globstars require a file", () => {
  const options = { roots: { temp: [] }, runtime: [{ root: "/runtime", entries: ["auth/**"] }] };
  expect(credentialGlobHit(["/runtime/aut*"], options)).toBeNull();
  expect(credentialGlobHit(["/runtime/aut*/x"], options)).toBe("murage-data-credentials:auth/**");
});

it.each([
  "$OPENCODE_CONFIG_DIR/opencode.json",
  "${OPENCODE_CONFIG_DIR}/opencode.json",
  "$XDG_CONFIG_HOME/opencode/opencode.json",
  "${XDG_CONFIG_HOME}/opencode/opencode.json",
  "$GROK_HOME/config.toml", "$KIMI_CODE_HOME/config.toml", "$HERMES_HOME/config.yaml",
])("BUILD-FIX 15: covers atomic variable config %s", path => {
  checkCoverageCase({ platform: "linux", root: path.slice(0, path.lastIndexOf("/")), path: path + ".42.12345678-1234-1234-1234-123456789abc.tmp", glob: path + "*", cover: "rule:owner-engine-config" }, "BUILD-FIX 15 atomic variable");
});
it.each([
  ".config/opencode/opencode.jsonc.bak", ".config/opencode/opencode.json.md",
  ".config/opencode/opencode.jsonc.42.12345678-1234-1234-1234-123456789abc.tmp",
  ".config/opencode/opencode.json.42.not-a-uuid.tmp",
  ".factory/settings.json.42.tmp", ".gemini/config/mcp_config.json.murage-42-123456789.tmp",
])("BUILD-FIX 15: leaves ordinary owner neighbour uncarded %s", path => {
  expect(SENSITIVE_PATHS.find(row => row.id === "owner-engine-config")!.re.test("/home/jane/" + path)).toBe(false);
});

// BUILD-FIX 16: these are inert path strings, never reads of an owner home.
// Projections can overlap (e.g. ssh and keys-and-cluster-configs); isolate the
// row and read under audit so overlapping spellings cannot mask a failure.
function concreteRead(read: string): string {
  const uuid = "12345678-1234-1234-1234-123456789abc";
  return read.replace(/^\*\*\//, "fixture/")
    .replace(/murage-render-\*/, "murage-render-" + "a".repeat(16))
    .replace(/murage-(cred|mcp|pi-mcp)-\*/, "murage-$1-Ab12Cd")
    .replace(/murage-exec\*/, "murage-exec-abcdef")
    .replace(/murage-copilot-mcp\*/, "murage-copilot-mcp-Ab12Cd")
    .replace(/(murage-cred-Ab12Cd|claude-private)\/\*/, "$1/" + "a".repeat(32))
    .replace(/hook-env\/\*/, "hook-env/42-" + "a".repeat(16))
    .replace(/\.new-\*/, ".new-42")
    .replace(/\.murage-\*-\*\.tmp/, ".murage-42-123456789.tmp")
    .replace(/(mcp\.json)\.\*\.tmp/, "$1.42.tmp")
    .replace(/\.\*\.tmp/, ".42." + uuid + ".tmp")
    .replace(/\*serviceaccount\*/, "xserviceaccount.serviceaccount")
    .replace(/\.json\*$/, ".json")
    .replace(/\.enc\*$/, ".enc")
    .replace(/\*\*/g, "fixture")
    .replace(/\*/g, ".fixture");
}

for (const rule of SENSITIVE_PATHS) for (const read of rule.read) {
  it(`BUILD-FIX 16 test 1: every read spelling ${rule.id} ${read}`, () => {
    const iterator = vi.spyOn(SENSITIVE_PATHS, Symbol.iterator).mockImplementation(function* () { yield { ...rule, read: [read] }; });
    try {
      const path = concreteRead(read);
      expect(rule.re.test(path), path).toBe(true);
      if (read.endsWith("/**")) {
        const folder = read.slice(0, -3);
        expect(globKeyRead(folder + "/*"), folder).toBe(rule.re.source);
        const concreteFolder = concreteRead(folder);
        const folderOnly = concreteFolder.slice(0, -1) + "?";
        expect(globKeyRead(folderOnly), "folder only does not card: " + read).toBeNull();
      } else {
        // A shell glob token spells the literal space in Login Data as `?`.
        expect(globKeyRead(path.replaceAll(" ", "?") + "*"), path).toBe(rule.re.source);
      }
      const globRead = read.replaceAll(" ", "?");
      expect(globKeyRead(/[*?]/.test(globRead) ? globRead : globRead + "*"), read).toBe(rule.re.source);
    } finally { iterator.mockRestore(); }
  });
}

it("BUILD-FIX 16b: key directory globs require a file", () => {
  const ssh = SENSITIVE_PATHS.find(row => row.id === "ssh")!;
  expect(globKeyRead("ls ~/.ss?")).toBeNull();
  expect(globKeyRead("cat ~/.ss?/id_*")).toBe(ssh.re.source);
  expect(globKeyRead("ls ~/.ssh/*")).toBe(ssh.re.source);
});

it("BUILD-FIX 16 test 2: every inventory rule destination plus star", () => {
  for (const row of credentialCoverage(table)) for (const c of row.cases) {
    if (!c.cover.startsWith("rule:")) continue;
    const rule = SENSITIVE_PATHS.find(rule => rule.id === c.cover.slice(5))!;
    expect(rule.re.test(c.path), row.source + " " + c.path).toBe(true);
    expect(globKeyRead(c.path + "*", c.platform), row.source + " " + c.path).not.toBeNull();
  }
});

it("BUILD-FIX 16 test 3: inventory writer temporary and final-name globs", () => {
  const writers = ["opencode-go.ts", "flux-connector.ts", "browser-restore-store.ts", "local-servers.ts", "cloud-computer-turns.ts", "droid.ts", "antigravity-scope.ts"];
  const seen = new Set<string>();
  for (const row of credentialCoverage(table)) {
    const writer = writers.find(name => row.source.endsWith("/" + name + ":" + row.source.split(":").at(-1)));
    if (!writer) continue;
    for (const c of row.cases) {
      if (c.cover.startsWith("exempt:") || !/(?:\.tmp|\.murage-tmp-\d+)$/.test(c.path)) continue;
      seen.add(writer);
      // Antigravity's leading-dot temp has a different basename; final-name*
      // covers the final file, while the exact temporary spelling is checked too.
      const final = c.path.replace(/\/\.([^/]+)\.murage-\d+-\d+\.tmp$/, "/$1")
        .replace(/\.murage-tmp-\d+$/, "")
        .replace(/\.\d+(?:\.[0-9a-f-]+)?\.tmp$/, "");
      checkCoverageCase({ ...c, glob: c.path + "*" }, row.source);
      if (c.cover.startsWith("rule:")) expect(globKeyRead(final + "*", c.platform), final).not.toBeNull();
      else expect(credentialGlobHit([final + "*"], { platform: c.platform, roots: { temp: [], data: [c.root] } }), final).not.toBeNull();
    }
  }
  expect([...seen].sort()).toEqual(writers.sort());
  for (const root of ["/data", "/relocated/data", "C:/Users/Jane Doe/AppData/Roaming/murage", "/Users/Jane Doe/Library/Application Support/murage"]) {
    for (const file of ["local-models/local-servers.json", "cloud-computer-turns.json", "flux-connectors.json"]) {
      const temp = root + "/" + file + ".42.12345678-1234-1234-1234-123456789abc.tmp";
      expect(dataCredentialHit([temp], [root])).toBe("murage-data-credentials:" + file + ".*.tmp");
      expect(credentialGlobHit([root + "/" + file + "*"], { roots: { temp: [], data: [root] } })).toBe("murage-data-credentials:" + file);
    }
  }
});

it.each(['prettier "**/*.json"', "cat */*.json", "ls /tmp/*", "ls /data/nat*"])(
  "BUILD-FIX 16 test 4: ordinary control %s", command => {
    expect(globKeyRead(command)).toBeNull();
    expect(credentialGlobHit(command.split(/\s+/).map(word => word.replaceAll('"', '')), { roots: { temp: ["/tmp"], data: ["/data"] } })).toBeNull();
  },
);


it.each(["python3 -c 'print(L[i-1])'", "node -e 'console.log(a[z-a])'", "ls 'a[b' c[i-1]d", "ls /data/nat*"])(
  "BUILD-FIX 16c: ordinary glob stays quiet %s", command => {
    expect(globKeyRead(command)).toBeNull();
    expect(credentialGlobHit(command.split(/\s+/), { roots: { temp: ["/tmp"], data: ["/data"] } })).toBeNull();
  },
);

it("BUILD-FIX 16c: cards (accepted) cat README*", () => {
  expect(globKeyRead("cat README*")).not.toBeNull();
});

it("BUILD-FIX 16c: trailing auth wildcard remains active", () => {
  expect(globKeyRead("cat ~/.grok/auth.json*")).not.toBeNull();
  expect(globKeyRead("cat ~/.grok/auth*")).not.toBeNull();
});

for (const rule of SENSITIVE_PATHS) for (const read of rule.read) {
  const segment = read.split("/").at(-1)!;
  if (!segment.startsWith("*") || /^\*+$/.test(segment)) continue;
  if (segment.startsWith("*.")) it.each(["README*", "nat*"])(
    `BUILD-FIX 16c: cards (accepted) %s for ${rule.id} ${read}`, glob => {
      const iterator = vi.spyOn(SENSITIVE_PATHS, Symbol.iterator).mockImplementation(function* () { yield { ...rule, read: [read] }; });
      try { expect(globKeyRead(read.slice(0, read.length - segment.length) + glob)).toBe(rule.re.source); }
      finally { iterator.mockRestore(); }
    });
  it(`BUILD-FIX 16c: leading row wildcard ${rule.id} ${read}`, () => {
    const iterator = vi.spyOn(SENSITIVE_PATHS, Symbol.iterator).mockImplementation(function* () { yield { ...rule, read: [read] }; });
    try {
      const folder = read.slice(0, read.length - segment.length);
      const core = segment.replaceAll("*", "");
      for (const glob of [segment, "*" + core + "*", "x*", "?" + segment.slice(1)]) {
        expect(globKeyRead(folder + glob), glob).toBe(rule.re.source);
      }
      if (!segment.startsWith("*.")) for (const glob of ["README*", "nat*"]) expect(globKeyRead(folder + glob), glob).toBeNull();
      if (segment === "*serviceaccount*") expect(globKeyRead("*account*")).toBe(rule.re.source);
    } finally { iterator.mockRestore(); }
  });
}

it("X3 C H2 anchored home JSON glob intersects the owner config row", () => {
  // H2 removes the extension-only veto for actual anchored file globs.
  expect(globKeyRead("ls ~/*.json")).not.toBeNull();
  expect(credentialGlobHit(["ls", "~/*.json"], { roots: { temp: ["/tmp"], data: ["/data"] } })).toBeNull();
});
