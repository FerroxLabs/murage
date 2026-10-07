import { registerPlugin } from "@capacitor/core";

import type { MurageShellPlugin } from "./shell-types";

export const shell = registerPlugin<MurageShellPlugin>("MurageShell");
