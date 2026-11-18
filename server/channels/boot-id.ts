// The machine's boot-session identifier, the only proof the receipt store accepts that the machine restarted
// since a migration (never uptime or clock arithmetic: both move when a clock is set or a sleep is resumed).
// Linux: the kernel's per-boot random id. macOS: kern.bootsessionuuid. Windows and anything else: no inference (null).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export function bootId(platform: NodeJS.Platform = process.platform): string | null {
  try {
    let value: string | undefined;
    if (platform === "linux") value = readFileSync("/proc/sys/kernel/random/boot_id", "utf8");
    else if (platform === "darwin") value = execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8", timeout: 2000 });
    const text = value?.trim();
    // Exactly one identifier in its canonical form; the all-zero one is what an unset value reads as, never a boot.
    return text && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text) && /[1-9a-f]/i.test(text) ? text.toLowerCase() : null;
  } catch { return null; }
}
