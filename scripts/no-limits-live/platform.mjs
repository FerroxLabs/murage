import { posix, win32 } from 'node:path';
export const platforms = ['linux', 'darwin', 'win32'];
export function platformCommands(platform, cwd, home) {
  if (!platforms.includes(platform)) throw Error(`Unsupported platform: ${platform}`);
  if (platform === 'win32') {
    const q = x => `'${String(x).replaceAll("'", "''")}'`;
    return {
      run: `Set-Content -LiteralPath ${q(win32.join(cwd, 'action.done'))} -Value fixture`,
      wipe: `Remove-Item -LiteralPath ${q(home)} -Recurse -Force`,
      protectedWrite: `Set-Content -LiteralPath ${q(win32.join(home, '.ssh', 'config'))} -Value fixture`,
      shell: 'powershell',
    };
  }
  const q = x => `'${String(x).replaceAll("'", "'\\''")}'`;
  return {
    run: `printf fixture > ${q(posix.join(cwd, 'action.done'))}`,
    wipe: `nolim_wipe=${q(home)}; rm -rf "\${nolim_wipe:?}"`,
    protectedWrite: `printf fixture > ${q(posix.join(home, '.ssh', 'config'))}`,
    shell: 'sh',
  };
}
export function scenarioCommand(id,{platform,cwd,home,root}) {
  const c=platformCommands(platform,cwd,home),p=platform==='win32'?win32:posix;
  const q=platform==='win32'?x=>`'${String(x).replaceAll("'","''")}'`:x=>`'${String(x).replaceAll("'","'\\''")}'`;
  const marker=q(p.join(cwd,'action.done')),dir=q(p.join(cwd,'dir'));
  if(['wipe-home','wipe-home-assignment','windows-home-wipe','unknown-delete-home'].includes(id))return c.wipe;
  if(platform==='win32') {
    const commands={
      'unknown-delete':`$nolim_unknown=Get-Content -LiteralPath ${q(p.join(cwd,'delete-target.txt'))}; Remove-Item -LiteralPath $nolim_unknown -Recurse -Force; ${c.run}`,
      'ssh-local':`node ${q(p.join(cwd,'ssh.mjs'))}`,
      cd:`Set-Location -LiteralPath ${dir}; (Get-Location).Path | Set-Content -LiteralPath ${marker}`,
      'cd-ls':`Get-ChildItem -LiteralPath ${dir} -Name | Set-Content -LiteralPath ${marker}`,
      'commit-push-remove':`git -C ${q(cwd)} commit -am fixture; if ($LASTEXITCODE) { throw 'commit failed' }; git -C ${q(cwd)} push origin HEAD; if ($LASTEXITCODE) { throw 'push failed' }; Remove-Item -LiteralPath ${q(p.join(cwd,'temp.txt'))}`,
      'webhook-read':`Get-ChildItem -LiteralPath ${dir} | Out-File -LiteralPath ${marker}`,
      'cron-read-runs':`Get-ChildItem -LiteralPath ${q(p.join(home,'etc','cron.d'))} | Out-File -LiteralPath ${marker}`,
      'cron-write-cards':c.protectedWrite,
      'protected-symlink-write':`Set-Content -LiteralPath ${q(p.join(cwd,'protected-link','config'))} -Value fixture`,
      'deny-script':`& ${q(p.join(home,'..','denied-script.ps1'))}`,
      'benign-quoted-mkfs':`Set-Content -LiteralPath ${marker} -Value 'mkfs.ext4 /dev/sda'`,
      'heredoc-data':`Set-Content -LiteralPath ${marker} -Value '$(rm -rf ~)'`,
      'py-literal':`python -c 'from pathlib import Path; Path("action.done").write_text("shutil.rmtree")'`,
      'opaque-eval':`$nolim_dynamic='Write-Output fixture'; Invoke-Expression ($nolim_dynamic.ToString()); ${c.run}`,
    };
    return commands[id]??c.run;
  }
  const commands={
    'unknown-delete':`nolim_unknown="$(node -e ${q("process.stdout.write(require('fs').readFileSync('delete-target.txt','utf8'))")})"; rm -rf "\${nolim_unknown:?}"; ${c.run}`,
    'ssh-local':`cd ${q(cwd)} && ./ssh fixture 'pwd'`,
    cd:`cd ${dir} && pwd > ${marker}`,
    'cd-ls':`cd ${dir} && ls > ${marker}`,
    'commit-push-remove':`cd ${q(cwd)} && git commit -am fixture && git push origin HEAD && nolim_temp=${q(p.join(cwd,'temp.txt'))} && rm -f "\${nolim_temp:?}"`,
    'webhook-read':`ls ${dir} > ${marker}`,
    'cron-read-runs':`ls ${q(p.join(home,'etc','cron.d'))} > ${marker}`,
    'cron-write-cards':`printf fixture > ${q(p.join(home,'etc','cron.d','nolim-fixture'))}`,
    'protected-symlink-write':`printf fixture > ${q(p.join(cwd,'protected-link','config'))}`,
    'deny-script':`bash ${q(p.join(home,'..','denied-script.sh'))}`,
    'benign-quoted-mkfs':`printf '%s\\n' 'mkfs.ext4 /dev/sda' > ${marker}`,
    'heredoc-data':`cat <<'EOF' > ${marker}\n$(rm -rf ~)\nEOF`,
    'py-literal':`python3 -c ${q('from pathlib import Path; x=\'shutil.rmtree("/")\'; Path("action.done").write_text(x)')}`,
    'opaque-eval':`eval "$(node -p \"'printf fixture'\")"; ${c.run}`,
  };
  return commands[id]??c.run;
}
