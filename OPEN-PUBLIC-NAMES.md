# Public scan name review

Reviewed against public main `fc3782abe834bb0a62c96437bff78ac4dbd96eeb` on 2026-11-11.

The public tree contains 287 files under `cloudflare/control-plane/`; that directory ships publicly and must remain in the export.

The 293 control-plane findings are public hosting-provider names, its API hostname, and identifiers in the provider/configuration/schema contract. The public `cloudflare/control-plane/src/b5-config.ts` defines the provider enum, image fields and location fields; `src/b3-provider.ts` defines the provider API. None of these findings is a private machine label or a personal hostname. Production contracts and their coupled test fixtures retain their existing names.

The scanner tool bundle records all 293 locations and their evidence in `provider-review.json`. Its `public-provider-reviewed.tsv` limits the provider-name exception to 269 distinct exact source-line hashes in their original paths. It does not waive any other private-string rule. The scanner selftest proves that changing a reviewed line, moving it to a different path, or adding a private hostname fails.

The nine remaining mobile URL fixtures are **OWNED-BY-MOBILE**, assigned to `fix/1019-mobile-tailnet-scrub`. The nine remaining email findings are in those mobile-owned files as well. This lane does not modify them or suppress their scanner findings.

No control-plane name findings remain unclassified. The raw tree still contains private development documentation and custody findings; only the authoritative publication scrub can determine the publishable tree. A clean raw scan or successful publication rehearsal is not claimed here.
