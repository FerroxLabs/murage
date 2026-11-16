// Gated handle producer owner: gnl-harness-r11. Native fake protocol consumer owner: gnl-harness-r11.
import {gatedHandle} from './gated-runtime.mjs';
import {nativePlay as play} from './fakes/native-play.mjs';
export const nativePlay=(value,options)=>play(value,{...options,gatedHandle});
