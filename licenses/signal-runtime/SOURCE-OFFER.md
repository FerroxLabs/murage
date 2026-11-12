# Signal runtime corresponding source

Murage distributes Signal CLI with a manifest-only Class-Path addition, unmodified dependency jars and the
unmodified Eclipse Temurin JRE images identified in runtime-pin.json and
scripts/signal-java-inputs.json. The build and normalization scripts are in
scripts/build-signal-runtime-inputs.sh, scripts/normalize-signal-runtime.mjs and
scripts/signal-jar-layout.py. The manifest patch allows the existing java -jar
launcher to locate the 50 dependencies in lib/; class bytes are unchanged.

Corresponding source, build instructions and licence terms:

- signal-cli 0.14.11-SNAPSHOT, GPL-3.0: https://github.com/AsamK/signal-cli/tree/48a0a5e90cb0c36153f0276c0affff090e588290
- signal-network and sibling modules 2.15.3_unofficial_157, GPL-3.0: https://github.com/Turasa/libsignal-service-java/tree/6d6f87d5722a369caac59444b692ce9e8f0fdb8d (tag v2.15.3_unofficial_157).
- libsignal-client 0.106.1, AGPL-3.0: https://github.com/signalapp/libsignal/tree/v0.106.1. All three JNI libraries come directly from the pinned upstream jar.
- Eclipse Temurin 25.0.5+8-LTS, GPL-2.0 with Classpath Exception: https://github.com/adoptium/temurin25-binaries/releases/tag/jdk-25.0.5%2B8. Corresponding OpenJDK source: https://github.com/adoptium/jdk25u/tree/jdk-25.0.5%2B8_adopt and the OpenJDK25U-jdk-sources_25.0.5_8.tar.gz asset of that release.
- Each remaining jar's exact Maven coordinate, declared licences, resolved POM chain, jar hash, and embedded notices appear in manifest.json. The retained POMs include upstream source/SCM links; the exact version in each coordinate identifies its source release.

All licence and notice files in this directory accompany every platform package.
The Temurin legal directory is also retained intact in each runtime image.
This source-access notice does not replace any licence text or grant additional rights.

Rebuild on Linux using the pinned Temurin build JDK; no macOS or Windows compiler
is used. Build installDist at the full signal-cli commit above, normalize the
51 jars, extract the target JNI entry, and pack with sorted paths, epoch mtimes,
numeric owner/group zero and gzip without timestamps. Per-platform JRE archive
hashes are committed; foreign JRE executables are never run during assembly.
Release verifies rebuilt archive hashes against the committed runtime pin.

Assembly container: node:24-bookworm@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4. Both the manual and release builders use this image so Python, zlib, GNU tar and gzip match the reviewed assembly toolchain.
