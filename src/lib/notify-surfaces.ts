// STUB (FR19b). The real module, with the real `shouldShowNotifyChooser`, is NOTIFY S5 on dev/1019-notify. When that
// branch merges, take THEIR version of this file and of src/components/NotifyChooser.tsx; nothing here is meant to stay.
// The contract is frozen: an async boolean, false for upgrades, the web, and a chooser already done or kept inside.
import { inNativeShell } from "./native-shell";

export async function shouldShowNotifyChooser(): Promise<boolean> {
  return inNativeShell();
}
