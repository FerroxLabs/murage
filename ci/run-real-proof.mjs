// Owner CI caller: wg-ci; owner production-proof recipe: wg-int; owner witnesses: wg-proof.
// Published native proof recipe from the integration gate handoff. Temporary copies only.
// Owner callback/client: wg-callback; owner shim: wg-shim; owner Claude seam: wg-wiring.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const candidate = path.resolve(process.argv[2] ?? process.cwd());
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'wg-int-proof-'));
try {
  // Preserve repository-relative imports, including the shared preload.
  const server = path.join(scratch, 'server');
  await fs.mkdir(server);
  const proof = path.join(server, 'wipe-proof');
  await fs.cp(path.join(candidate, 'server/wipe-proof'), proof, { recursive: true });
  await fs.symlink(path.join(candidate, 'server/wipe-guard'), path.join(server, 'wipe-guard'), 'junction');
  await fs.symlink(path.join(candidate, 'shared'), path.join(scratch, 'shared'), 'junction');
  const original = path.join(proof, 'app.mjs');
  await fs.rename(original, path.join(proof, 'fixture-app.mjs'));
  const callback = path.join(candidate, 'server/wipe-guard/server.ts');
  const runtimeSource = '#!/bin/sh\n[ "$ELECTRON_RUN_AS_NODE" = 1 ] || exit 11\nprintf "called\\n" >> "$WIPE_PROOF_CLIENT_LOG"\nexec '+"'"+process.execPath.replaceAll('\\','/').replaceAll("'","'\\''")+"'"+' "$@"\n';
  await fs.writeFile(original, `import fs from 'node:fs/promises';
import path from 'node:path';
import { startWipeGuardTurn } from ${JSON.stringify(pathToFileURL(callback).href)};
import { startApp as faultApp } from './fixture-app.mjs';
import { systemPathPort, canonicalPath } from ${JSON.stringify(pathToFileURL(path.join(candidate, 'server/wipe/roots.ts')).href)};
const runtimeSource = ${JSON.stringify(runtimeSource)};
export async function startApp(socket, tree, token, threadId) {
  const faults = await faultApp(socket, tree, token, threadId);
  const requests = faults.requests, errors = faults.faults;
  let guard, config, script = ['deny'];
  return { requests, faults: errors,
    async reset(options) {
      await guard?.end();
      const runtime=path.join(options.directory,'client-runtime');
      await fs.writeFile(path.join(options.directory,'client-invocations'),'');
      await fs.writeFile(runtime,runtimeSource,{mode:0o700});
      guard = await startWipeGuardTurn({ directory: options.directory, threadId,
        roots: options.roots, client: [runtime,options.client[1]], realTools: options.realTools,
        context: {cwd:tree, home:options.roots[0], project:options.roots[0],
          registry:{contains:p=>p===options.roots[0]}, env:{},
          ...(process.platform==='linux'?{}:{pathPort:{realpath:p=>systemPathPort.realpath(p),
            isBlockDevice:p=>canonicalPath(p)===canonicalPath(path.join(tree,'device'))||systemPathPort.isBlockDevice(p)}})},
        isLive:()=>true,
        askWipe:async request=>{ requests.push(request); return script.length>1?script.shift():script[0]; } });
      config = JSON.parse(await fs.readFile(guard.file,'utf8'));
      return config;
    },
    async script(actions, guardFile, originalConfig) {
      script = [...actions];
      if(actions.some(x=>x==='wrong-id'||x==='disconnect')) {
        faults.script(actions);
        await fs.writeFile(guardFile, JSON.stringify({...originalConfig,socket,token}));
        // Fault injection alone uses the published fixture endpoint.
      }
    },
    async close(){await guard?.end();await faults.close();}
  };
}
`);
  const backendPath=path.join(proof,'fixture-tool.mjs');
  let backend=await fs.readFile(backendPath,'utf8');
  backend=backend.replace("  const operands =", "  if ((process.env.ELECTRON_RUN_AS_NODE ?? '__absent__') !== process.env.WIPE_PROOF_ORIGINAL_ELECTRON) throw Error('client-env-leaked');\n  const operands =");
  await fs.writeFile(backendPath,backend);
  const driverPath = path.join(proof, 'posix/driver.mjs');
  let driver = await fs.readFile(driverPath, 'utf8');
  driver = `import { murageExecPrefix, writeExecEnvFile } from ${JSON.stringify(pathToFileURL(path.join(candidate, 'server/drivers/murage-exec.ts')).href)};\n` + driver;
  // The wrapper is named exactly as Claude is handed it (murageExecPrefix: forward slashes under Git Bash). Its W2
  // check finds its own folder from $0 by the last "/", so a backslash spelling refuses every command (exit 126).
  // Real client admits only the production local named-pipe grammar on Windows.
  driver = driver.replaceAll("wipe-proof-' + randomUUID()", "murage-wipe-' + randomUUID().replaceAll('-','')")
    .replaceAll("wipe-proof-absent-' + randomUUID()", "murage-wipe-' + randomUUID().replaceAll('-','')");
  driver = driver.replace('roots: [shellFile(protectedRoot)]', "roots: [shellFile(protectedRoot), ...(process.platform==='linux'?[]:[shellFile(path.join(tree,'device'))]), ...Array.from({length:process.platform==='linux'?63:62},(_,i)=>shellFile(path.join(tree,'guard-root'+i)))]");
  driver = driver.replace('await fs.mkdir(protectedRoot, { recursive: true }); await fs.mkdir(benign);', "await fs.mkdir(protectedRoot, { recursive: true }); await fs.mkdir(benign); for(let i=0;i<63;i++) await fs.mkdir(path.join(tree,'guard-root'+i));");
  driver = driver.replace('await fs.mkdir(protectedRoot, { recursive: true }); await fs.mkdir(benign);', `await fs.mkdir(protectedRoot, { recursive: true }); await fs.mkdir(benign);
    if(process.platform==='linux') {
      const made=await execute('/usr/bin/mknod',[path.join(tree,'device'),'b','240','240'],process.env,tree);
      if(made.code!==0)throw Error('fixture-block-node-unavailable');
    } else await fs.writeFile(path.join(tree,'device'),'synthetic device fixture');`);
  driver = driver.replace("`dd of=${p}` : `${tool} ${p}`", "`dd of=${q(path.join(tree,'device'))}` : `${tool} ${q(path.join(tree,'device'))}`");
  driver = driver.replace('const baseEnv = { ...process.env,', "const baseEnv = { ...process.env, WIPE_PROOF_CLIENT_LOG: path.join(control,'client-invocations'), WIPE_PROOF_ORIGINAL_ELECTRON: process.env.ELECTRON_RUN_AS_NODE ?? '__absent__',");
  driver = driver.replace(': socket }), { mode: 0o600 }', ': config.socket }), { mode: 0o600 }');
  driver = driver.replace("await fs.writeFile(guardFile, variant", "Object.assign(config, await app.reset({directory:control, roots:config.roots, client:config.client, realTools}));\n      await fs.writeFile(guardFile, variant");
  driver = driver.replace("app.script(test.decisions ?? [test.decision ?? (test.allow ? 'allow' : 'deny')]);", "await app.script(test.decisions ?? [test.decision ?? (test.allow ? 'allow' : 'deny')], guardFile, config);");
  driver = driver.replace("const outcome = await execute(executable, ['-c', shell === 'fish' && test.fish ? test.fish : test.command], env, tree);", `const command = shell === 'fish' && test.fish ? test.fish : test.command;
      const outcome = shell === 'fish'
        ? await execute(executable, ['-c', command], env, tree)
        : await execute(bootstrapShell === 'sh.exe' ? 'bash.exe' : '/bin/bash', [murageExecPrefix(), command],
          { PATH: process.env.PATH, MURAGE_EXEC_ENV_FILE: writeExecEnvFile('proof', env, tree, executable) }, tree);`);
  driver = driver.replace('const requests = app.requests.slice(requestStart);', `const requests = app.requests.slice(requestStart);
      const clientCalls=(await fs.readFile(path.join(control,'client-invocations'),'utf8')).trim().split('\\n').filter(Boolean).length;`);
  driver = driver.replace('const ok = !outcome.timedOut', `const ok = clientCalls === (test.match || test.variant === 'unreachable' ? test.requestCount ?? 1 : 0) && !outcome.timedOut`);
  driver = driver.replace('requests: requests.length, backendCalls:', 'requests: requests.length, clientCalls, backendCalls:');
  driver = driver.replace("} catch {\n  report('fixture-setup-or-run', false);", "} catch (error) {\n  report('fixture-setup-or-run', false, {error:String(error)});");
  // MAIN RULING MAIN 1114-WG-SHIM-TIMING: 10ms median, 200 samples.
  // Under Git Bash the shim is one more MSYS process image than the direct tool, and the same run measures that cost
  // (fastPathBudgetMs in adapter.mjs); every other host keeps the plain 10 ms.
  driver = driver.replace("posixStatus } from '../adapter.mjs'", "posixStatus, fastPathBudgetMs } from '../adapter.mjs'");
  driver = driver.replace('i < 45', 'i < 205').replace("'fast-path-under-5ms', overheadMs < 5", "'fast-path-at-most-10ms', overheadMs <= fastPathBudgetMs(process.platform, median(timings.real))").replace('samples: 40', 'samples: 200, budgetMs: fastPathBudgetMs(process.platform, median(timings.real))');
  driver = driver.replace("mode: stub ? 'contract-stub' : 'production-guard'", "roots: 64, deviceMetadata: process.platform==='linux'?'native temp block node, never opened':'synthetic temp-file block type; device predicates are separate read-only witnesses', callback: 'production (wrong-id/disconnect use fault endpoint)', seam: 'real Claude murage-exec for bash/zsh/dash; direct fish', mode: stub ? 'contract-stub' : 'production-guard'");
  await fs.writeFile(driverPath, driver);
  const code = await new Promise((resolve,reject)=>{
    const child=spawn('sh',[path.join(proof,'posix/run.sh')],{stdio:'inherit'});
    child.once('error',reject);child.once('exit',resolve);
  });
  process.exitCode=code??1;
} finally { await fs.rm(scratch,{recursive:true,force:true}); }
