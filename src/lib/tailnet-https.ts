// The one-time switch a tailnet needs before `tailscale serve` can give
// Murage a secure address, said as steps a person can follow. Shown only when
// the main process has diagnosed exactly this (`remoteAccess.reason`), never
// guessed at from here.
import type { CompanionRemoteAccess } from "@/components/PhoneSetupFlow";

/** The same page `electron/companion-remote-access.mjs` names; a test keeps
 *  the two equal. */
export const TAILSCALE_DNS_ADMIN_URL = "https://login.tailscale.com/admin/dns";

export interface TailnetHttpsHelp {
  title: string;
  steps: readonly string[];
  url: string;
  linkLabel: string;
  after: string;
}

export function tailnetHttpsHelp(remote: CompanionRemoteAccess | null | undefined): TailnetHttpsHelp | null {
  if (!remote || remote.on || remote.reason !== "no-certificates") return null;
  return {
    title: "Turn on HTTPS for your tailnet",
    steps: [
      "Open the DNS page of the Tailscale admin console and sign in with the account your tailnet uses.",
      "Make sure MagicDNS is on.",
      "Under HTTPS Certificates, choose Enable HTTPS.",
      "Come back here and turn on Allow remote access again.",
    ],
    url: TAILSCALE_DNS_ADMIN_URL,
    linkLabel: "Open Tailscale DNS settings",
    after:
      "It is a one-time switch for your whole tailnet. Until it is on, a browser on your tailnet can still open "
      + "Murage at its plain address, but the Murage phone app needs the secure one.",
  };
}
