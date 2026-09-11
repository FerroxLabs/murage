/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unattended (non-interactive) input for `murage`.
 *
 * The interactive installer asks questions. A provisioning run has nobody at
 * the keyboard, so every one of those questions needs an equivalent input that
 * can be supplied ahead of time — and the run has to FAIL, loudly and early,
 * when one of them was not supplied, rather than block on a prompt nobody will
 * ever answer.
 *
 * Two rules shape everything here:
 *
 *  1. **Secrets never go on argv.** `ps` shows every argument of every process
 *     on the box to every user on it, and shell history keeps them. So there is
 *     no `--tailscale-auth-key <key>` and no `--provider-key <key>`; there is a
 *     `--…-file <path>`, a `--…-stdin`, and the environment variables the
 *     installer already read. A flag that looks like it carries a secret value
 *     is refused by name, so a provisioning script that tries it is corrected
 *     instead of silently leaking.
 *  2. **Every missing input is reported at once.** A preflight that names one
 *     missing answer per run costs a provisioning round trip per question.
 *     `resolveUnattendedPlan` collects them all and the caller prints the list.
 *
 * This module is pure apart from the readers injected into it, so the whole
 * matrix is testable without a tailnet, a systemd, or a terminal.
 */

import { NotPlainFile, readRegularFile } from "./private-files.mjs";

/** Documented exit codes. `murage help` prints these, and so does the README. */
export const EXIT = Object.freeze({
  /** Finished, and the box is on the tailnet. */
  OK: 0,
  /** The environment cannot run this: no server payload, an unusable runtime,
   * a Tailscale install that failed. Nothing about the request was wrong. */
  ENVIRONMENT: 1,
  /** The request was wrong or incomplete: a bad flag, a missing unattended
   * input, an env file that could not be carried over. Nothing was changed. */
  USAGE: 2,
  /** Setup completed, but the box is NOT on the tailnet (see SETUP_NOT_SECURED). */
  NOT_SECURED: 3,
});

/** Provider env names Murage's own config recognises (server/config.ts). */
export const PROVIDER_ENV = Object.freeze({
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  xai: "XAI_API_KEY",
});

/**
 * Which provider env name a key belongs to, by prefix, or null when the shape
 * is not one we recognise. The order matters: `sk-ant-` before the broader
 * `sk-`.
 * @param {string} key
 * @returns {string | null}
 */
export function inferProviderEnvName(key) {
  if (/^sk-ant-/i.test(key)) return PROVIDER_ENV.anthropic;
  if (/^AIza/.test(key)) return PROVIDER_ENV.gemini;
  if (/^xai-/i.test(key)) return PROVIDER_ENV.xai;
  if (/^sk-/i.test(key)) return PROVIDER_ENV.openai;
  return null;
}

const TRUTHY = new Set(["1", "true", "yes", "y", "on"]);
const FALSY = new Set(["0", "false", "no", "n", "off"]);

/**
 * Read a tri-state boolean from the environment: true, false, or "not set".
 * An unreadable spelling is an error, not a silent false — `MURAGE_STAGE_SYSTEMD=please`
 * meaning "no" is exactly the kind of quiet wrong answer provisioning cannot see.
 * @param {string} name
 * @param {string | undefined} raw
 * @returns {{ value?: boolean, error?: string }}
 */
export function boolFromEnv(name, raw) {
  if (raw === undefined || String(raw).trim() === "") return {};
  const value = String(raw).trim().toLowerCase();
  if (TRUTHY.has(value)) return { value: true };
  if (FALSY.has(value)) return { value: false };
  return { error: `${name} must be one of 1/0, true/false, yes/no, on/off (it is not shown here, in case it is a secret)` };
}

/** Flags that would put a secret in `ps`. Refused by name, with the way to do it instead. */
const SECRET_ON_ARGV = new Map([
  ["--tailscale-auth-key", "--tailscale-auth-key-file <path> (or --tailscale-auth-key-stdin, or MURAGE_TS_AUTHKEY)"],
  ["--auth-key", "--tailscale-auth-key-file <path> (or --tailscale-auth-key-stdin, or MURAGE_TS_AUTHKEY)"],
  ["--authkey", "--tailscale-auth-key-file <path> (or --tailscale-auth-key-stdin, or MURAGE_TS_AUTHKEY)"],
  ["--ts-authkey", "--tailscale-auth-key-file <path> (or --tailscale-auth-key-stdin, or MURAGE_TS_AUTHKEY)"],
  ["--provider-key", "--provider-key-file <path> (or --provider-key-stdin, or MURAGE_PROVIDER_KEY_FILE)"],
  ["--api-key", "--provider-key-file <path> (or --provider-key-stdin, or MURAGE_PROVIDER_KEY_FILE)"],
]);

/** Options that take a value. */
const VALUE_FLAGS = new Set([
  "--tailscale-auth-key-file",
  "--provider-key-file",
  "--provider",
  "--tailnet-tag",
  "--tailnet-hostname",
]);

/** Options that are a bare switch, mapped to `[field, value]`. */
const SWITCH_FLAGS = new Map([
  ["--non-interactive", ["nonInteractive", true]],
  ["--yes", ["nonInteractive", true]],
  ["-y", ["nonInteractive", true]],
  ["--tailscale-auth-key-stdin", ["authKeyStdin", true]],
  ["--provider-key-stdin", ["providerKeyStdin", true]],
  ["--no-provider-key", ["skipProviderKey", true]],
  ["--no-tailscale", ["wantTailscale", false]],
  ["--install-tailscale", ["installTailscale", true]],
  ["--no-install-tailscale", ["installTailscale", false]],
  ["--reenroll", ["reenroll", true]],
  ["--no-reenroll", ["reenroll", false]],
  ["--https", ["https", true]],
  ["--no-https", ["https", false]],
  ["--systemd", ["systemd", true]],
  ["--no-systemd", ["systemd", false]],
]);

/**
 * Pull the unattended options out of an argv, leaving everything else for the
 * caller's own parser (`parseSetupArgs`, which owns `--service-user` and the
 * "not shown, in case it is a secret" refusal of stray arguments).
 *
 * @param {string[]} argv
 * @returns {{ error: string } | { options: Record<string, any>, rest: string[] }}
 */
export function splitUnattendedArgs(argv = []) {
  /** @type {Record<string, any>} */
  const options = {};
  /** @type {string[]} */
  const rest = [];
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i]);
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);

    const instead = SECRET_ON_ARGV.get(name);
    if (instead) {
      return {
        error:
          `${name} is refused: a secret passed as a command-line argument is visible to every user on this box ` +
          `via \`ps\`, and is kept in shell history. Use ${instead} instead. ` +
          "(The value you passed is not shown here.)",
      };
    }

    const flip = SWITCH_FLAGS.get(name);
    if (flip) {
      if (eq !== -1) return { error: `${name} does not take a value` };
      const [field, value] = flip;
      // `--https --no-https` is a provisioning script contradicting itself.
      if (seen.has(field) && options[field] !== value) {
        return { error: `${name} contradicts an earlier option for the same choice; pass it once` };
      }
      seen.add(field);
      options[field] = value;
      continue;
    }

    if (VALUE_FLAGS.has(name)) {
      let value;
      if (eq !== -1) value = arg.slice(eq + 1);
      else {
        value = argv[i + 1];
        if (value === undefined || String(value).startsWith("-")) return { error: `${name} needs a value` };
        i += 1;
      }
      value = String(value).trim();
      if (!value) return { error: `${name} needs a value` };
      const field = {
        "--tailscale-auth-key-file": "authKeyFile",
        "--provider-key-file": "providerKeyFile",
        "--provider": "provider",
        "--tailnet-tag": "tag",
        "--tailnet-hostname": "hostname",
      }[name];
      if (seen.has(field) && options[field] !== value) return { error: `${name} was given twice with different values` };
      seen.add(field);
      options[field] = value;
      continue;
    }

    rest.push(arg);
  }
  return { options, rest };
}

/**
 * Is this run unattended? The flag wins; otherwise the environment.
 * @param {Record<string, any>} options from `splitUnattendedArgs`
 * @param {Record<string, string | undefined>} env
 * @returns {{ nonInteractive: boolean, error?: string }}
 */
export function isUnattended(options, env) {
  if (options.nonInteractive) return { nonInteractive: true };
  const fromEnv = boolFromEnv("MURAGE_NON_INTERACTIVE", env.MURAGE_NON_INTERACTIVE);
  if (fromEnv.error) return { nonInteractive: false, error: fromEnv.error };
  return { nonInteractive: fromEnv.value === true };
}

/**
 * Read a secret out of a file, without following a final symlink and without
 * ever putting the bytes anywhere but the return value.
 * @param {string} path
 * @param {typeof readRegularFile} [read]
 * @returns {{ value: string, warning?: string } | { error: string }}
 */
export function readSecretFile(path, read = readRegularFile) {
  let file;
  try {
    file = read(path);
  } catch (error) {
    if (error instanceof NotPlainFile) return { error: `${path}: ${error.message}` };
    const code = /** @type {NodeJS.ErrnoException} */ (error)?.code;
    if (code === "EACCES" || code === "EPERM") return { error: `${path} cannot be read by this user (${code})` };
    return { error: `${path} could not be read: ${/** @type {Error} */ (error).message}` };
  }
  if (!file) return { error: `${path} does not exist` };
  // A secret's first line, so a trailing newline from `echo` or a heredoc is
  // not part of the key, and a file with a comment under it still works.
  const value = String(file.bytes.toString("utf8")).split(/\r?\n/, 1)[0].trim();
  if (!value) return { error: `${path} is empty — it should hold the secret on its first line` };
  const warning =
    (file.mode & 0o077) !== 0
      ? `${path} is mode 0${file.mode.toString(8)}: other accounts on this box can read the secret in it. chmod 600 it.`
      : undefined;
  return { value, warning };
}

/**
 * Resolve every unattended answer, or list everything that is missing.
 *
 * Pure but for the two readers, and given the facts rather than discovering
 * them, so a provisioning matrix is testable without a tailnet.
 *
 * @param {object} input
 * @param {Record<string, any>} input.options from `splitUnattendedArgs`
 * @param {Record<string, string | undefined>} input.env
 * @param {string[]} input.storedProviderKeys provider env names already in the env file
 * @param {{ installed: boolean, enrolled: boolean }} input.tailscale what is true right now
 * @param {(path: string) => { value: string, warning?: string } | { error: string }} [input.readFile]
 * @param {() => Promise<string>} [input.readStdin] consumes all of stdin, once
 * @returns {Promise<{ ok: true, plan: object, warnings: string[] } | { ok: false, problems: string[] }>}
 */
export async function resolveUnattendedPlan({
  options = {},
  env = {},
  storedProviderKeys = [],
  tailscale = { installed: false, enrolled: false },
  readFile = (path) => readSecretFile(path),
  readStdin,
}) {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const warnings = [];

  /** Read a tri-state from flag, then env, then the interactive default. */
  const choose = (flagValue, envName, dflt) => {
    if (flagValue !== undefined) return flagValue;
    const fromEnv = boolFromEnv(envName, env[envName]);
    if (fromEnv.error) {
      problems.push(fromEnv.error);
      return dflt;
    }
    return fromEnv.value === undefined ? dflt : fromEnv.value;
  };

  // Defaults are the interactive defaults, so `--non-interactive` on its own
  // answers every question the same way a human pressing Enter would.
  const wantTailscale = choose(options.wantTailscale, "MURAGE_WANT_TAILSCALE", true);
  const installTailscale = choose(options.installTailscale, "MURAGE_INSTALL_TAILSCALE", true);
  const reenroll = choose(options.reenroll, "MURAGE_TAILSCALE_REENROLL", false);
  const https = choose(options.https, "MURAGE_TAILNET_HTTPS", true);
  const systemd = choose(options.systemd, "MURAGE_STAGE_SYSTEMD", false);
  const skipProviderKey = choose(options.skipProviderKey, "MURAGE_SKIP_PROVIDER_KEY", false);

  const tag = (options.tag ?? env.MURAGE_TAILNET_TAG ?? "").trim() || null;
  const hostname = (options.hostname ?? env.MURAGE_TAILNET_HOSTNAME ?? "").trim() || null;

  // stdin is one stream; two secrets cannot both have it.
  if (options.authKeyStdin && options.providerKeyStdin) {
    problems.push(
      "--tailscale-auth-key-stdin and --provider-key-stdin cannot both be used: stdin is one stream. " +
        "Put one of the two secrets in a file and pass its path."
    );
  }

  /** @type {string | null} */
  let stdinSecret = null;
  let stdinRead = false;
  const takeStdin = async (label) => {
    if (stdinRead) return stdinSecret;
    stdinRead = true;
    if (!readStdin) {
      problems.push(`${label} was asked for on stdin, but this run has no stdin to read`);
      return null;
    }
    let text;
    try {
      text = await readStdin();
    } catch (error) {
      problems.push(`${label} could not be read from stdin: ${/** @type {Error} */ (error).message}`);
      return null;
    }
    stdinSecret = String(text).split(/\r?\n/, 1)[0].trim() || null;
    if (!stdinSecret) problems.push(`${label} was asked for on stdin, but stdin was empty`);
    return stdinSecret;
  };

  /**
   * Resolve one secret: flag file → env file path → env value → stdin.
   *
   * `attempted` is the difference between "you did not tell me where the key
   * is" and "the place you told me about could not be read" — the second has
   * already been reported precisely, and repeating it as a missing input would
   * send the operator looking for a flag they did in fact pass.
   */
  const secret = async ({ label, filePath, envFileName, envValueNames = [], useStdin }) => {
    const path = filePath ?? (envFileName ? env[envFileName]?.trim() : undefined);
    if (path) {
      const read = readFile(path);
      if ("error" in read) {
        problems.push(`${label}: ${read.error}`);
        return { value: null, source: null, attempted: true };
      }
      if (read.warning) warnings.push(read.warning);
      return { value: read.value, source: path, attempted: true };
    }
    for (const name of envValueNames) {
      const value = env[name]?.trim();
      if (value) return { value, source: `$${name}`, attempted: true };
    }
    if (useStdin) {
      const value = await takeStdin(label);
      return { value, source: value ? "stdin" : null, attempted: true };
    }
    return { value: null, source: null, attempted: false };
  };

  const auth = await secret({
    label: "the Tailscale auth key",
    filePath: options.authKeyFile,
    envFileName: "MURAGE_TAILSCALE_AUTHKEY_FILE",
    envValueNames: ["MURAGE_TS_AUTHKEY", "TS_AUTHKEY", "TAILSCALE_AUTHKEY"],
    useStdin: options.authKeyStdin === true,
  });

  const provider = await secret({
    label: "the provider API key",
    filePath: options.providerKeyFile,
    envFileName: "MURAGE_PROVIDER_KEY_FILE",
    envValueNames: [],
    useStdin: options.providerKeyStdin === true,
  });

  // ── what is missing ────────────────────────────────────────────────────
  if (wantTailscale) {
    if (!tailscale.installed && !installTailscale) {
      problems.push(
        "Tailscale is not installed on this box and --no-install-tailscale was given. " +
          "Pass --install-tailscale to let setup install it, or --no-tailscale to deploy without a tailnet " +
          "(which exits 3: the box is then reachable only through an SSH tunnel)."
      );
    }
    // An enrolled node that is not being re-enrolled needs no key: that is what
    // makes a rerun of setup idempotent on a box that is already on the tailnet.
    const needsKey = !tailscale.enrolled || reenroll;
    if (needsKey && !auth.value && !auth.attempted) {
      problems.push(
        "a Tailscale auth key: --tailscale-auth-key-file <path>, --tailscale-auth-key-stdin, " +
          "MURAGE_TAILSCALE_AUTHKEY_FILE=<path>, or MURAGE_TS_AUTHKEY. " +
          "(Never as a command-line argument: `ps` would show it.)"
      );
    }
  }

  /** @type {string | null} */
  let providerEnvName = null;
  if (provider.value) {
    const named = (options.provider ?? env.MURAGE_PROVIDER ?? "").trim().toLowerCase();
    if (named) {
      providerEnvName = PROVIDER_ENV[/** @type {keyof typeof PROVIDER_ENV} */ (named)] ?? null;
      if (!providerEnvName) {
        problems.push(`--provider ${named} is not one of: ${Object.keys(PROVIDER_ENV).join(", ")}`);
      }
    } else {
      providerEnvName = inferProviderEnvName(provider.value);
      if (!providerEnvName) {
        problems.push(
          `--provider (or MURAGE_PROVIDER): the key read from ${provider.source} does not start with a prefix this ` +
            `installer recognises, so it cannot tell which provider it is for. Name one of: ${Object.keys(PROVIDER_ENV).join(", ")}.`
        );
      }
    }
  } else if (!provider.attempted && !skipProviderKey && storedProviderKeys.length === 0) {
    problems.push(
      "a provider API key: --provider-key-file <path>, --provider-key-stdin, or MURAGE_PROVIDER_KEY_FILE=<path>. " +
        "Pass --no-provider-key to deploy without one (the server then has no model to call until one is added)."
    );
  }

  if (problems.length) return { ok: false, problems };

  return {
    ok: true,
    warnings,
    plan: {
      nonInteractive: true,
      wantTailscale,
      installTailscale,
      reenroll,
      https,
      systemd,
      authKey: auth.value,
      authKeySource: auth.source,
      tag,
      hostname,
      providerKey: provider.value,
      providerEnvName,
      providerKeySource: provider.source,
    },
  };
}

/**
 * Read all of stdin as text. Refuses a terminal: `--…-stdin` with nobody
 * piping anything in would block forever, which is the exact failure mode
 * unattended mode exists to remove.
 * @param {NodeJS.ReadStream} [stdin]
 * @returns {Promise<string>}
 */
export async function readAllStdin(stdin = process.stdin) {
  if (stdin.isTTY) throw new Error("stdin is a terminal; pipe the secret in, or use the --…-file form");
  /** @type {Buffer[]} */
  const chunks = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
