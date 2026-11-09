// Loaded only by the coordinator shim in a disposable app copy.
import fs from 'node:fs';
import path from 'node:path';
import {installCommitStop} from './kill-support.mjs';
export function installQualification(BackupCoordinator, app) {
  const directory = process.env.MURAGE_MACWD_CASE;
  if (!directory) throw Error('Qualification profile required');
  const writeRecord = (name, value) => {
    const file = path.join(directory, name), temporary = file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(value), {mode:0o600});
    fs.renameSync(temporary, file);
  };
  const readTarget = () => {
    try { return fs.readFileSync(path.join(directory, 'stop-phase'), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
  };
  installCommitStop(BackupCoordinator.prototype, {
    target: readTarget,
    committed(file, phase) {
      writeRecord('committed.json', {pid:process.pid,file,phase});
    },
    stop() { process.kill(process.pid, 'SIGSTOP'); },
  });
  // Keep every launch owned by the driver. The app still performs its real
  // cleanup, arming and exit; the driver executes the exact requested args.
  app.relaunch = options => {
    writeRecord('relaunch.json', options);
  };
}
