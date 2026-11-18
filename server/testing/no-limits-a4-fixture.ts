// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixture owner: tri3-g3. Registered project roots and referents stay in the
// isolated server data directory; the fake engine never executes the delete.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function projectReferents(dataDir: string, scenario: string): readonly string[] {
  return [0, 1, 2].map(version => {
    const root = join(dataDir, 'a4-projects', scenario, String(version));
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'sentinel.txt'), `fixture project ${version}\n`);
    return root;
  });
}

// Request-cwd classifier fixtures retain their protected-path diagnostic inputs.
// These paths never supply the answer-key fixture's No limits card trigger.
export function protectedReferent(version = 0): string {
  return ['/etc/hosts', '/etc/passwd', '/etc/group'][version % 3]!;
}
