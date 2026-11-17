// Keep installer CLI tests unprivileged: only their private Tailscale stub may
// pass through this sudo stand-in. Every other requested program is refused.
import { mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve, sep } from 'node:path';

export function withFixtureSudo(env, root) {
  if (process.platform !== 'linux') return env;
  const command = env.MURAGE_TAILSCALE_BIN;
  const home = resolve(root);
  if (!command || !resolve(command).startsWith(home + sep)) return env;
  const bin = join(home, 'fixture-sudo-bin');
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  const quoted = "'" + command.replaceAll("'", "'\\''") + "'";
  writeFileSync(join(bin, 'sudo'), `#!/bin/sh\n[ "$1" = ${quoted} ] || exit 125\nexec "$@"\n`, { mode: 0o700 });
  return { ...env, PATH: bin + delimiter + (env.PATH ?? '') };
}
