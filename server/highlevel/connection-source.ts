// SPDX-License-Identifier: AGPL-3.0-or-later
import { HighLevelError, type HighLevelLeaseRequest, type HighLevelLeaseSource } from './client.ts';
import type { HighLevelCredentialConnection } from './credential-connection.ts';
import type { HighLevelCredentialIntent } from './credential-commit.ts';
import type { PrivateTokenLeaseSource } from './private-token.ts';

/** One selection for owner status, grants, mounting and every runtime recheck.
 * A committed broker connection takes precedence; private-token-only profiles
 * keep their existing checks, scope evidence, epochs and disconnect behavior. */
export class HighLevelConnectionSource implements HighLevelLeaseSource {
  readonly #private: PrivateTokenLeaseSource;
  readonly #broker: HighLevelCredentialConnection | null;
  constructor(privateToken: PrivateTokenLeaseSource, broker: HighLevelCredentialConnection | null) {
    this.#private = privateToken;
    this.#broker = broker;
  }
  #source() { return this.#broker?.hasConnection() ? this.#broker : this.#private; }
  ownerView() { return this.#source().ownerView(); }
  connection(connectionId: string) { return this.#source().connection(connectionId); }
  lease(request: HighLevelLeaseRequest) { return this.#source().lease(request); }
  async disconnect(connectionId: string): Promise<{ disconnected: true; intent?: HighLevelCredentialIntent } | null> {
    const source = this.#source();
    if (source.ownerView()?.connectionId !== connectionId) return null;
    if (source === this.#private) return this.#private.disconnect(connectionId) ? { disconnected: true } : null;
    // Disconnect means no active source. Retire the hidden legacy confirmation
    // durably before removing the broker so fallback cannot reactivate it.
    const legacy = this.#private.ownerView();
    if (legacy) this.#private.disconnect(legacy.connectionId);
    try { return { disconnected: true, intent: await this.#broker!.disconnect(connectionId) }; }
    catch { throw new HighLevelError('HighLevel could not disconnect. Try again.', { status: 409 }); }
  }
}
