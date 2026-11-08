// Execute the production lock and startup call sites with instrumented dependencies.
import vm from 'node:vm';
export async function runStartupBoundary(source, scope) {
  const lock=source.indexOf('if (!app.requestSingleInstanceLock()) {');
  const lockEnd=source.indexOf('function deliverPackageInstall',lock);
  const startup=source.indexOf('  if (app.isPackaged) { acquireDesktopDataOwner(); await initializeSentinelHost(); }');
  const end=source.indexOf('  if(!process.argv.includes(BACKUP_MODE_ARGUMENT))',startup);
  if(lock<0||lockEnd<lock||startup<lockEnd||end<startup)throw Error('production startup boundary changed');
  // A new owner call before the lock is a boundary violation even if the later call remains.
  if(/(?<!function )acquireDesktopDataOwner\(\)/.test(source.slice(0,lock)))throw Error('owner access before app lock');
  const context=vm.createContext(scope);
  vm.runInContext(source.slice(lock,lockEnd),context);
  await vm.runInContext('(async()=>{'+source.slice(startup,end)+'})()',context);
  await scope.desktopStartup;
  await Promise.resolve();
}
