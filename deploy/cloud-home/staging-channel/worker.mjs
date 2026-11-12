// SPDX-License-Identifier: AGPL-3.0-or-later
// STAGING ONLY. The signed release channel a staging Cloud home updates from: https://murage-staging-releases.sean-874.workers.dev/cloud-home
// (the pin RELEASE_CHANNEL_URL_staging in deploy/cloud-home/image-release-check.sh). It serves exactly what murage-commands update_software
// fetches, from the R2 bucket bound as RELEASES, and nothing else:
//   GET /cloud-home/<arch>/manifest.json
//   GET /cloud-home/<arch>/manifest.json.sig
//   GET /cloud-home/<arch>/murage-cloud-home-<sequence>.tar.gz
// <arch> is x86_64 or aarch64. The object key is the request path without its leading slash. The home refuses redirects and proxies, so every
// answer is a plain 200 with the bytes, or a 404. The files are public and carry no secret: the home trusts the Ed25519 signature over the
// manifest (and the manifest's digests over the archive), never this host. Nothing here signs, lists, writes or deletes.
const NAME = /^\/cloud-home\/(x86_64|aarch64)\/(manifest\.json|manifest\.json\.sig|murage-cloud-home-[1-9][0-9]{0,8}\.tar\.gz)$/;

export default {
  async fetch(request, env) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    }
    const url = new URL(request.url);
    if (url.search || !NAME.test(url.pathname)) return new Response("not found", { status: 404 });
    const key = url.pathname.slice(1);
    const object = request.method === "HEAD" ? await env.RELEASES.head(key) : await env.RELEASES.get(key);
    if (!object) return new Response("not found", { status: 404 });
    const headers = {
      "content-type": "application/octet-stream",
      "content-length": String(object.size),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    };
    return new Response(request.method === "HEAD" ? null : object.body, { status: 200, headers });
  },
};
