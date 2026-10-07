import { startBrowserExtensionBroker } from '../browser-extension-broker.ts';
try {
  const broker = await startBrowserExtensionBroker({stateDir:process.argv[2],configAlias:'native-host.json'});
  process.send?.({ready:true});
  process.on('message', async message => {if(message==='close'){await broker.close();process.exit(0);}});
} catch(error) {
  process.send?.({code:(error as NodeJS.ErrnoException).code ?? 'START_FAILED'});
  process.exitCode=1;process.disconnect?.();
}
