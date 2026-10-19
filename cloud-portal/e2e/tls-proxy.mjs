// HTTPS front for the journey: WebAuthn and the __Host- cookie need a secure origin.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), ".tls");
mkdirSync(dir, { recursive: true });
const key = path.join(dir, "key.pem"), cert = path.join(dir, "cert.pem");
if (!existsSync(cert)) {
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "2",
    "-keyout", key, "-out", cert, "-subj", "/CN=cloud.murage.test", "-addext", "subjectAltName=DNS:cloud.murage.test"], { stdio: "ignore" });
}
const target = Number(process.env.PORTAL_PORT ?? 3000);
https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
  const upstream = http.request({ host: "127.0.0.1", port: target, method: req.method, path: req.url,
    headers: { ...req.headers, "x-forwarded-host": req.headers.host, "x-forwarded-proto": "https" } }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res);
  });
  upstream.on("error", () => { res.writeHead(502); res.end(); });
  req.pipe(upstream);
}).listen(Number(process.env.TLS_PORT ?? 3443), "127.0.0.1");
