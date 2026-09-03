/**
 * Provenance for a bot that arrived from a bot package.
 *
 * The harness writes this once at install time and never re-derives it, so
 * it is the only record of which listing an assistant came from and which
 * connected services that listing said the job depends on. It reaches the
 * renderer on GET /api/bots, on the import response and on every SSE bot
 * frame, which is why the shape lives here rather than in the store: the
 * server persists it, the client renders it, and one declaration is what
 * keeps the two from drifting apart.
 *
 * Declaring a required app is NEVER a grant. The apps here describe the
 * shape of the assistant's job; authorization lives entirely in the
 * workspace's connections.
 */

/** One connected service a package declares its assistant's work depends on.
 * `optional` marks a service the job degrades without rather than fails. */
export interface InstalledPackageRequiredApp {
  slug: string;
  label: string;
  reason: string;
  optional?: boolean;
}

export interface InstalledPackageMetadata {
  id: string;
  name: string;
  release: string;
  requiredApps: InstalledPackageRequiredApp[];
}
