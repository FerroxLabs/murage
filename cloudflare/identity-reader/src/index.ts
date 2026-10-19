// SPDX-License-Identifier: AGPL-3.0-or-later
// murage-identity-reader: holds the Supabase secret key so the customer-facing control plane never does. No public route, no workers.dev,
// no preview URLs (wrangler.jsonc); reachable only through the control plane's service binding IDENTITY_READER. One method.
import { WorkerEntrypoint } from "cloudflare:workers";
import { readIdentity, type IdentityRead, type ReaderEnv } from "./read";

export class IdentityReader extends WorkerEntrypoint<ReaderEnv> {
  /** The account's current Supabase email and updated_at. Throws identity_unavailable on any failure; never returns partial data. */
  async emailGen(userId: string): Promise<IdentityRead> {
    return readIdentity(this.env, userId);
  }
}

// A Worker needs a default handler; this one answers nothing. (There is no route to it anyway.)
export default { async fetch(): Promise<Response> { return new Response(null, { status: 404 }); } };
