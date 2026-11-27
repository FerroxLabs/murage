import { connect, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { connect as connectTls } from "node:tls";

type Endpoint = { host: string; name: string; ca: Buffer };

export class Wire {
  readonly reader;
  readonly lines;
  readonly socket: Socket;

  constructor(socket: Socket) {
    this.socket = socket;
    socket.setTimeout(5000, () => socket.destroy(new Error("Fixture wire timed out")));
    this.reader = createInterface({ input: socket, crlfDelay: Infinity });
    this.lines = this.reader[Symbol.asyncIterator]();
  }

  async next() {
    const result = await this.lines.next();
    if (result.done) throw new Error("Fixture wire ended before the reply");
    return result.value;
  }

  async reply(last: RegExp) {
    const lines: string[] = [];
    while (true) {
      const line = await this.next();
      lines.push(line);
      if (last.test(line)) return lines.join("\n");
    }
  }

  write(data: string | Buffer) {
    this.socket.write(data);
  }

  async smtp(command: string) {
    this.write(`${command}\r\n`);
    return this.reply(/^\d{3} /);
  }

  async imap(tag: string, command: string) {
    this.write(`${tag} ${command}\r\n`);
    return this.reply(new RegExp(`^${tag} `));
  }

  startTls(endpoint: Endpoint) {
    this.reader.close();
    return new Wire(connectTls({ socket: this.socket, servername: endpoint.name, ca: endpoint.ca }));
  }

  close() {
    this.reader.close();
    this.socket.destroy();
  }
}

export function openWire(endpoint: Endpoint, port: number, secure = false) {
  return new Wire(secure
    ? connectTls({ host: endpoint.host, port, servername: endpoint.name, ca: endpoint.ca })
    : connect({ host: endpoint.host, port }));
}
