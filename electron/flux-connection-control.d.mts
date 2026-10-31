// SPDX-License-Identifier: AGPL-3.0-or-later
export function mutateFluxCredentials(
  input: unknown,
  options: {
    packaged: boolean;
    updateDocument: (
      derive: (credentials: Record<string, string>) => Promise<Record<string, string>>,
      afterPersist: () => Promise<unknown>,
    ) => Promise<unknown>;
    post: (route: string, body: unknown) => Promise<any>;
    afterDocument?: () => Promise<void> | void;
  },
): Promise<unknown>;
