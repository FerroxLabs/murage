# WhatsApp release qualification

Run these gates against each packaged artifact, after staging. They consume existing artifacts; they do not install dependencies.

1. `node scripts/whatsapp-inventory.mjs /artifact/resources/server --check` verifies the bridge size and SHA-256 plus the complete staged closure against the lockfile, copied licence files, exclusions and `third_party/baileys/advisory.json`. Missing artifacts or pending advisory review fail the command.
2. `pnpm smoke:whatsapp-packaged --server-directory /artifact/resources/server --runtime /artifact/Murage --platform linux --arch x64 --electron-version VERSION` forks the packaged bridge through its staged supervisor with Electron run-as-Node, a temporary home and data directory, and no socket. Require a successful exit and retain its JSON result, including OS, architecture, Electron version, Baileys version and Jimp JPEG check. Set the target platform and architecture explicitly and take VERSION from the lockfile-installed Electron package. Spawn errors fail immediately; cleanup has its own deadline.

3. After stapling, archive creation and stable-named copies, run `node scripts/bind-whatsapp-artifacts.mjs REPORT.json ARTIFACT...` for each target report. This rewrites the report with final artifact names and SHA-256 hashes. Reports and probe diagnostics upload even when a gate fails.

The release workflow requires both gates after packaging and before upload for every target, and retains the probe reports as required qualification artifacts. Run both gates for Linux x64, macOS arm64, macOS x64 and Windows x64 as a standard user. Retain one JSON probe report per artifact with the artifact hash. An absent target report means that target is not qualified. The probe is separate from the live spare-number qualification described by the design.
