// Launcher producer owner: gnl-harness-r11. Fake protocol consumers: gnl-harness-r11.
import {createMountedTools} from './mounted-tools.mjs';
import {executeReleased} from './fixture-actions.mjs';
import {sealGatedHandle} from './gated-handle.mjs';
export const gatedHandle=sealGatedHandle({createMountedTools,executeReleased});
