// Lifecycle for the remotely-managed Cloudflare Tunnel connector.
//
// This module deliberately knows nothing about account UI or Electron IPC.
// Its only secret input is the connector token already held in Electron's OS
// credential store. The token is handed to cloudflared through a private,
// short-lived file; it is never put in argv, the environment, status, or logs.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MANAGED_COMPANION_ENDPOINT_FIELD = "managedCompanionEndpointUrl";
export const MANAGED_COMPANION_TOKEN_FIELD = "managedCompanionConnectorToken";

const TOKEN_FILE_PATTERN = /^connector-([1-9][0-9]*)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.token$/;
const TOKEN_MIN_BYTES = 40;
const TOKEN_MAX_BYTES = 16 * 1024;
const isString = (value) => Object.prototype.toString.call(value) === "[object String]";

/** Only a complete HTTPS origin can ever become a phone route. */
export function normalizeManagedCompanionEndpoint(value) {
  if (!isString(value) || !value.trim()) return "";
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    return "";
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search ||
    parsed.hash
  ) {
    return "";
  }
  return parsed.origin;
}

function validConnectorToken(value) {
  if (!isString(value)) return false;
  const bytes = Buffer.byteLength(value);
  return (
    bytes >= TOKEN_MIN_BYTES &&
    bytes <= TOKEN_MAX_BYTES &&
    value.trim() === value &&
    !/[\0\r\n\t ]/.test(value)
  );
}

/** Read the all-or-nothing tunnel credential from Electron's encrypted blob. */
export function managedCompanionTunnelAccess(credentials) {
  const endpoint = normalizeManagedCompanionEndpoint(
    credentials?.[MANAGED_COMPANION_ENDPOINT_FIELD],
  );
  const token = credentials?.[MANAGED_COMPANION_TOKEN_FIELD];
  if (!endpoint || !validConnectorToken(token)) return null;
  return { endpoint, token };
}

/** Validate a control-plane provision response and return a copy to persist. */
export function withManagedCompanionTunnelAccess(credentials, provision) {
  const endpoint = normalizeManagedCompanionEndpoint(provision?.endpoint?.url);
  const token = provision?.connectorToken;
  if (!endpoint || !validConnectorToken(token)) {
    throw new Error("The companion service returned an invalid managed endpoint");
  }
  return {
    ...credentials,
    [MANAGED_COMPANION_ENDPOINT_FIELD]: endpoint,
    [MANAGED_COMPANION_TOKEN_FIELD]: token,
  };
}

export function withoutManagedCompanionTunnelAccess(credentials) {
  const next = { ...credentials };
  delete next[MANAGED_COMPANION_ENDPOINT_FIELD];
  delete next[MANAGED_COMPANION_TOKEN_FIELD];
  return next;
}

/** Packaged apps only trust the connector shipped in Resources. Development
 * can opt into an absolute binary path, use a freshly-staged release, or fall
 * back to PATH for contributor convenience. */
export function resolveCloudflaredBinary({
  isPackaged,
  resourcesPath,
  appPath,
  platform = process.platform,
  arch = process.arch,
  environment = process.env,
  exists = fs.existsSync,
} = {}) {
  const executable = platform === "win32" ? "cloudflared.exe" : "cloudflared";
  const bundled = path.join(String(resourcesPath ?? ""), "cloudflared", executable);
  if (isPackaged) return exists(bundled) ? bundled : null;

  const override = environment.OMB_CLOUDFLARED_PATH?.trim();
  if (override) return path.isAbsolute(override) && exists(override) ? override : null;

  const staged = path.join(
    String(appPath ?? ""),
    "dist-native",
    "cloudflared",
    `${platform}-${arch}`,
    executable,
  );
  if (exists(staged)) return staged;
  return executable;
}

function ensurePrivateDirectory(directory, fileSystem, currentUid) {
  fileSystem.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fileSystem.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("The managed companion runtime path is unsafe");
  }
  if (currentUid !== undefined && stat.uid !== currentUid) {
    throw new Error("The managed companion runtime path has an unexpected owner");
  }
  fileSystem.chmodSync(directory, 0o700);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

// Node reports synthetic, non-matching uid values for Windows directory
// stats and os.userInfo(). ACLs on Electron's per-user data directory are the
// ownership boundary there; applying the Unix uid comparison would reject
// every valid Windows runtime directory.
const currentUserId = () =>
  process.platform === "win32" ? undefined : (process.getuid?.() ?? os.userInfo().uid);

/** Remove only token files created by a dead OpenMausBot process. Suspicious
 * paths are preserved instead of broadening cleanup around a secret. */
export function cleanupStaleManagedCompanionTokens(
  runtimeRoot,
  {
    fileSystem = fs,
    currentUid = currentUserId(),
    isProcessAlive = processIsAlive,
  } = {},
) {
  let entries;
  try {
    ensurePrivateDirectory(runtimeRoot, fileSystem, currentUid);
    entries = fileSystem.readdirSync(runtimeRoot, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    const match = TOKEN_FILE_PATTERN.exec(entry.name);
    if (!match || !entry.isFile() || entry.isSymbolicLink()) continue;
    const ownerPid = Number(match[1]);
    if (!Number.isSafeInteger(ownerPid) || isProcessAlive(ownerPid)) continue;
    const file = path.join(runtimeRoot, entry.name);
    try {
      const stat = fileSystem.lstatSync(file);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        (currentUid !== undefined && stat.uid !== currentUid) ||
        (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
      ) {
        continue;
      }
      fileSystem.unlinkSync(file);
      removed += 1;
    } catch {
      // Best effort. A concurrently changed file is safer left untouched.
    }
  }
  return removed;
}

function writePrivateToken(runtimeRoot, token, { fileSystem, processId, identifier, currentUid }) {
  ensurePrivateDirectory(runtimeRoot, fileSystem, currentUid);
  const file = path.join(runtimeRoot, `connector-${processId}-${identifier()}.token`);
  let descriptor;
  try {
    descriptor = fileSystem.openSync(file, "wx", 0o600);
    fileSystem.writeFileSync(descriptor, token, "utf8");
    fileSystem.fsyncSync(descriptor);
    fileSystem.closeSync(descriptor);
    descriptor = undefined;
    fileSystem.chmodSync(file, 0o600);
    return file;
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fileSystem.closeSync(descriptor);
      } catch {}
    }
    try {
      fileSystem.unlinkSync(file);
    } catch {}
    throw error;
  }
}

function sanitizedConnectorEnvironment(environment) {
  const next = { ...environment };
  for (const name of [
    "TUNNEL_TOKEN",
    "TUNNEL_TOKEN_FILE",
    "CLOUDFLARED_TOKEN",
    "CF_TUNNEL_TOKEN",
  ]) {
    delete next[name];
  }
  return next;
}

async function waitForExit(child, milliseconds) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    child.once("exit", finish);
    const timer = setTimeout(finish, milliseconds);
    timer.unref?.();
  });
}

async function terminateChild(child, graceMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {}
  await waitForExit(child, graceMs);
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGKILL");
  } catch {}
  await waitForExit(child, Math.min(graceMs, 500));
}

async function verifyHostedEndpoint(
  endpoint,
  { fetchImpl, timeoutSignal, timeoutMs, cancellationSignal },
) {
  const requestSignal = timeoutSignal(timeoutMs);
  const response = await fetchImpl(`${endpoint}/api/health`, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: cancellationSignal
      ? AbortSignal.any([requestSignal, cancellationSignal])
      : requestSignal,
  });
  if (!response.ok) return false;
  const text = await response.text();
  if (Buffer.byteLength(text) > 4096) return false;
  try {
    return JSON.parse(text)?.app === "openmausbot";
  } catch {
    return false;
  }
}

/** A single-owner, restartable connector lifecycle. Its public state is
 * intentionally secret-free so it is safe for diagnostics or future UI. */
export function createManagedCompanionTunnel({
  binaryPath,
  runtimeRoot,
  environment = process.env,
  fileSystem = fs,
  spawnProcess = spawn,
  fetchImpl = globalThis.fetch,
  timeoutSignal = (milliseconds) => AbortSignal.timeout(milliseconds),
  identifier = randomUUID,
  processId = process.pid,
  currentUid = currentUserId(),
  isProcessAlive = processIsAlive,
  verifyTimeoutMs = 15_000,
  verifyRequestTimeoutMs = 2_500,
  verifyIntervalMs = 250,
  stopGraceMs = 1_500,
  maxRetryMs = 30_000,
  onChange = () => {},
  log = () => {},
} = {}) {
  let desired = false;
  let generation = 0;
  let intentRevision = 0;
  let child = null;
  let tokenFile = null;
  let activeAttempt = null;
  let access = null;
  let retryAttempt = 0;
  let retryTimer = null;
  let state = Object.freeze({ status: "stopped", ready: false, configured: false });
  let transition = Promise.resolve();

  cleanupStaleManagedCompanionTokens(runtimeRoot, {
    fileSystem,
    currentUid,
    isProcessAlive,
  });

  const publish = (next) => {
    const published = {
      configured: Boolean(access),
      ready: next.status === "ready",
      ...next,
    };
    if (access) published.endpoint = access.endpoint;
    state = Object.freeze(published);
    onChange(state);
    return state;
  };

  const removeTokenFile = (file = tokenFile) => {
    if (!file) return;
    if (tokenFile === file) tokenFile = null;
    try {
      fileSystem.unlinkSync(file);
    } catch (error) {
      if (error?.code !== "ENOENT") log("managed companion connector token cleanup failed");
    }
  };

  const serialize = (work) => {
    const next = transition.then(work, work);
    transition = next.then(
      () => {},
      () => {},
    );
    return next;
  };

  const scheduleRetry = (reason, ownedGeneration) => {
    if (!desired || ownedGeneration !== generation || retryTimer) return;
    const delay = Math.min(1_000 * 2 ** retryAttempt, maxRetryMs);
    retryAttempt += 1;
    publish({ status: "retrying", ready: false, error: reason, retryInMs: delay });
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!desired || ownedGeneration !== generation) return;
      void serialize(() => attempt(ownedGeneration));
    }, delay);
    retryTimer.unref?.();
  };

  const attempt = async (ownedGeneration) => {
    if (!desired || ownedGeneration !== generation || !access) return state;
    if (!binaryPath) {
      publish({
        status: "unavailable",
        ready: false,
        error: "The managed companion connector is missing from this build.",
      });
      return state;
    }

    publish({ status: "starting", ready: false });
    let attemptHandle = null;
    let attemptTokenFile = null;
    try {
      tokenFile = writePrivateToken(runtimeRoot, access.token, {
        fileSystem,
        processId,
        identifier,
        currentUid,
      });
      attemptTokenFile = tokenFile;
      const spawned = spawnProcess(
        binaryPath,
        [
          "tunnel",
          "--no-autoupdate",
          "--loglevel",
          "info",
          "--output",
          "json",
          "run",
          "--token-file",
          tokenFile,
        ],
        {
          env: sanitizedConnectorEnvironment(environment),
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "ignore", "ignore"],
        },
      );
      child = spawned;
      const cancellationController = new AbortController();
      let resolveCancellation;
      const cancellation = new Promise((resolve) => {
        resolveCancellation = resolve;
      });
      let cancelled = false;
      attemptHandle = {
        generation: ownedGeneration,
        cancel() {
          if (cancelled) return;
          cancelled = true;
          cancellationController.abort();
          resolveCancellation(false);
        },
      };
      activeAttempt = attemptHandle;
      let terminated = false;
      let expectedStop = false;
      let resolveExit;
      const exit = new Promise((resolve) => {
        resolveExit = resolve;
      });
      const onTerminated = () => {
        if (terminated) return;
        terminated = true;
        resolveExit();
        if (child === spawned) child = null;
        removeTokenFile(attemptTokenFile);
        if (!expectedStop && desired && ownedGeneration === generation) {
          scheduleRetry("The secure connection stopped unexpectedly.", ownedGeneration);
        }
      };
      spawned.once("exit", onTerminated);
      // A child that fails before spawn emits `error` and then `close`, but
      // not necessarily `exit`. Treat either as terminal so verification
      // cannot sit out its whole deadline for a process that never existed.
      spawned.once("error", onTerminated);

      const deadline = Date.now() + verifyTimeoutMs;
      while (desired && ownedGeneration === generation && child === spawned && !terminated) {
        const verified = await Promise.race([
          verifyHostedEndpoint(access.endpoint, {
            fetchImpl,
            timeoutSignal,
            timeoutMs: verifyRequestTimeoutMs,
            cancellationSignal: cancellationController.signal,
          }).catch(() => false),
          exit.then(() => false),
          cancellation,
        ]);
        if (verified && child === spawned && desired && ownedGeneration === generation) {
          removeTokenFile(attemptTokenFile);
          retryAttempt = 0;
          publish({ status: "ready", ready: true });
          return state;
        }
        if (Date.now() >= deadline) break;
        await Promise.race([
          new Promise((resolve) => {
            const timer = setTimeout(resolve, verifyIntervalMs);
            timer.unref?.();
          }),
          exit,
          cancellation,
        ]);
      }

      if (child === spawned) {
        // Invalidate this exit before asking the child to stop, otherwise its
        // handler and this failed attempt both schedule a retry.
        expectedStop = true;
        child = null;
        await terminateChild(spawned, stopGraceMs);
      }
      removeTokenFile(attemptTokenFile);
      if (desired && ownedGeneration === generation) {
        scheduleRetry("The secure connection could not be verified.", ownedGeneration);
      }
      return state;
    } catch {
      const spawned = child;
      child = null;
      removeTokenFile(attemptTokenFile);
      if (spawned) await terminateChild(spawned, stopGraceMs);
      if (desired && ownedGeneration === generation) {
        scheduleRetry("The secure connection could not start.", ownedGeneration);
      }
      return state;
    } finally {
      if (activeAttempt === attemptHandle) activeAttempt = null;
    }
  };

  return Object.freeze({
    getStatus() {
      return state;
    },

    start(rawAccess) {
      const requestedRevision = ++intentRevision;
      return serialize(async () => {
        // A stop requested before this queued start began wins. This matters
        // during app shutdown, when start and quit can land in one event-loop
        // turn before either transition has acquired the queue.
        if (requestedRevision !== intentRevision) return state;
        const normalized = managedCompanionTunnelAccess({
          [MANAGED_COMPANION_ENDPOINT_FIELD]: rawAccess?.endpoint,
          [MANAGED_COMPANION_TOKEN_FIELD]: rawAccess?.token,
        });
        if (
          desired &&
          normalized &&
          access?.endpoint === normalized.endpoint &&
          access?.token === normalized.token &&
          child
        ) {
          return state;
        }
        generation += 1;
        desired = Boolean(normalized);
        access = normalized;
        retryAttempt = 0;
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = null;
        const existing = child;
        child = null;
        if (existing) await terminateChild(existing, stopGraceMs);
        removeTokenFile();
        if (!access) {
          return publish({
            status: "unconfigured",
            ready: false,
            error: "Sign in to enable a secure connection from any network.",
          });
        }
        return attempt(generation);
      });
    },

    stop() {
      // Stop intent must not wait behind a 15-second startup probe. Invalidate
      // the attempt, wake its verification race, and signal cloudflared now;
      // the serialized tail only publishes the final stable state.
      const requestedRevision = ++intentRevision;
      desired = false;
      generation += 1;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      activeAttempt?.cancel();
      const existing = child;
      child = null;
      const existingTokenFile = tokenFile;
      removeTokenFile(existingTokenFile);
      const terminated = existing
        ? terminateChild(existing, stopGraceMs)
        : Promise.resolve();

      return serialize(async () => {
        await terminated;
        if (requestedRevision !== intentRevision) return state;
        return publish({ status: "stopped", ready: false });
      });
    },

    shutdown() {
      return this.stop();
    },
  });
}
