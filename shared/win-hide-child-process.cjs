// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Packaged CommonJS preload: Node runs --require before --import. Keep this
// file outside app.asar too, so ordinary Node descendants can require it.
const childProcess = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');

const preloadFile = __filename.replace(/([\\/])app\.asar([\\/])/, '$1');
const flag = '--require=' + preloadFile;
const envFlag = '--require=' + JSON.stringify(preloadFile);
const samePreload = value => value.replaceAll('\\', '/').toLowerCase() === preloadFile.replaceAll('\\', '/').toLowerCase();
// Keep the original spelling of unrelated flags, including quoted values.
function optionTokens(value) {
  return String(value).match(/(?:[^\s"]|"(?:\\.|[^"\\])*")+/g) ?? [];
}
function decodeToken(token) {
  return token.replace(/"(?:\\.|[^"\\])*"/g, quoted => {
    try { return JSON.parse(quoted); } catch { return quoted.slice(1, -1); }
  });
}
function withoutPreload(tokens, decode = value => value) {
  const rest = [];
  for (let i = 0; i < tokens.length; i++) {
    const value = decode(tokens[i]);
    if ((value === '--require' || value === '-r') && i + 1 < tokens.length && samePreload(decode(tokens[i + 1]))) { i++; continue; }
    if ((value.startsWith('--require=') && samePreload(value.slice(10))) || (value.startsWith('-r=') && samePreload(value.slice(3)))) continue;
    rest.push(tokens[i]);
  }
  return rest;
}
function normalizeNodeOptions(value) {
  const rest = withoutPreload(optionTokens(value || ''), decodeToken).join(' ');
  return envFlag + (rest ? ' ' + rest : '');
}
function stripNodeOptionsExceptHide(value, platform = process.platform) {
  const tokens = optionTokens(value || '');
  return platform === 'win32' && withoutPreload(tokens, decodeToken).length !== tokens.length ? envFlag : '';
}
function normalizeChildEnv(options) {
  const pairs = options.envPairs ?? [];
  const nodeOptions = pairs.filter(pair => /^NODE_OPTIONS=/i.test(pair)).map(pair => pair.slice(pair.indexOf('=') + 1)).join(' ');
  options.envPairs = [...pairs.filter(pair => !/^NODE_OPTIONS=/i.test(pair)), 'NODE_OPTIONS=' + normalizeNodeOptions(nodeOptions)];
  // fork has already assembled executable + execArgv + module + user args.
  // Repair only its execArgv prefix; never reinterpret module/user arguments.
  if (options.execPath === options.file && Array.isArray(options.execArgv)
    && Array.isArray(options.stdio) && options.stdio.includes('ipc')) {
    const repaired = [flag, ...withoutPreload(options.execArgv)];
    options.args = [options.args[0], ...repaired, ...options.args.slice(1 + options.execArgv.length)];
    options.execArgv = repaired;
  }
}

function installWindowsHide(cp, syncExports) {
  if (process.platform !== 'win32') return;
  const key = Symbol.for('murage.windowsHide.installed');
  if (process[key]) return;
  const spawn = cp.ChildProcess.prototype.spawn;
  cp.ChildProcess.prototype.spawn = function (options) {
    options.windowsHide = true;
    normalizeChildEnv(options);
    return Reflect.apply(spawn, this, [options]);
  };
  const binding = process.binding('spawn_sync');
  for (const name of ['spawnSync', 'execSync', 'execFileSync']) {
    const original = cp[name];
    cp[name] = new Proxy(original, {
      apply(target, receiver, args) {
        const nativeSpawn = binding.spawn;
        binding.spawn = function (options) {
          options.windowsHide = true;
          normalizeChildEnv(options);
          return Reflect.apply(nativeSpawn, this, [options]);
        };
        try { return Reflect.apply(target, receiver, args); }
        finally { binding.spawn = nativeSpawn; }
      },
    });
  }
  const inherit = options => {
    if (options == null) return options;
    const result = { ...options };
    if (options.env != null && typeof options.env !== 'symbol') {
      const env = { ...options.env };
      const keys = Object.keys(env).filter(key => key.toUpperCase() === 'NODE_OPTIONS');
      const prior = keys.map(key => env[key] || '').join(' ');
      for (const key of keys) delete env[key];
      env.NODE_OPTIONS = normalizeNodeOptions(prior);
      result.env = env;
    }
    if (Array.isArray(options.execArgv)) {
      result.execArgv = [flag, ...withoutPreload(options.execArgv)];
    }
    return result;
  };
  // Node's native Worker constructor defaults to the startup exec_argv
  // snapshot, not later edits of process.execArgv. Bridge that snapshot here;
  // targets remain opaque, and Node still validates its own arguments.
  const workers = process.getBuiltinModule('node:worker_threads');
  const Worker = workers.Worker;
  workers.Worker = new Proxy(Worker, {
    construct(target, args, receiver) {
      const options = args[1];
      if (options !== undefined && (options === null || typeof options !== 'object'))
        return Reflect.construct(target, args, receiver);
      return Reflect.construct(target, [args[0], inherit({ ...options,
        execArgv: options?.execArgv === undefined ? process.execArgv : options.execArgv,
      })], receiver);
    },
  });
  process[key] = { inherit };
  syncExports();
  process.execArgv.splice(0, process.execArgv.length, flag, ...withoutPreload(process.execArgv));
  process.env.NODE_OPTIONS = inherit({ env: process.env }).env.NODE_OPTIONS;
}

installWindowsHide(childProcess, syncBuiltinESMExports);

/** Preserve caller options and every POSIX byte; repair explicit inheritance
 * overrides on Windows. Use at the launch itself, not on a tracked variable. */
function withHideInherit(options) {
  return process.platform === 'win32'
    ? process[Symbol.for('murage.windowsHide.installed')].inherit(options) : options;
}

module.exports = { installWindowsHide, withHideInherit, stripNodeOptionsExceptHide };
