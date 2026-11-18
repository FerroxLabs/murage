import { homedir } from "node:os";

/** The closed data-folder list. Conversation and artifact stores are absent. */
export const DATA_CREDENTIAL_ENTRIES = [
  "engine-homes/**/signin/**", "engine-homes/**/.codex/auth.json",
  "engine-homes/**/.grok/auth.json", "engine-homes/**/.kimi-code/credentials/*.json",
  "engine-homes/**/.local/share/opencode/auth.json", "engine-homes/**/.murage-state-*",
  "pip-tmp/**/config.toml",
  "native/**", "pip-tmp/**/auth.json", "browser-extension/client-configs/*.json",
  "browser-extension/client-configs/*.json.*.tmp", "browser-extension/client-configs/*.json.new-*",
  "bx-run/browser-*.json.new-*", "bx-run/native-host.json.new-*",
  "bx-run/browser-*.json", "bx-run/native-host.json", "mcp-access.token", "claude-private/*",
  "flux-hermes-home/config.yaml", "flux-hermes-home/config.yaml.*.tmp",
  "managed-companion-tunnel/connector-*.token", "cua-connection.json", "cua-connection.json.*.tmp",
  "browser-connection.json", "browser-connection.json.*.tmp",
  "browser-engine/*/home/.agent-browser/sessions/*.json",
  "browser-engine/*/home/.agent-browser/sessions/*.json.enc",
  "browser-engine/*/home/.agent-browser/sessions/*.murage-storage.enc",
  "browser-engine/*/home/.agent-browser/sessions/*.json.*.tmp",
  "browser-engine/*/home/.agent-browser/sessions/*.json.enc.*.tmp",
  "browser-engine/*/home/.agent-browser/sessions/*.murage-storage.enc.*.tmp",
  "config.json", "config.json.*.tmp", "companion-sidecar.pid",
  "credentials.bin", "credentials.bin.*.tmp", "credentials.enc", "credentials.enc.*.tmp",
  "whatsapp/auth-key", "whatsapp/auth/**", "browser-engine-key", "health-key",
  "webhooks.json", "webhooks.json.*.tmp", "local-servers.json", "local-servers.json.*.tmp",
  "local-models/local-servers.json", "local-models/local-servers.json.*.tmp",
  "flux-connectors.json", "flux-connectors.json.*.tmp",
  "cloud-computer-turns.json", "cloud-computer-turns.json.*.tmp",
  "flux-composio-broker-token.json", "flux-composio-broker-token.json.*.tmp",
  "claude-signin-answers.json", "claude-signin-answers.json.*.tmp",
  "cloud-homes/*", "env/*", "flux-connector-backups/**",
] as const;

export function dataCredentialRoots(): string[] {
  return [...new Set([process.env.MURAGE_DATA_DIR ?? homedir() + "/.murage", homedir() + "/.murage", "~/.murage",
    "$MURAGE_DATA_DIR", "$" + "{MURAGE_DATA_DIR}", "$HOME/.murage", "$" + "{HOME}/.murage", "$USERPROFILE/.murage", "$" + "{USERPROFILE}/.murage", "$env:USERPROFILE/.murage", "$" + "{env:USERPROFILE}/.murage", "%USERPROFILE%/.murage",
    ...(process.env.MURAGE_USER_DATA ? [process.env.MURAGE_USER_DATA] : []),
    ...(process.env.MURAGE_CLOUD_ROLE === "home" ? ["/data", "/data/engine-homes/hermesAgent"] : [])])];
}

const escape = (text: string): string => text.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
/** Patterns apply to files, so the final component cannot be empty. */
function entryPattern(entry: string): string {
  return entry.split("/").map((part, i, all) => part === "**" ? (i === all.length - 1 ? "[^\"'\\s;|&)<> ]*[^/\\s\"';|&)<>]" : "(?:[^/]+/)*")
    : part.split(/([*?])/).map(piece => piece === "?" ? "[^/]" : piece === "*" ? "\u0001" : escape(piece)).join("").split("\u0001").join(i === all.length - 1 && part === "*" ? "[^/\"'\\s;|&)<>]+" : "[^/\"'\\s;|&)<>]*")).join("/").replaceAll("(?:[^/]+/)*/", "(?:[^/]+/)*");
}

// Compilation is bounded and shared by literal and expansion reads. Rebuilding every
// inventory expression per glob entry made the scale gate depend on history length.
const compiled = new Map<string, readonly { entry: string; re: RegExp }[]>();
/** Literal-row counterpart to the command glob decision. */
export function dataCredentialHit(texts: readonly string[], roots = dataCredentialRoots(), entries: readonly string[] = DATA_CREDENTIAL_ENTRIES): string | null {
  const key = JSON.stringify([roots, entries]);
  let rows = compiled.get(key);
  if (!rows) {
    rows = roots.flatMap(root => {
      const prefix = "(?<![\\w./-])" + escape(root.replace(/\\/g, "/").replace(/\/$/, "")) + "/";
      return entries.map(entry => {
        const under = entry === "native/**" ? "native/(?![^/\\s\"']+\\.ndjson(?=$|[\"'\\s;|&)<>])|fuigo-turn-logs/)[^\"'\\s;|&)<>]*[^/\\s\"';|&)<>]" : entryPattern(entry);
        return { entry, re: new RegExp(prefix + under + "(?=$|[\"'\\s;|&)<>])", "i") };
      });
    });
    if (compiled.size >= 16) compiled.delete(compiled.keys().next().value!);
    compiled.set(key, rows);
  }
  for (const raw of texts) {
    const text = raw.replace(/\\/g, "/");
    for (const { entry, re } of rows) if (re.test(text)) return "murage-data-credentials:" + entry;
  }
  return null;
}
