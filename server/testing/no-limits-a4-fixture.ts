// SPDX-License-Identifier: AGPL-3.0-or-later
// One integration seam if the No limits lane narrows release holds to wipes.
// Fake tools never write any of these referents.
export function protectedReferent(version = 0): string {
  return ['/etc/hosts', '/etc/passwd', '/etc/group'][version % 3]!;
}
