import { cloudHomeCopy } from "./copy.ts";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";

export type HomeBootContract = { machineId: string; adminUrl: string; publicOrigin: string; bootstrapSecret: string; siteOrigin?: string };
export function homeBootContract(env: NodeJS.ProcessEnv): HomeBootContract | null {
  const names = ["MURAGE_CLOUD_MACHINE_ID", "MURAGE_CLOUD_ADMIN_URL", "MURAGE_CLOUD_BOOTSTRAP_SECRET", "MURAGE_PUBLIC_ORIGIN"];
  if (env.MURAGE_CLOUD_ROLE !== "home") {
    if (env.MURAGE_CLOUD_ROLE || names.some(key => env[key])) throw new Error(cloudHomeCopy.incompleteHomeBootContract);
    return null;
  }
  if (names.some(key => !env[key]?.trim())) throw new Error(cloudHomeCopy.incompleteHomeBootContract);
  const machineId = env.MURAGE_CLOUD_MACHINE_ID!;
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(machineId)) throw new Error(cloudHomeCopy.invalidHomeMachineIdentity);
  const admin = new URL(env.MURAGE_CLOUD_ADMIN_URL!);
  const origin = new URL(env.MURAGE_PUBLIC_ORIGIN!);
  if ([admin, origin].some(url => url.protocol !== "https:" || url.username || url.password || url.hash || url.search) || origin.pathname !== "/") throw new Error(cloudHomeCopy.homeEndpointsMustUseHTTPS);
  if (Buffer.byteLength(env.MURAGE_CLOUD_BOOTSTRAP_SECRET!) < 32) throw new Error(cloudHomeCopy.homeBootstrapSecretIsTooShort);
  // Optional door input: the murage.ai site origin (the home's id is MURAGE_CLOUD_MACHINE_ID) its "Continue from murage.ai" button links to. No defaults;
  // a site origin that is not a bare https origin is dropped, so the page shows the add-device steps without the button.
  let siteOrigin: string | undefined;
  try { const site = new URL(env.MURAGE_SITE_ORIGIN ?? ""); if (site.protocol === "https:" && !site.username && !site.password && !site.search && !site.hash && site.pathname === "/") siteOrigin = site.origin; } catch { /* unset or invalid */ }
  return { machineId, adminUrl: admin.href, publicOrigin: origin.origin, bootstrapSecret: env.MURAGE_CLOUD_BOOTSTRAP_SECRET!, ...(siteOrigin ? { siteOrigin } : {}) };
}

export const HOME_SERVER_ENV_KEYS = [
  "PATH", "HOME", "LANG", "TZ", "NODE_ENV", "MURAGE_CLOUD_ROLE", "MURAGE_CLOUD_MACHINE_ID",
  "MURAGE_CLOUD_ADMIN_URL", "MURAGE_PUBLIC_ORIGIN", "MURAGE_CLOUD_SECRETS_FD", "MURAGE_DATA_DIR",
  "MURAGE_PORT", "MURAGE_WEBHOOK_PORT", "WEBHOOK_PORT", "MURAGE_NO_DEV_DESKTOP_SECRET", "MURAGE_RESOURCES_PATH",
  "MURAGE_TRUSTED_PROXY", "MURAGE_WARM_POOL_BUDGET_MB", "MURAGE_STATIC_DIR", "MURAGE_SENTINEL_STATE_DIR",
] as const;
/** Set only when the home starts in safe mode (start-home.sh consumes /run/murage-safe-mode, written by murage-commands). */
export const HOME_SERVER_OPTIONAL_ENV_KEYS = ["MURAGE_SAFE_MODE", "MURAGE_SITE_ORIGIN"] as const;
export function homeServerEnvironment(contract: HomeBootContract, timeZone: string, webhookPort = "8800", safeMode = false): NodeJS.ProcessEnv {
  if (!/^[0-9]+$/u.test(webhookPort) || Number(webhookPort) < 1024 || Number(webhookPort) > 65535 || Number(webhookPort) === 8799) throw new Error(cloudHomeCopy.invalidHomeWebhookPort);
  new Intl.DateTimeFormat("en", { timeZone }).format();
  return {
    PATH: "/opt/murage/bin:/usr/local/bin:/usr/bin:/bin", HOME: "/data/server-home", LANG: "C.UTF-8", TZ: timeZone,
    NODE_ENV: "production", MURAGE_CLOUD_ROLE: "home", MURAGE_CLOUD_MACHINE_ID: contract.machineId,
    MURAGE_CLOUD_ADMIN_URL: contract.adminUrl, MURAGE_PUBLIC_ORIGIN: contract.publicOrigin,
    MURAGE_CLOUD_SECRETS_FD: "3", MURAGE_DATA_DIR: "/data/home", MURAGE_PORT: "8799", MURAGE_WEBHOOK_PORT: webhookPort, WEBHOOK_PORT: webhookPort,
    MURAGE_NO_DEV_DESKTOP_SECRET: "1", MURAGE_RESOURCES_PATH: "/opt/murage/resources",
    MURAGE_TRUSTED_PROXY: "unix:/data/proxy/murage.sock",
    // The warm pool's default budget is min(25% of RAM, RAM - 6 GB), which is 0 on a 4 GB home (every warm
    // engine would be evicted as "pool budget"). MurageMobile's decision: a Cloud home sets 1200 MB explicitly.
    // MURAGE_WARM_POOL_MIN_FREE_MB stays at its 1.5 GB default: an idle 4 GB home holds ~2.8 GB available with
    // an engine warm (b3 measurement), so the floor does not evict.
    MURAGE_WARM_POOL_BUDGET_MB: "1200",
    // The built web app (build-image.sh writes /opt/murage/dist); without it the home serves no UI at all.
    MURAGE_STATIC_DIR: "/opt/murage/dist",
    // Where murage-sentinel.service keeps its output (the same line is in that unit), so owner reads and delivery
    // find the scanner's descriptor, store and view (server/sentinel/paths.ts defaultOutputRoot).
    MURAGE_SENTINEL_STATE_DIR: "/var/lib/murage-sentinel",
    ...(safeMode ? { MURAGE_SAFE_MODE: "1" } : {}),
    ...(contract.siteOrigin ? { MURAGE_SITE_ORIGIN: contract.siteOrigin } : {}),
  };
}

/** Reject links and oversized files before reading root-owned startup material. */
export function readBootFile(file: string, limit = 64 * 1024): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit || stat.uid !== 0 || (stat.mode & 0o077) !== 0) throw new Error(cloudHomeCopy.homeBootFileMustBePrivateAndRootOwned);
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}
