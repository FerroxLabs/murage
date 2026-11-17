// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Explicit in-memory acknowledgements for tests. Production stores never infer an acknowledgement.
import { EmailSecretStore, type EmailSecretsDoc, type EmailSecretsPersist } from "../email/email-secrets.ts";
import { EmailRuntime } from "../email/runtime.ts";
export function fixtureEmailKeyIds(doc: EmailSecretsDoc): string[] {
  return [...Object.values(doc.bots), ...Object.values(doc.prev ?? {}), ...Object.values(doc.retired ?? {}), ...(doc.legacyRetired ?? []), ...(doc.owner ? [doc.owner] : [])].map(value => value.keyId);
}
export function createMemoryEmailSecrets(persist?: EmailSecretsPersist, options?: ConstructorParameters<typeof EmailSecretStore>[1]): EmailSecretStore {
  let store: EmailSecretStore;
  store = new EmailSecretStore((doc, meta) => {
    const result = persist?.(doc, meta);
    if (result === false) return false;
    if (result !== true) store.ack({ ...meta, keyIds: fixtureEmailKeyIds(JSON.parse(JSON.stringify(doc))) });
    return true;
  }, options);
  return store;
}
export function createMemoryEmailRuntime(options: ConstructorParameters<typeof EmailRuntime>[0]): EmailRuntime {
  let runtime: EmailRuntime;
  runtime = new EmailRuntime({ ...options, persistSecrets: (doc, meta) => {
    const result = options.persistSecrets?.(doc, meta);
    if (result === false) return false;
    if (result !== true) {
      const saved = JSON.parse(JSON.stringify(doc)) as EmailSecretsDoc;
      queueMicrotask(() => runtime.secrets.ack({ ...meta, keyIds: fixtureEmailKeyIds(saved) }));
    }
    return true;
  } });
  return runtime;
}
