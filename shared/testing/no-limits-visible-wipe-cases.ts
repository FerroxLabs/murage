// SPDX-License-Identifier: AGPL-3.0-or-later
// Shell text is data only. None of these commands may be executed by a test.
export const visibleWipeCases: {id: string; command: string; wipe: boolean; narrowWipe?: boolean}[] = [];
// MAIN RULING NARROW-WIPE 2026-11-14: retain the historical raw oracle and attach independently specified current-policy expectations.
const add = (command: string, wipe: boolean, narrowWipe = wipe) => visibleWipeCases.push({id: 'case-' + String(visibleWipeCases.length + 1).padStart(4, '0'), command, wipe, narrowWipe});
const pwsh = (code: string) => 'pwsh -Command ' + JSON.stringify(code);
for (const alias of ['Remove-Item', 'ri', 'rm', 'rmdir', 'del', 'erase', 'rd']) {
 for (const separator of ['/', '\\']) for (const quote of ['"', "'"]) {
  for (const target of ['$HOME', '$env:USERPROFILE', '${HOME}', '~', '%USERPROFILE%', 'C:/Users/fixture', './build']) {
   const operand = quote + target.replaceAll('/', separator) + separator + '*' + quote;
   const code = `${alias} -Recurse -Force -Path ${operand}`;
   // PowerShell single quotes do not expand variables; percent expansion belongs to cmd.
   // MAIN RULING 1114-WIPE-FIXTURE-DIRECTION item 1: the outer double-quoted -Command text expands the variable before
   // PowerShell reads the inner single quotes, so the recursive delete reaches the whole home: CARD. Raw oracle unchanged.
   const root = target !== './build' && target !== '%USERPROFILE%';
   add(pwsh(code), true, root);
   add(pwsh(`Write-Output '${code.replaceAll("'", "''")}'`), true, false);
   for (const option of ['Exclude', 'Filter', 'Include']) {
    add(pwsh(`${code} -${option} "-LiteralPath"`), true, root);
    add(pwsh(`${alias} -${option} '-LiteralPath' -Recurse -Force -Path ${operand}`), true, root);
   }
  }
 }
 for (const flag of ['-Recurse', '-r', '-Force']) {
  add(pwsh(`${alias} ${flag} ./build`), true, false);
  add(pwsh(`${alias} ${flag} -LiteralPath './build'`), true, false);
  add(pwsh(`${alias} ${flag} -LiteralPath './build/*'`), true, false);
  add(pwsh(`${alias} ${flag} -LiteralPath:./build`), true, false);
  add(pwsh(`${alias} ${flag} -LiteralPath '$UNKNOWN'`), true, false);
  add(pwsh(`${alias} ${flag} -Path ./build -Unknown foo`), true, false);
 }
}
for (const target of ['$UNKNOWN', '${UNKNOWN}', '$env:USERPROFILE', '%USERPROFILE%', '~', '$HOME/cache', '$(printf /)', '`printf /`', './build/*', './build/?', './build/[ab]', './build/]']) {
 for (const flag of ['-r', '-f', '-rf']) {
  // MAIN RULING 1114-WIPE-FIXTURE-DIRECTION item 1: a recursive delete of the disk root cards however the root is reached.
  add(`rm ${flag} "${target}"`, true, (target === '$(printf /)' || target === '`printf /`') && flag !== '-f');
  add(`printf '%s' 'rm ${flag} ${target.replaceAll("'", '')}'`, true, false);
 }
 // MAIN RULING 1114-WIPE-FIXTURE-DIRECTION item 1: same root target through find.
 add(`find "${target}" -delete`, true, target === '$(printf /)' || target === '`printf /`');
 add(`cmd /c 'del /s /q "${target}"'`, true, target === '%USERPROFILE%');
}
for (const alias of ['del', 'erase', 'rd', 'rmdir']) for (const flag of ['/s', '/q', '/f']) {
 add(`cmd /c '${alias} ${flag} "C:\\Users\\fixture\\*"'`, true, flag === '/s');
 add(`cmd /c '${alias} ${flag} "%USERPROFILE%\\*"'`, true, flag === '/s');
 add(`cmd /c '${alias} ${flag} .\\build'`, true, false);
 add(`cmd /c 'echo ${alias} ${flag} "%USERPROFILE%\\*"'`, true, false);
}
for (const command of [
 'rm -rf ./node_modules', 'rm -rf -- ./build', 'rm -f ./build/file',
 'find ./build -type f -name "*.tmp" -delete', 'find ./build -delete',
 'pwsh -Command \'Remove-Item -Recurse -Force ./build\'',
 'pwsh -Command \'Remove-Item -Recurse -Force -LiteralPath "./build"\'',
 'pwsh -Command \'Remove-Item -Force -Exclude "-Recurse" ./build\'',
 'pwsh -Command \'Remove-Item -Exclude "-Recurse" ./build\'',
 'pwsh -Command \'Remove-Item -Recurse:$false -Force:$false "$UNKNOWN"\'',
]) add(command, !['rm -rf ./node_modules','rm -f ./build/file'].includes(command), false);
for (const command of [
 'pwsh -Command \'Remove-Item -Recurse -Force "$HOME\\*"\'',
 'pwsh -Command \'Remove-Item -Recurse -Force -Path "$HOME/*" -Exclude "-LiteralPath"\'',
 'pwsh -Command \'Get-ChildItem "$HOME\\*" | Remove-Item\'',
 'pwsh -Command \'Get-ChildItem -Recurse . | Remove-Item -Force\'',
 'pwsh -Command \'Remove-Item -Force -Path (Get-Location)\'',
 'pwsh -Command \'Remove-Item -Recurse -LiteralPath\'',
 'pwsh -Command \'Remove-Item -Recurse -Path ./build -Exclude -LiteralPath\'',
 'pwsh -Command \'Remove-Item -Recurse -Path "./build/*" "-LiteralPath"\'',
 'pwsh -Command \'Remove-Item -Recurse -LiteralPath "$env:TARGET"\'',
 'pwsh -Command \'Remove-Item -Recurse -Force ./build -Recurse:$UNKNOWN\'',
 'rm -rf ./build --unknown', 'rm -rf ./build --exclude "$HOME"',
 'find "$UNKNOWN" -type f -delete', 'find / -delete',
 'find ./build -unknown -delete', 'rm -rf /', 'rm -rf /fixture/home',
 'cmd /c \'rd /s /q "C:\\Windows\\System32"\'',
]) add(command, true);

// Native Windows spellings must also survive the outer POSIX tokenization.
for (const alias of ['Remove-Item', 'ri']) {
 add(`${alias} -Recurse -Force C:\\Windows\\System32`, true);
 add(`${alias} -Recurse -Force C:\\Users\\fixture\\*`, true);
 add(`${alias} -Recurse -Force .\\build`, alias !== 'Remove-Item');
 add(`${alias} -Recurse -LiteralPath .\\build`, true);
}

for (const command of [
 "rm '-rf' '$UNKNOWN'", "rm '--recursive' '$UNKNOWN'", 'rm --rec /',
 "bash '-c' 'rm -rf /'", "find / '-delete'", 'rm --for /',
 'pwsh -Command \'Remove-Item -Recurse C:Windows\'',
 'pwsh -Command \'Remove-Item -Recurse HKLM:\\SOFTWARE\'',
]) add(command, true);

for (const command of [
 'cd /; rm -rf .', 'env -C / rm -rf .',
 'cd "$UNKNOWN"; rm -rf ./build',
]) add(command, true);

for (const command of [
 'Get-ChildItem "$HOME\\*" | rm',
 'pwsh -Command \'Remove-Item -Recurse -Force -Lit"eral"Path "./build/*"\'',
]) add(command, true);

for (const command of [
 'cmd /v:on /c \'rd /s /q "!USERPROFILE!"\'',
 'cmd /c \'rd /s /q "\\Windows\\System32"\'',
 'pwsh -Command \'Remove-Item -Recurse -Force "\\Windows\\System32"\'',
]) add(command, true);

for (const command of [
 'pwsh -Command \'Remove-Item -Recurse:"$false" -Force:"$false" "$UNKNOWN"\'',
 'pwsh -Command \'Remove-Item -Recurse:`$false "$UNKNOWN"\'',
]) add(command, true);

// R4 raw-text regressions and concrete/inert controls. Data only.
export const rawWipeCases = [
 {id: 'pwsh-multi-argument', command: "pwsh -Command 'Remove-Item -Recurse -Force' '$HOME'", wipe: true},
 {id: 'bash-flag-continuation', command: 'rm \\\n-rf "$HOME"', wipe: true},
 {id: 'bash-within-flag-continuation', command: 'rm -r\\\nF "$HOME"', wipe: true},
 {id: 'pwsh-multiline-pipeline', command: `pwsh -Command 'Get-ChildItem -Recurse -File "$HOME" |
Remove-Item'`, wipe: true},
 {id: 'windows-root-relative', command: 'cmd /c \'rd /s /q "\\Users\\fixture"\'', wipe: true},
 {id: 'raw-unparsed-wrapper', command: "unknown-wrapper 'rm -rf $UNKNOWN'", wipe: true},
 {id: 'pwsh-tick-continuation', command: 'pwsh -Command \'Remove-Item -Rec`\nurse $HOME\'', wipe: true},
 {id: 'substitution-is-not-logging', command: 'echo "$(rm -rf $HOME)"', wipe: true},
 {id: 'directory-substitution', command: 'cd "$(rm -rf $HOME)"; rm -rf /tmp/build-123', wipe: true},
 {id: 'bash-extra-arguments', command: "bash -c 'rm -rf /tmp/build-123; eval \"$@\"' _ 'rm -rf $HOME'", wipe: true},
 {id: 'windows-dot-suffix', command: 'Remove-Item -Recurse "C:\\Users\\fixture. "', wipe: true},
 {id: 'windows-device-namespace', command: 'Remove-Item -Recurse "\\\\?\\C:\\Users\\fixture"', wipe: true},
 {id: 'windows-drive-relative', command: 'Remove-Item -Recurse C:work', wipe: true},
 {id: 'git-clean', command: 'git clean -xfd', wipe: true},
 {id: 'git-clean-global-options', command: 'git -C /tmp/build-123 clean -fxd', wipe: true},
 {id: 'git-clean-quoted', command: '"git" "clean" "-xfd"', wipe: true},
 {id: 'find-delete', command: 'find /fixture/home -type f -delete', wipe: true},
 {id: 'uppercase-raw', command: "unknown-wrapper 'RM -RF $HOME'", wipe: true},
 {id: 'unmatched-global-raw', command: 'rm -rf /tmp/build-123; unknown-wrapper rm\n-rf $HOME', wipe: true},
 {id: 'dynamic-parameter', command: 'Remove-Item -Recurse C:\\work\\out -Exclude $UNKNOWN', wipe: true},
 {id: 'literal-posix', command: 'rm -rf /tmp/build-123', wipe: false},
 {id: 'literal-pwsh-multi-argument', command: "pwsh -Command 'Remove-Item -Recurse -Force' 'C:\\work\\out'", wipe: true},
 {id: 'literal-cmd-multi-argument', command: "cmd /c rd /s /q 'C:\\work\\out'", wipe: true},
 {id: 'literal-unc', command: 'Remove-Item -Recurse "\\\\server\\share\\out"', wipe: true},
 {id: 'literal-windows', command: 'Remove-Item -Recurse -Force C:\\work\\out', wipe: false},
 {id: 'nonrecursive', command: 'rm file.txt', wipe: false},
 {id: 'inert-pipeline', command: 'Get-ChildItem C:\\x | Select-Object Name', wipe: false},
] as const;
// MAIN RULING NARROW-WIPE 2026-11-14: opaque execution, ordinary targets and Git cleanup are not catastrophe classes.
// MAIN RULING 1114-WIPE-FIXTURE-DIRECTION item 1: bash-extra-arguments evaluates its literal argument, a recursive delete of home: CARD.
const rawRuns = new Set(['raw-unparsed-wrapper','windows-drive-relative','git-clean','git-clean-global-options','git-clean-quoted','uppercase-raw','unmatched-global-raw','dynamic-parameter','literal-pwsh-multi-argument','literal-cmd-multi-argument','literal-unc']);
for (const row of rawWipeCases) visibleWipeCases.push({...row,narrowWipe:rawRuns.has(row.id)?false:row.wipe});

// R5 programs are data only, including all nested shell syntax.
export const hiddenExecutionWipeCases = [
 {id: 'review-process-substitution', command: 'echo <(rm -rf "$HOME")', wipe: true},
 {id: 'review-find-name-substitution', command: 'find /tmp/build-123 -name "$(rm -rf "$HOME")" -delete', wipe: true},
 {id: 'review-env-substitution', command: 'env X="$(rm -rf "$HOME")" rm -rf /tmp/build-123', wipe: true},
 {id: 'review-logging-shell-consumer', command: `echo 'rm -rf "$HOME"' | sh`, wipe: true},
 {id: 'literal-followed-by-backtick-wipe', command: 'rm -rf /tmp/x; `rm -rf ~`', wipe: true},
 {id: 'heredoc-shell', command: 'cat <<EOF | sh\nrm -rf ~\nEOF', wipe: true},
 {id: 'literal-before-unparsed-wipe', command: 'rm -rf /tmp/x; unknown-wrapper rm -rf ~', wipe: true},
 {id: 'two-literal-deletes', command: 'rm -rf /tmp/x; rm -rf /tmp/y', wipe: true},
 {id: 'two-literal-targets', command: 'rm -rf /tmp/x /tmp/y', wipe: true},
 {id: 'literal-before-disk-wipe', command: 'rm -rf /tmp/x; mkfs.ext4 /dev/fixture', wipe: true},
 {id: 'literal-control', command: 'rm -rf /tmp/build-123', wipe: false},
 {id: 'date-substitution-control', command: 'echo "$(date)"', wipe: false},
 {id: 'pwd-substitution-control', command: 'ls $(pwd)', wipe: false},
] as const;
// MAIN RULING NARROW-WIPE 2026-11-14: unknown wrapper arguments and ordinary multi-target cleanup run.
const hiddenRuns = new Set(['literal-before-unparsed-wipe','two-literal-deletes','two-literal-targets']);
for (const row of hiddenExecutionWipeCases) visibleWipeCases.push({...row,narrowWipe:hiddenRuns.has(row.id)?false:row.wipe});

const hiddenMarkers = ['$(date)', '`date`', '<(date)', '>(cat)', 'eval true', 'source /tmp/fixture', '. /tmp/fixture', 'exec true', 'cat <<EOF\nfixture\nEOF', 'find /tmp/x -exec true {} ;', 'find /tmp/x -execdir true {} ;', 'find /tmp/x -ok true {} ;'];
const deleteVerbs = ['rm /tmp/x', 'rmdir /tmp/x', 'unlink /tmp/x', 'shred /tmp/x', 'Remove-Item C:/work/out', 'ri C:/work/out', 'del C:/work/out', 'erase C:/work/out', 'rd C:/work/out', '-delete', 'git clean', 'truncate -s 0 /tmp/x', 'dd of=/tmp/x', 'mkfs.ext4 /tmp/x', 'find /tmp/x -delete'];
for (const marker of hiddenMarkers) for (const verb of deleteVerbs) {
 add(`printf '%s' '${verb}'; ${marker}`, true, false);
 add(`rm -rf /tmp/build-123; printf '%s' '${verb}'; ${marker}`, true, false);
}

// Final review: redirection-adjacent source must hold on both Pi fallbacks.
add(`echo 'rm -rf "$HOME"' > /tmp/nolim-r5; source</dev/null /tmp/nolim-r5`, true, false);

// MAIN RULING NARROW-WIPE 2026-11-14: explicit ordinary/opaque operands,
// missing operands, registry hives and nonrecursive removals are not catastrophes.
// Stable IDs keep the historical inputs and raw oracle values unchanged.
const ordinaryVisibleIds = new Set([
 'case-1851','case-1852','case-1853','case-1854','case-1855','case-1856','case-1857','case-1858',
 'case-1859','case-1861','case-1863','case-1870','case-1873','case-1874','case-1875','case-1876',
 'case-1880','case-1881','case-1882','case-1885','case-1886','case-1887','case-1891','case-1892',
]);
for (const row of visibleWipeCases) if (ordinaryVisibleIds.has(row.id)) row.narrowWipe=false;
