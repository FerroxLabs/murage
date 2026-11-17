// Native host producer owner: MAIN. Fixture consumer owner: gnl-harness-r11.
import {runNativeHost,readHostConfig,FrameDecoder,encodeFrame} from '../../electron/browser-extension-host.mjs';
import {sealGatedHandle} from './gated-handle.mjs';
import {attachFixtureExtension as attach} from './fakes/browser-extension.mjs';
export {fixtureExtensionEngine} from './fakes/browser-extension.mjs';
export const attachFixtureExtension=broker=>attach(broker,sealGatedHandle({runNativeHost,readHostConfig,FrameDecoder,encodeFrame}));
