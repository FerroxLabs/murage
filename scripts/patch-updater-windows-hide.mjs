/** Audit the updater launch inventory on every rebuild. Repair explicit
 * inheritance overrides; the helper returns original POSIX options unchanged. */
const helper = 'const { withHideInherit } = require("../../shared/win-hide-child-process.mjs");\n';
export function patchUpdaterWindowsHide(source) {
  const alreadyPatched = source.includes(helper);
  if (alreadyPatched) source = source.replace(helper, '').replaceAll('(cmd, [...args], ', '(cmd, args, ')
    .replace('(cmd, args, withHideInherit(params))', '(cmd, args, params)')
    .replace('(destination, [], withHideInherit({ env }))', '(destination, [], { env })')
    .replace(/(\(0, child_process_1.spawnSync\)\(cmd, args, )withHideInherit\((\{[\s\S]*?\n        \})\)(\);)/, '$1$2$3');
  const launches = [
    '(0, child_process_1.spawnSync)(cmd, args, {',
    '(0, child_process_1.spawn)(cmd, args, params)',
    '(0, child_process_1.execFileSync)("mv", ["-f", installerPath, stagedDestination])',
    '(0, child_process_1.execFileSync)(destination, [], { env })',
    '(0, child_process_1.execFileSync)("sysctl", [sysctlRosettaInfoKey], { encoding: "utf8" })',
    '(0, child_process_1.execFileSync)("uname", ["-a"], { encoding: "utf8" })',
  ];
  for (const before of launches) {
    if (source.split(before).length !== 2) throw new Error(`Updater process launch changed; review windowsHide: ${before}`);
  }
  source = source
    .replace('(cmd, args, params)', '(cmd, args, withHideInherit(params))')
    .replace('(destination, [], { env })', '(destination, [], withHideInherit({ env }))')
    .replace(/(\(0, child_process_1.spawnSync\)\(cmd, args, )(\{[\s\S]*?\n        \})(\);)/, '$1withHideInherit($2)$3');
  source = source.replaceAll('(cmd, args, ', '(cmd, [...args], ');
  // A later reviewed vendor patch can prepend a comment. Keep the directive
  // ahead of the helper and preserve that header when auditing an existing bundle.
  const directive = /^(?:(?:\/\/[^\n]*\n)|(?:\/\*[\s\S]*?\*\/\s*)|\s)*"use strict";\n/.exec(source);
  return directive ? source.slice(0, directive[0].length) + helper + source.slice(directive[0].length) : helper + source;
}
