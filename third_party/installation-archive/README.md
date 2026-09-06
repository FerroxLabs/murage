# Installation archive components

The archive writer and inspector use MIT-licensed streaming ZIP libraries:

- yazl 3.3.1 — https://github.com/thejoshwolfe/yazl
- yauzl 3.4.0 — https://github.com/thejoshwolfe/yauzl
- buffer-crc32 1.0.0 — https://github.com/brianloveswords/buffer-crc32
- pend 1.2.0 — https://github.com/andrewrk/node-pend

Exact package resolution and integrity hashes are in pnpm-lock.yaml. License
texts copied from those installed packages are included in this directory
and shipped in the desktop distribution's licenses/installation-archive.

Murage performs its own manifest, path, size, entry type and SHA-256 checks;
the libraries do not establish application restore safety on their own.
