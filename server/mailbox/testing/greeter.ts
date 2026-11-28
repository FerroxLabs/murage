import { mkdtempSync } from "node:fs";
import { safeWipeSync } from "../../testing/safe-wipe.mjs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createServer as createTlsServer } from "node:tls";
import { assertIsolated, certificates, host, name } from "./mail-server.ts";

export const greeterVariants = ["ntlm-only", "gssapi-only", "starttls-fails", "plaintext-on-tls-port",
  "tls10-only", "tls11-only", "cram-only", "digest-only"] as const;
type GreeterVariant = typeof greeterVariants[number];
const mechanisms: Partial<Record<GreeterVariant, string>> = {
  "ntlm-only": "NTLM", "gssapi-only": "GSSAPI", "cram-only": "CRAM-MD5", "digest-only": "DIGEST-MD5",
};

export async function startGreeter(variant: GreeterVariant, protocol: "imap" | "smtp") {
  assertIsolated();
  if (!greeterVariants.includes(variant)) throw new Error("Unknown mail greeter variant");
  const directory = mkdtempSync(join(tmpdir(), "mail-greeter-"));
  const sockets = new Set<Socket>();
  const received: Buffer[] = [];
  try {
    const identity = certificates(directory);
    const mechanism = mechanisms[variant];
    const oldVersion = variant === "tls10-only" ? "TLSv1" : variant === "tls11-only" ? "TLSv1.1" : undefined;
    const handle = (socket: Socket) => {
      socket.on("data", chunk => received.push(Buffer.from(chunk)));
      const lines = createInterface({ input: socket, crlfDelay: Infinity });
      socket.write(protocol === "imap" ? "* OK Fixture IMAP\r\n" : "220 Fixture SMTP\r\n");
      lines.on("line", line => {
        const [first, second] = line.split(" ");
        if (protocol === "imap") {
          if (/^CAPABILITY$/i.test(second)) {
            const cap = mechanism ? `AUTH=${mechanism}` : "STARTTLS LOGINDISABLED";
            socket.write(`* CAPABILITY IMAP4rev1 ${cap}\r\n${first} OK CAPABILITY\r\n`);
          } else {
            socket.end(`${first} NO Fixture command refused\r\n`);
          }
        } else if (/^EHLO$/i.test(first)) {
          const cap = mechanism ? `AUTH ${mechanism}` : "STARTTLS";
          socket.write(`250-Fixture SMTP\r\n250 ${cap}\r\n`);
        } else {
          socket.end("454 Fixture command refused\r\n");
        }
      });
    };

    const plaintext = variant === "starttls-fails" || variant === "plaintext-on-tls-port";
    const server = plaintext
      ? createServer(handle)
      : createTlsServer({
        ...identity, minVersion: oldVersion ?? "TLSv1.2", maxVersion: oldVersion,
        ...(oldVersion && { ciphers: "DEFAULT:@SECLEVEL=0" }),
      }, handle);
    server.on("connection", socket => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
    });
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, host, () => {
        const address = server.address();
        if (!address || typeof address === "string") return reject(new Error("Greeter port unavailable"));
        resolve(address.port);
      });
    });
    return {
      host, name, ca: identity.ca, port,
      received: () => Buffer.concat(received),
      async close() {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>(resolve => server.close(() => resolve()));
        safeWipeSync(directory);
      },
    };
  } catch (error) {
    safeWipeSync(directory);
    throw error;
  }
}
