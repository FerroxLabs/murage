/** Owner: wg-pwsh; consumer: wg-wiring command rewrite seam. */
export function prefixPowerShellWipeGuard(command: string, guardPath: string): string {
  return `. '${guardPath.replace(/'/g, "''")}'; ${command}`;
}
