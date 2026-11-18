# dbus-next bundle input lock

This standalone npm manifest and v3 lockfile define the dependency tree used by
`pnpm build:dbus-next`. The generator copies both files into a fresh temporary
directory and runs `npm ci --ignore-scripts --no-audit --no-fund`; it does not
resolve fresh transitive ranges. npm verifies the lockfile's tarball integrity.
Optional native install scripts are disabled. esbuild comes from the repository's
separate committed pnpm lock.

To deliberately update this input lock, edit the exact dependency version and run
`npm install --package-lock-only --ignore-scripts --no-audit --no-fund --prefix scripts/dbus-next`.
Review that lock change, regenerate the bundle, inspect its diff, and update the
recorded bundle SHA-256 together. Do not commit node_modules or an npm cache.

The initial locked regeneration reproduces the shipped bundle SHA-256
`c358b8f9177695c41c2f5b5b1b5894f21c35fe9b0be0d982858488e939c43c60`.
This lock uses npm integrity hashes; it does not claim independently mirrored
tarballs or replace the broader dependency-source policy.
