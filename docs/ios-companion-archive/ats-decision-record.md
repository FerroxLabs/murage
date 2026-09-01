# The ATS decision record

Verbatim from `ios/project.yml:104-121`, captured before `ios/` was deleted
(A4/A6, `docs/plans/universal-client/plan-ios-retirement.md`).

This is load-bearing for the browser door that replaces the iOS app. It is the
written reason the bare tailnet address was excluded from every candidate list
the desktop ever handed a client — and therefore the reason A7 could safely
put it back once the iOS client stopped existing.

```yaml
        # The companion listener is plain HTTP on a local address. ATS has
        # to be told, and this is the narrowest way to say it: local
        # networking only, not a blanket exception.
        #
        # NSAllowsLocalNetworking covers the private ranges — 10/8,
        # 172.16/12, 192.168/16, .local — and that is the whole LAN story.
        # It does *not* cover Tailscale: a tailnet address lives in
        # 100.64.0.0/10, the CGNAT range, which ATS treats as ordinary
        # public internet and blocks over plain HTTP. The address cannot be
        # exempted (ATS exceptions are by name, not by subnet), but the
        # MagicDNS name can be, and every tailnet name ends in ts.net — so
        # connect by name and this one entry covers every machine you own.
        NSAppTransportSecurity:
          NSAllowsLocalNetworking: true
          NSExceptionDomains:
            ts.net:
              NSIncludesSubdomains: true
              NSExceptionAllowsInsecureHTTPLoads: true
```

## What it meant, and what it no longer means

App Transport Security exempts *local networking* (10/8, 172.16/12, 192.168/16,
`.local`) from its plain-HTTP ban. Tailscale does not live there: a tailnet
address is in `100.64.0.0/10`, the RFC 6598 CGNAT range, which ATS treats as
ordinary public internet. ATS exceptions are matched **by name, not by subnet**,
so the address could never be exempted — only the MagicDNS name could, via the
`ts.net` `NSExceptionDomains` entry above.

That is an *Apple client* constraint. It was encoded in three places on the
server side of the wire, where it did not belong:

- `companion/src/control.ts` — `hostCandidates()` dropped the bare tailnet
  address outright.
- `companion/src/control.ts` — the control page told the user "iPhones cannot
  connect to a bare tailnet address".
- `companion/src/listener.ts` — the `tailnetName()` header carried the same
  justification for reading MagicDNS at all.

A browser over plain HTTP on the tailnet has **no equivalent restriction**. The
bare tailnet address is a working candidate for the PWA — in fact it is the one
that keeps working when MagicDNS is off or the Tailscale CLI cannot be found.
A7 removed the exclusion. The MagicDNS name still leads, but now on its real
merit (a stable name that survives a re-issued address), not on an ATS rule.

Keep this record. If anyone ever ships a native Apple client again, the
constraint comes back and this is the entry that has to go back into the
Info.plist.
