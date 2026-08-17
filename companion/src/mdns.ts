// mDNS / DNS-SD advertisement, so a phone finds this computer without
// anyone typing an IP address.
//
// Written out rather than pulled in: the responder half of mDNS is a DNS
// message encoder, a multicast socket, and a table of which questions we
// answer — and the alternative is a dependency tree under the process that
// holds the user's API keys and runs their agents. The house rule (don't
// take a dependency where code will do) points the same way.
//
// Scope is deliberately the *responder* half of RFC 6762/6763 and no more:
// we answer questions about our own service and announce ourselves. We do
// not browse, and we do not probe for name conflicts before claiming a name
// (§8.1) — the host record we claim is derived from a hash of the machine's
// hostname, so a collision needs two machines with the same hostname on one
// network, and the cost of that is a duplicate row in a picker rather than
// anything broken.
import { createHash } from "node:crypto";
import { createSocket, type Socket } from "node:dgram";
import { hostname } from "node:os";

import { lanAddresses } from "./listener.ts";

const MDNS_ADDRESS = "224.0.0.251";
const MDNS_PORT = 5353;
/** RFC 6762 §10: host records are short-lived, service records are not. */
const TTL_HOST = 120;
const TTL_SERVICE = 4500;
/** RFC 6762 §11 — multicast DNS must not be routed off the link. */
const MULTICAST_TTL = 255;

export const TYPE = { A: 1, PTR: 12, TXT: 16, SRV: 33, ANY: 255 } as const;
const CLASS_IN = 1;
/** Top bit of a record's class: "this replaces whatever you cached." */
const FLUSH = 0x8000;
/** Top bit of a question's class: "answer me directly, not to the group." */
const QU = 0x8000;
/** The meta-query browsers use to enumerate service types on a network. */
export const SERVICE_ENUMERATION = "_services._dns-sd._udp.local";

// ── wire format ────────────────────────────────────────────────────────

export interface Question {
  name: string;
  type: number;
  /** the QU bit — the asker wants a unicast reply */
  unicast: boolean;
}

export interface DnsMessage {
  id: number;
  /** true for a response; we ignore those, we are not a browser */
  response: boolean;
  questions: Question[];
}

/** A record we can answer with. `ResourceRecord`, not `Record` — the latter
 * is TypeScript's own utility type and shadowing it reads terribly. */
export type ResourceRecord =
  | { name: string; type: 1; data: string }
  | { name: string; type: 12; data: string }
  | { name: string; type: 16; data: string[] }
  | { name: string; type: 33; data: { port: number; target: string } };

/** A DNS name as length-prefixed labels, NUL-terminated (RFC 1035 §3.1). */
export function encodeName(name: string): Buffer {
  const chunks: Buffer[] = [];
  for (const label of name.split(".").filter(Boolean)) {
    const bytes = Buffer.from(label, "utf8");
    if (bytes.length > 63) throw new Error(`label longer than 63 bytes: ${label}`);
    chunks.push(Buffer.from([bytes.length]), bytes);
  }
  chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

/** Read a name, following compression pointers. Returns the offset just
 * past the name *as written here*, which is not where a followed pointer
 * ended up. */
function decodeName(buf: Buffer, start: number): { name: string; offset: number } {
  const labels: string[] = [];
  let pos = start;
  let end = start;
  let jumped = false;
  let hops = 0;

  for (;;) {
    if (pos >= buf.length) throw new Error("truncated name");
    const length = buf[pos];
    if (length === 0) {
      if (!jumped) end = pos + 1;
      break;
    }
    if ((length & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) throw new Error("truncated pointer");
      const target = ((length & 0x3f) << 8) | buf[pos + 1];
      if (!jumped) end = pos + 2;
      jumped = true;
      // a packet is free to point at itself; we are not free to follow it
      if (++hops > 16) throw new Error("compression pointer loop");
      pos = target;
      continue;
    }
    const from = pos + 1;
    if (from + length > buf.length) throw new Error("truncated label");
    labels.push(buf.toString("utf8", from, from + length));
    pos = from + length;
    if (!jumped) end = pos;
  }
  return { name: labels.join("."), offset: end };
}

/** Parse an inbound packet, or null if it is not one we can read. Every
 * byte here arrived from the local network unauthenticated, so a malformed
 * packet must be a `null`, never a throw into the socket handler. */
export function decodeMessage(buf: Buffer): DnsMessage | null {
  try {
    if (buf.length < 12) return null;
    const id = buf.readUInt16BE(0);
    const flags = buf.readUInt16BE(2);
    const questionCount = buf.readUInt16BE(4);
    const questions: Question[] = [];
    let offset = 12;
    for (let i = 0; i < questionCount; i++) {
      const decoded = decodeName(buf, offset);
      offset = decoded.offset;
      if (offset + 4 > buf.length) return null;
      const type = buf.readUInt16BE(offset);
      const klass = buf.readUInt16BE(offset + 2);
      offset += 4;
      questions.push({ name: decoded.name, type, unicast: (klass & QU) !== 0 });
    }
    return { id, response: (flags & 0x8000) !== 0, questions };
  } catch {
    return null;
  }
}

/** One resource record on the wire. `ttlOverride` is how a goodbye packet
 * retracts a record without building a different one: same bytes, TTL 0. */
function encodeRecord(record: ResourceRecord, ttlOverride?: number): Buffer {
  let rdata: Buffer;
  let ttl: number;
  switch (record.type) {
    case TYPE.A: {
      const octets = record.data.split(".").map(Number);
      if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
        throw new Error(`not an IPv4 address: ${record.data}`);
      }
      rdata = Buffer.from(octets);
      ttl = TTL_HOST;
      break;
    }
    case TYPE.PTR:
      rdata = encodeName(record.data);
      ttl = TTL_SERVICE;
      break;
    case TYPE.TXT: {
      const entries = record.data.map((entry) => {
        const bytes = Buffer.from(entry, "utf8");
        if (bytes.length > 255) throw new Error(`TXT entry longer than 255 bytes: ${entry}`);
        return Buffer.concat([Buffer.from([bytes.length]), bytes]);
      });
      // an empty TXT record is one zero-length string, never zero bytes
      rdata = entries.length ? Buffer.concat(entries) : Buffer.from([0]);
      ttl = TTL_SERVICE;
      break;
    }
    case TYPE.SRV: {
      const header = Buffer.alloc(6);
      header.writeUInt16BE(0, 0); // priority
      header.writeUInt16BE(0, 2); // weight
      header.writeUInt16BE(record.data.port, 4);
      rdata = Buffer.concat([header, encodeName(record.data.target)]);
      ttl = TTL_HOST;
      break;
    }
  }

  const name = encodeName(record.name);
  const fixed = Buffer.alloc(10);
  fixed.writeUInt16BE(record.type, 0);
  fixed.writeUInt16BE(CLASS_IN | FLUSH, 2);
  fixed.writeUInt32BE(ttlOverride ?? ttl, 4);
  fixed.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([name, fixed, rdata]);
}

/** A complete mDNS response: header, echoed questions, then the answers. */
export function encodeResponse(
  answers: ResourceRecord[],
  additionals: ResourceRecord[] = [],
  opts: { id?: number; ttl?: number; questions?: Question[] } = {},
): Buffer {
  const questions = opts.questions ?? [];
  const header = Buffer.alloc(12);
  header.writeUInt16BE(opts.id ?? 0, 0);
  header.writeUInt16BE(0x8400, 2); // QR=1 (response), AA=1 (authoritative)
  header.writeUInt16BE(questions.length, 4);
  header.writeUInt16BE(answers.length, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(additionals.length, 10);

  const questionBytes = questions.map((question) => {
    const suffix = Buffer.alloc(4);
    suffix.writeUInt16BE(question.type, 0);
    suffix.writeUInt16BE(CLASS_IN, 2);
    return Buffer.concat([encodeName(question.name), suffix]);
  });

  return Buffer.concat([
    header,
    ...questionBytes,
    ...answers.map((record) => encodeRecord(record, opts.ttl)),
    ...additionals.map((record) => encodeRecord(record, opts.ttl)),
  ]);
}

// ── the service we advertise ───────────────────────────────────────────

export interface ServiceInfo {
  /** human-readable instance name — what a picker on the phone shows */
  name: string;
  /** e.g. "_openmausbot._tcp" */
  type: string;
  port: number;
  /** the name our A records claim, e.g. "openmausbot-1a2b3c4d.local" */
  host: string;
  addresses: string[];
  /** DNS-SD key=value pairs */
  txt: string[];
}

/** Identity for deduping — name, type and payload, deliberately not TTL. */
const recordKey = (record: ResourceRecord) =>
  `${record.name.toLowerCase()}|${record.type}|${JSON.stringify(record.data)}`;

/** Drop repeats and anything already known, keeping order. Sending the same
 * answer twice in one packet is legal and makes a responder look broken. */
function dedupe(records: ResourceRecord[], exclude: ResourceRecord[] = []): ResourceRecord[] {
  const seen = new Set(exclude.map(recordKey));
  const out: ResourceRecord[] = [];
  for (const record of records) {
    const key = recordKey(record);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(record);
  }
  return out;
}

/** The four records that describe the service, as a browser expects them. */
export function serviceRecords(service: ServiceInfo) {
  const serviceName = `${service.type}.local`;
  const instance = `${service.name}.${serviceName}`;
  return {
    serviceName,
    instance,
    ptr: { name: serviceName, type: TYPE.PTR, data: instance } as ResourceRecord,
    srv: {
      name: instance,
      type: TYPE.SRV,
      data: { port: service.port, target: service.host },
    } as ResourceRecord,
    txt: { name: instance, type: TYPE.TXT, data: service.txt } as ResourceRecord,
    addresses: service.addresses.map(
      (address) => ({ name: service.host, type: TYPE.A, data: address }) as ResourceRecord,
    ),
  };
}

/** Everything we shout when we arrive (and, with ttl 0, when we leave). */
export function announcement(service: ServiceInfo): ResourceRecord[] {
  const { ptr, srv, txt, addresses } = serviceRecords(service);
  return [ptr, srv, txt, ...addresses];
}

/** What to answer a query with — the whole protocol decision, kept pure so
 * it can be read and tested without a socket.
 *
 * A PTR question is answered with SRV, TXT and A in the additional section
 * (RFC 6763 §12): browsing then resolves in one round trip instead of three,
 * which is the difference between a picker that fills in instantly and one
 * that looks broken for a second. */
export function answersFor(
  message: DnsMessage,
  service: ServiceInfo,
): { answers: ResourceRecord[]; additionals: ResourceRecord[] } {
  if (message.response) return { answers: [], additionals: [] };
  const { serviceName, instance, ptr, srv, txt, addresses } = serviceRecords(service);
  const answers: ResourceRecord[] = [];
  const additionals: ResourceRecord[] = [];

  for (const question of message.questions) {
    const name = question.name.toLowerCase();
    const asks = (type: number) => question.type === type || question.type === TYPE.ANY;

    if (name === SERVICE_ENUMERATION && asks(TYPE.PTR)) {
      answers.push({ name: SERVICE_ENUMERATION, type: TYPE.PTR, data: serviceName });
    } else if (name === serviceName.toLowerCase() && asks(TYPE.PTR)) {
      answers.push(ptr);
      additionals.push(srv, txt, ...addresses);
    } else if (name === instance.toLowerCase()) {
      if (asks(TYPE.SRV)) {
        answers.push(srv);
        additionals.push(...addresses);
      }
      if (asks(TYPE.TXT)) answers.push(txt);
    } else if (name === service.host.toLowerCase() && asks(TYPE.A)) {
      answers.push(...addresses);
    }
  }

  const deduped = dedupe(answers);
  return { answers: deduped, additionals: dedupe(additionals, deduped) };
}

// ── naming ─────────────────────────────────────────────────────────────

/** One DNS label: no dots (they would split it into two labels), no control
 * characters, and inside the 63-byte limit even in UTF-8. */
export function dnsLabel(text: string, fallback = "OpenMausBot"): string {
  let label = text
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\./g, " ")
    .trim();
  while (Buffer.byteLength(label, "utf8") > 63) label = label.slice(0, -1).trimEnd();
  return label || fallback;
}

/** A host name nothing else on the network claims.
 *
 * Deliberately not `<hostname>.local`: on macOS the system responder owns
 * that name and defends it, and picking a fight with mDNSResponder over the
 * user's own machine name is a bad trade for a companion feature. */
export function defaultHostName(machine = hostname()): string {
  const digest = createHash("sha256").update(machine).digest("hex").slice(0, 8);
  return `openmausbot-${digest}.local`;
}

/**
 * Every IPv4 address worth publishing.
 *
 * This is `lanAddresses()` under a name that says why mDNS wants it. It used
 * to be a second copy of the same filter, which is the kind of duplication
 * that stays correct right up until one side learns about a new interface
 * type and the other does not — and the failure then is a phone that
 * discovers the computer but cannot reach it.
 */
export function advertisableAddresses(): string[] {
  return lanAddresses();
}

// ── the responder ──────────────────────────────────────────────────────

export interface ResponderOptions {
  /** Test rigs bind an ephemeral port and skip the group join; the packet
   * handling below is the same code either way. */
  port?: number;
  multicast?: boolean;
}

export class MdnsResponder {
  private socket: Socket | null = null;
  private service: ServiceInfo | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private readonly port: number;
  private readonly multicast: boolean;

  constructor(options: ResponderOptions = {}) {
    this.port = options.port ?? MDNS_PORT;
    this.multicast = options.multicast ?? true;
  }

  get advertising(): boolean {
    return this.socket !== null;
  }

  /** The bound port — ephemeral ports make this the only way to find it. */
  address(): number | null {
    try {
      return this.socket?.address().port ?? null;
    } catch {
      return null;
    }
  }

  /** Start advertising. Resolves false when mDNS could not start, which is
   * never fatal: pairing by typed address still works, and a companion
   * feature must not take the harness down because port 5353 was busy. */
  async advertise(service: ServiceInfo): Promise<boolean> {
    await this.stop();
    if (!service.addresses.length) return false;

    const socket = createSocket({ type: "udp4", reuseAddr: true });
    // Bind errors arrive as events, and an unhandled 'error' on a socket
    // is an uncaught exception that would take the harness with it.
    socket.on("error", () => void this.stop());
    socket.on("message", (buf, remote) => this.handle(buf, remote.address, remote.port));

    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.bind(this.port, () => resolve());
      });
    } catch {
      try {
        socket.close();
      } catch {
        /* never bound */
      }
      return false;
    }

    if (this.multicast) {
      try {
        socket.setMulticastTTL(MULTICAST_TTL);
      } catch {
        /* not fatal — the default TTL still reaches the local link */
      }
      // Join on each interface explicitly: the default route is not
      // necessarily the network the phone is on.
      let joined = false;
      for (const address of service.addresses) {
        try {
          socket.addMembership(MDNS_ADDRESS, address);
          joined = true;
        } catch {
          /* interface went away, or already joined */
        }
      }
      if (!joined) {
        try {
          socket.addMembership(MDNS_ADDRESS);
        } catch {
          /* no multicast here; announcements below will simply go nowhere */
        }
      }
    }

    this.socket = socket;
    this.service = service;
    // RFC 6762 §8.3: announce more than once, spaced out, because the first
    // packet is the one most likely to be lost.
    for (const delay of [0, 1000, 3000]) {
      const timer = setTimeout(() => this.announce(), delay);
      timer.unref?.();
      this.timers.push(timer);
    }
    return true;
  }

  /** Stop advertising, telling the network to forget us rather than letting
   * the records rot in caches for 75 minutes (RFC 6762 §10.1). */
  async stop(): Promise<void> {
    for (const timer of this.timers.splice(0)) clearTimeout(timer);
    const socket = this.socket;
    const service = this.service;
    this.socket = null;
    this.service = null;
    if (!socket) return;
    if (service) {
      try {
        this.send(socket, encodeResponse(announcement(service), [], { ttl: 0 }));
      } catch {
        /* going away anyway */
      }
    }
    await new Promise<void>((resolve) => {
      try {
        socket.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  private announce() {
    if (!this.socket || !this.service) return;
    try {
      this.send(this.socket, encodeResponse(announcement(this.service)));
    } catch {
      /* the interface may have gone away between timer and send */
    }
  }

  private handle(buf: Buffer, from: string, fromPort: number) {
    if (!this.socket || !this.service) return;
    const message = decodeMessage(buf);
    if (!message || message.response || !message.questions.length) return;
    const { answers, additionals } = answersFor(message, this.service);
    if (!answers.length) return;

    // RFC 6762 §6.7: a query from a port other than 5353 is a legacy
    // resolver, and its reply goes back to that port, echoing the id and
    // the question it asked. The QU bit asks for the same directness.
    const legacy = fromPort !== MDNS_PORT;
    const unicast = legacy || message.questions.some((question) => question.unicast);
    const packet = encodeResponse(
      answers,
      additionals,
      legacy ? { id: message.id, questions: message.questions } : {},
    );
    try {
      if (unicast) this.socket.send(packet, fromPort, from);
      else this.send(this.socket, packet);
    } catch {
      /* a send failure is one lost answer; the asker retries */
    }
  }

  private send(socket: Socket, packet: Buffer) {
    socket.send(packet, this.port, this.multicast ? MDNS_ADDRESS : "127.0.0.1");
  }
}
