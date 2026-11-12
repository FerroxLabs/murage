/** Normalize only the enumerated F7 review and public-fixture amendments when checking
 * the historical F0/F0.1 hashes. frozen-contract.json pins their current shapes. */
export function beforeF7ReviewAmendment(snapshot: Record<string, unknown>, options: { beforePublicFixtureAmendments?: boolean } = {}): Record<string, unknown> {
  // The joined F0/F0.1 pins already include public-fixture sanitization.
  // Older reviewed pins opt into restoring those exact prior fixture bytes.
  // Public-fixture (3ce499b5bf) and copy-only (9aaeaa1195) sanitization precede the F7 merge.
  // Exact hash pairs preserve the historical pin without permitting schema drift:
  // two validation messages and provider example addresses changed, no behavior.
  // The current frozen-snapshot assertion remains independent and unchanged.
  const publicFixtureAmendments: Record<string, readonly [string, string]> = {
    'server/highlevel/operations/schemas/common.ts': ['6d973fce0b70045d29f56d51000534a187131af60704a6be7767735421aecd44', '7f9062c534a5401ce7c11d20ad2b20b2f67155bd27da422c795103dc6fd7bc1d'],
    'server/highlevel/operations/schemas/opportunities.ts': ['34f34c16053e0798cc634c3f1be32276ac00aa91f83a19271b85a257b9aefeaa', '0e1b329879a68bf077b093c89c98710b6b9d389a967cc36d25cd7d48e11964e7'],
    'server/highlevel/provider-manifest.json': ['23e62b047463314dee45464dedece13a0a54629772154d2fb75f94a5f5af8b4b', 'e9b4e12b32a182a67cd9b27def3cd9a339f6960fc316ae0cdb8c29d1d01d22d9'],
  };
  return Object.fromEntries(Object.entries(snapshot).map(([path, value]) => {
    const amendment = options.beforePublicFixtureAmendments ? publicFixtureAmendments[path] : undefined;
    if (amendment && value === amendment[0]) return [path, amendment[1]];
    if (!['server/highlevel/operations/registry.ts', 'server/highlevel/held-request.ts', 'server/highlevel/actions.ts'].includes(path) || !Array.isArray(value)) return [path, value];
    return [path, (value as string[]).filter(signature => !signature.startsWith('export interface RequestApprovalContext ')).map(signature => signature
      .replace(/^\s*(?:readonly )?approvalContext\??: RequestApprovalContext;\n/gmu, '')
      .replace(/^\s*approvalContextDigest\?: string;\n/gmu, '')
      .replace(/^.*get approvalContextDigest\(\): string \| undefined;\n/gmu, '')
      .replace(/^.*approvalContextCopy\(\): RequestApprovalContext \| undefined;\n/gmu, '')
      .replace(' | "changed"', ''))];
  }));
}
