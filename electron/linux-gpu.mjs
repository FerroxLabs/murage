import fs from "node:fs";

// Linux GPU rule. Chromium's GPU process crashed twice on the proprietary
// NVIDIA driver (libGLES) and left an invisible focused window intercepting
// input, so NVIDIA keeps software rendering. The open-source nouveau driver
// keeps it too: Mesa's nouveau GL driver is not stable with the several GL
// contexts Chromium's GPU process opens (other Chromium-based apps and
// Firefox keep hardware acceleration off on it), and software rendering is
// what every Linux machine had before, so nouveau loses nothing. Intel, AMD
// and every other driver use the GPU, because software rendering costs about
// a CPU core whenever the window animates.
//
// MURAGE_LINUX_GPU=off forces software rendering and MURAGE_LINUX_GPU=on
// forces the GPU, whatever the driver. Any other value is ignored.
const NVIDIA_PATHS = ["/proc/driver/nvidia/version", "/sys/module/nvidia"];
const NOUVEAU_PATHS = ["/sys/module/nouveau"];

export function linuxGpuDecision({ env = process.env, exists = fs.existsSync } = {}) {
  const override = String(env.MURAGE_LINUX_GPU ?? "").trim().toLowerCase();
  if (override === "off") return { disable: true, reason: "MURAGE_LINUX_GPU=off" };
  if (override === "on") return { disable: false, reason: "MURAGE_LINUX_GPU=on" };
  if (NVIDIA_PATHS.some((p) => exists(p))) return { disable: true, reason: "NVIDIA driver loaded" };
  if (NOUVEAU_PATHS.some((p) => exists(p))) return { disable: true, reason: "nouveau driver loaded" };
  return { disable: false, reason: "no NVIDIA or nouveau driver loaded" };
}

export function linuxDisablesGpu(options) {
  return linuxGpuDecision(options).disable;
}
