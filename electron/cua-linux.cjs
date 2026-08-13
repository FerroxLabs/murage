const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CERTIFIED_DRIVER_VERSION = "0.19.3";
const CERTIFIED_MANIFEST_SCHEMA = "1";
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024;

const SESSION_ENV_KEYS = new Set([
  "AT_SPI_BUS",
  "DBUS_SESSION_BUS_ADDRESS",
  "DISPLAY",
  "HOME",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "PATH",
  "USER",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_CURRENT_DESKTOP",
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_DESKTOP",
  "XDG_SESSION_TYPE",
]);

function unavailable(reasonCode, message, details = {}) {
  return { status: "unavailable", reasonCode, message, ...details };
}

function sanitizePath(value) {
  const seen = new Set();
  const entries = [];
  for (const entry of String(value ?? "").split(path.delimiter)) {
    if (!entry || !path.isAbsolute(entry)) continue;
    const normalized = path.normalize(entry);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    entries.push(normalized);
  }
  return entries.join(path.delimiter);
}

function desktopCommandEnvironment(source = process.env, additions = {}) {
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (value == null) continue;
    if (SESSION_ENV_KEYS.has(key) || key.startsWith("LC_")) env[key] = String(value);
  }
  env.PATH = sanitizePath(source.PATH);
  // Keep the finite probes deterministic and avoid an unrelated network check.
  // This affects only children owned by OpenMausBot and does not change the
  // user's persisted Cua preferences.
  env.CUA_DRIVER_RS_UPDATE_CHECK = "false";
  for (const [key, value] of Object.entries(additions)) {
    if (value != null) env[key] = String(value);
  }
  return env;
}

function commandFailure(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function runCuaCommand(binary, args, {
  env = desktopCommandEnvironment(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
} = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let overflowed = false;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    const child = spawn(binary, args, {
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const stop = () => {
      try {
        child.kill("SIGKILL");
      } catch {}
    };
    const collect = (current, chunk) => {
      const next = Buffer.concat([current, chunk]);
      if (stdout.length + stderr.length + chunk.length > maxOutputBytes) {
        overflowed = true;
        stop();
      }
      return next.subarray(0, maxOutputBytes);
    };

    child.stdout?.on("data", (chunk) => {
      stdout = collect(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = collect(stderr, chunk);
    });
    child.once("error", (error) =>
      finish(reject, commandFailure("spawn-failed", `Could not start Cua Driver: ${error.message}`)),
    );
    child.once("close", (exitCode, signal) => {
      if (timedOut) {
        finish(
          reject,
          commandFailure("command-timeout", "Cua Driver did not respond in time.", { timeoutMs }),
        );
        return;
      }
      if (overflowed) {
        finish(
          reject,
          commandFailure("output-too-large", "Cua Driver returned too much diagnostic output."),
        );
        return;
      }
      resolve({
        exitCode,
        signal,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
      });
      settled = true;
      clearTimeout(timer);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    timer.unref?.();
  });
}

function pathComponents(target) {
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  const relative = resolved.slice(root.length).split(path.sep).filter(Boolean);
  const components = [root];
  let current = root;
  for (const part of relative) {
    current = path.join(current, part);
    components.push(current);
  }
  return components;
}

function safeOwner(stat, currentUid) {
  return stat.uid === currentUid || stat.uid === 0;
}

function validatePathComponents(target, currentUid) {
  for (const component of pathComponents(path.dirname(target))) {
    const stat = fs.lstatSync(component);
    if (!safeOwner(stat, currentUid)) {
      return unavailable(
        "unsafe-driver-owner",
        `Cua Driver path component is owned by an unexpected user: ${component}`,
      );
    }
    const rootOwnedStickyDirectory = stat.isDirectory() && stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if ((stat.mode & 0o022) !== 0 && !rootOwnedStickyDirectory) {
      return unavailable(
        "unsafe-driver-permissions",
        `Cua Driver path component is group- or world-writable: ${component}`,
      );
    }
  }
  return null;
}

function validateDriverCandidate(candidate, { currentUid = process.getuid?.() ?? os.userInfo().uid } = {}) {
  if (!path.isAbsolute(candidate)) {
    return unavailable("driver-path-not-absolute", "Cua Driver path must be absolute.", {
      candidate,
    });
  }

  let linkStat;
  let canonicalPath;
  let targetStat;
  try {
    linkStat = fs.lstatSync(candidate);
    canonicalPath = fs.realpathSync(candidate);
    targetStat = fs.statSync(canonicalPath);
  } catch (error) {
    return unavailable("driver-not-found", `Cua Driver was not found at ${candidate}.`, {
      candidate,
      cause: error?.code,
    });
  }

  if (!safeOwner(linkStat, currentUid) || !safeOwner(targetStat, currentUid)) {
    return unavailable(
      "unsafe-driver-owner",
      "Cua Driver must be owned by the current user or root.",
      { candidate, canonicalPath },
    );
  }
  if (!targetStat.isFile()) {
    return unavailable("driver-not-file", "Cua Driver must resolve to a regular file.", {
      candidate,
      canonicalPath,
    });
  }
  if ((targetStat.mode & 0o111) === 0) {
    return unavailable("driver-not-executable", "Cua Driver is not executable.", {
      candidate,
      canonicalPath,
    });
  }
  if ((targetStat.mode & 0o022) !== 0) {
    return unavailable(
      "unsafe-driver-permissions",
      "Cua Driver must not be group- or world-writable.",
      { candidate, canonicalPath },
    );
  }

  try {
    const lexicalError = validatePathComponents(candidate, currentUid);
    if (lexicalError) return { ...lexicalError, candidate, canonicalPath };
    const canonicalError = validatePathComponents(canonicalPath, currentUid);
    if (canonicalError) return { ...canonicalError, candidate, canonicalPath };
    fs.accessSync(canonicalPath, fs.constants.X_OK);
  } catch (error) {
    return unavailable("driver-not-executable", "Cua Driver cannot be executed.", {
      candidate,
      canonicalPath,
      cause: error?.code,
    });
  }

  return { status: "found", path: canonicalPath };
}

function discoverLinuxCuaDriver({ env = process.env, homeDir = os.homedir(), currentUid } = {}) {
  const explicit = env.CUA_DRIVER_PATH;
  if (explicit) {
    const result = validateDriverCandidate(explicit, { currentUid });
    return result.status === "found" ? { ...result, source: "environment" } : result;
  }

  const localCandidate = path.join(homeDir, ".local", "bin", "cua-driver");
  if (fs.existsSync(localCandidate)) {
    const result = validateDriverCandidate(localCandidate, { currentUid });
    if (result.status === "found") return { ...result, source: "user-local" };
    return result;
  }

  let firstUnsafe = null;
  for (const directory of sanitizePath(env.PATH).split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, "cua-driver");
    if (!fs.existsSync(candidate)) continue;
    const result = validateDriverCandidate(candidate, { currentUid });
    if (result.status === "found") return { ...result, source: "path" };
    firstUnsafe ??= result;
  }
  return (
    firstUnsafe ??
    unavailable(
      "driver-not-found",
      "Cua Driver was not found. Install it, then try again.",
    )
  );
}

function parseJsonObject(value, label) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw commandFailure("invalid-json", `${label} returned invalid JSON.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw commandFailure("invalid-json", `${label} returned an invalid JSON object.`);
  }
  return parsed;
}

function parseVersion(stdout) {
  const match = String(stdout).trim().match(/(?:cua-driver\s+)?(\d+\.\d+\.\d+)/i);
  return match?.[1] ?? null;
}

function validateManifest(manifest, binaryPath) {
  if (manifest.schema_version !== CERTIFIED_MANIFEST_SCHEMA) {
    throw commandFailure(
      "unsupported-manifest",
      `Cua Driver manifest schema ${String(manifest.schema_version)} is not supported.`,
    );
  }
  if (manifest.binary_version !== CERTIFIED_DRIVER_VERSION) {
    throw commandFailure(
      "unsupported-driver-version",
      `Cua Driver ${String(manifest.binary_version)} is not supported; install ${CERTIFIED_DRIVER_VERSION}.`,
    );
  }
  const invocation = manifest.mcp_invocation;
  if (
    !invocation ||
    typeof invocation.command !== "string" ||
    !Array.isArray(invocation.args) ||
    invocation.args.length !== 1 ||
    invocation.args[0] !== "mcp"
  ) {
    throw commandFailure("unsupported-manifest", "Cua Driver returned an unsupported MCP contract.");
  }
  let invocationPath;
  try {
    invocationPath = fs.realpathSync(invocation.command);
  } catch {
    throw commandFailure("unsupported-manifest", "Cua Driver MCP command could not be verified.");
  }
  if (invocationPath !== binaryPath) {
    throw commandFailure("unsupported-manifest", "Cua Driver MCP command does not match the verified binary.");
  }
  return { command: binaryPath, args: ["mcp"] };
}

function validateDoctor(report) {
  if (typeof report.ok !== "boolean" || !Array.isArray(report.probes)) {
    throw commandFailure("invalid-doctor-report", "Cua Driver returned an invalid doctor report.");
  }
  const probes = report.probes.map((probe) => {
    if (
      !probe ||
      typeof probe.label !== "string" ||
      !["ok", "warn", "err"].includes(probe.status) ||
      typeof probe.message !== "string"
    ) {
      throw commandFailure("invalid-doctor-report", "Cua Driver returned an invalid doctor probe.");
    }
    return {
      label: probe.label,
      status: probe.status,
      message: probe.message,
      ...(typeof probe.detail === "string" ? { detail: probe.detail } : {}),
    };
  });
  const byLabel = new Map(probes.map((probe) => [probe.label, probe]));
  const display = byLabel.get("display server");
  const x11 = byLabel.get("X11 connection");
  const atSpi = byLabel.get("AT-SPI");
  if (!report.ok || probes.some((probe) => probe.status === "err")) {
    throw commandFailure("doctor-failed", "Cua Driver diagnostics reported an error.", { probes });
  }
  if (display?.status !== "ok" || !display.message.startsWith("X11 ")) {
    throw commandFailure("x11-unavailable", "Cua Driver did not confirm an Xorg display.", { probes });
  }
  if (!x11 || x11.status === "err") {
    throw commandFailure("x11-unavailable", "Cua Driver could not verify the Xorg session.", { probes });
  }
  if (atSpi?.status !== "ok") {
    throw commandFailure("at-spi-unavailable", "Cua Driver could not reach the AT-SPI accessibility bus.", {
      probes,
    });
  }
  return { ok: true, probes, warnings: probes.filter((probe) => probe.status === "warn") };
}

async function inspectLinuxCuaDriver({
  platform = process.platform,
  env = process.env,
  homeDir = os.homedir(),
  currentUid,
  run = runCuaCommand,
} = {}) {
  const session = String(env.XDG_SESSION_TYPE ?? "").toLowerCase();
  if (platform !== "linux") {
    return unavailable("unsupported-platform", "Linux local control is only available on Ubuntu.");
  }
  if (session !== "x11" && session !== "xorg") {
    return unavailable(
      session === "wayland" ? "wayland-unsupported" : "x11-required",
      session === "wayland"
        ? "Local control is not available in a Wayland session. Sign in with GNOME on Xorg."
        : "Local control requires an interactive GNOME on Xorg session.",
    );
  }
  if (!env.DISPLAY) {
    return unavailable("display-unavailable", "Local control requires an active Xorg display.");
  }

  const discovered = discoverLinuxCuaDriver({ env, homeDir, currentUid });
  if (discovered.status !== "found") return discovered;
  const commandEnv = desktopCommandEnvironment(env);

  try {
    const versionResult = await run(discovered.path, ["--version"], { env: commandEnv });
    const driverVersion = parseVersion(versionResult.stdout || versionResult.stderr);
    if (versionResult.exitCode !== 0 || driverVersion !== CERTIFIED_DRIVER_VERSION) {
      return unavailable(
        "unsupported-driver-version",
        `Cua Driver ${driverVersion ?? "unknown"} is not supported; install ${CERTIFIED_DRIVER_VERSION}.`,
        { path: discovered.path, source: discovered.source, driverVersion },
      );
    }

    const manifestResult = await run(discovered.path, ["manifest"], { env: commandEnv });
    if (manifestResult.exitCode !== 0) {
      return unavailable("manifest-failed", "Cua Driver manifest validation failed.", {
        path: discovered.path,
        source: discovered.source,
      });
    }
    const manifest = parseJsonObject(manifestResult.stdout, "Cua Driver manifest");
    const mcp = validateManifest(manifest, discovered.path);

    const doctorResult = await run(discovered.path, ["doctor", "--json"], { env: commandEnv });
    const doctorReport = parseJsonObject(doctorResult.stdout, "Cua Driver doctor");
    if (doctorResult.exitCode !== 0 && doctorReport.ok !== false) {
      return unavailable("doctor-failed", "Cua Driver diagnostics failed.", {
        path: discovered.path,
        source: discovered.source,
      });
    }
    const doctor = validateDoctor(doctorReport);

    return {
      status: "ready",
      path: discovered.path,
      source: discovered.source,
      driverVersion,
      manifestSchema: manifest.schema_version,
      mcp,
      doctor,
      commandEnv,
    };
  } catch (error) {
    return unavailable(error?.code ?? "diagnostics-failed", error?.message ?? String(error), {
      path: discovered.path,
      source: discovered.source,
      ...(error?.probes ? { probes: error.probes } : {}),
    });
  }
}

module.exports = {
  CERTIFIED_DRIVER_VERSION,
  CERTIFIED_MANIFEST_SCHEMA,
  desktopCommandEnvironment,
  discoverLinuxCuaDriver,
  inspectLinuxCuaDriver,
  parseVersion,
  runCuaCommand,
  sanitizePath,
  validateDoctor,
  validateDriverCandidate,
  validateManifest,
};
