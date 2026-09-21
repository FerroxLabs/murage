---
ijfw_version: 1.3.2
ijfw_schema: 1
type: software
primary_type: software
secondary_types: []
confidence: 0.906
detected_at: 2026-09-21T19:44:04.943Z
signals:
  - kind: manifest
    weight: 0.9
    manifests: [package.json, package.json, package.json, package.json]
  - kind: dir_content
    weight: 0.4
    name: content
  - kind: dir_design
    weight: 0.4
    name: assets
  - kind: file_extension_ratio
    weight: 0.7
    domain: software
    ratio: 0.982
    count: 2351
  - kind: filename_pattern
    weight: 0.2
    domain: content
    name: seo-content-engine.json
  - kind: filename_pattern
    weight: 0.2
    domain: content
    name: seo-growth.md
---
# Murage agent notes

Before claiming a server or conversation change works, follow
[`docs/verification/README.md`](docs/verification/README.md). Always launch an
isolated fixture; never verify mutations against the user's live app or data.

More specific `AGENTS.md` files override this note within their directories.

<!-- IJFW-MEMORY-START -->
Project memory at .ijfw/memory/. Call `ijfw_memory_prelude` for full context.
<!-- IJFW-MEMORY-END -->

<!-- IJFW-AGENTS-START -->
No project agents yet. Run `ijfw team` to set them up.
<!-- IJFW-AGENTS-END -->
