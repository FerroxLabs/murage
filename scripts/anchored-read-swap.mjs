// Restore the attack between native checkpoints when the OS permits it. Windows
// can deny a rename while the native reader holds the directory without delete
// sharing; in that case restore as soon as read has closed all of its handles.
import { join } from 'node:path';
export function swapAndRestoreHook(fs, dir, outside, point, platform = process.platform) {
  let swapped = false, linked = false;
  const denied = error => platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(error.code);
  const restore = (duringRead = false) => {
    if (!swapped) return;
    if (linked) { fs.unlinkSync(join(dir, 'dir')); linked = false; }
    try { fs.renameSync(join(dir, 'held'), join(dir, 'dir')); swapped = false; }
    catch (error) { if (!duringRead || !denied(error)) throw error; }
  };
  return {
    restore,
    step(step) {
      restore(true);
      if (swapped || step.kind !== point) return;
      try { fs.renameSync(join(dir, 'dir'), join(dir, 'held')); }
      catch (error) { if (!denied(error)) throw error; return; }
      swapped = true;
      fs.symlinkSync(outside, join(dir, 'dir'), platform === 'win32' ? 'junction' : 'dir'); linked = true;
    },
  };
}
