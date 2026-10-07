// Whether a call on this device uses the iPhone's native call audio (spec
// §4.3.2) or the web path (getUserMedia and an HTML audio element).
//
// The choice is made when the call opens, never at render: an app build
// only counts as able once hello() has answered and listed callAudioOpen,
// and a hello that is late is waited for (nativeAvailable does that).
//
// THE KILL SWITCH. If the native path misbehaves in the field it can be
// turned off from the Mac the same day, without a new iPhone build: flip
// NATIVE_CALL_AUDIO here and ship the page, or, for one device, set
// localStorage["murage.call.nativeAudio"] = "off" in its Web Inspector.

import { nativeAvailable } from "./native-shell";

export const NATIVE_CALL_AUDIO = true;

const SWITCH_KEY = "murage.call.nativeAudio";

function switchedOff(): boolean {
  if (!NATIVE_CALL_AUDIO) return true;
  try {
    return globalThis.localStorage?.getItem(SWITCH_KEY) === "off";
  } catch {
    // storage blocked: nothing on this device asked for the web path
    return false;
  }
}

/** True when this call should use native call audio. Logs the choice once
 *  per call, as a fixed line. */
export async function nativeCallAudioWanted(): Promise<boolean> {
  const wanted = !switchedOff() && (await nativeAvailable("callAudioOpen"));
  console.warn(wanted ? "[call-diag] audio native" : "[call-diag] audio web");
  return wanted;
}
