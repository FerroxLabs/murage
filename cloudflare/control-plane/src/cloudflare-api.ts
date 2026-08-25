import { z } from "zod";

import type { ControlPlaneConfig } from "./config";

const API_BASE = "https://api.cloudflare.com/client/v4/";
const API_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 512 * 1024;

const tunnelSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(256),
  config_src: z.literal("cloudflare"),
  deleted_at: z.string().nullable().optional(),
});

const dnsRecordSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(255),
  type: z.literal("CNAME"),
  content: z.string().min(1).max(255),
  proxied: z.boolean(),
});

const configurationSchema = z.object({
  config: z.object({
    ingress: z.array(z.object({
      hostname: z.string().optional(),
      service: z.string(),
    })).min(1),
  }),
});

const errorEnvelopeSchema = z.object({
  errors: z.array(z.object({ code: z.number().int().optional() })).optional(),
  success: z.boolean(),
});

const connectorTokenSchema = z.string().min(20).max(4_096).regex(/^[\x21-\x7e]+$/);

export type CloudflareFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface CloudflareTunnel {
  id: string;
  name: string;
}

export interface CloudflareDNSRecord {
  content: string;
  id: string;
  name: string;
  proxied: boolean;
}

export class CloudflareAPIError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "CloudflareAPIError";
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof CloudflareAPIError
    && (error.code === "cf_http_404" || error.code === "cf_api_81044");
}

async function boundedResponseText(response: Response): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_RESPONSE_BYTES) {
      throw new CloudflareAPIError("cf_invalid_response");
    }
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new CloudflareAPIError("cf_invalid_response");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CloudflareAPIError("cf_invalid_response");
  }
}

function providerErrorCode(value: unknown, status: number): string {
  const envelope = errorEnvelopeSchema.safeParse(value);
  const providerCode = envelope.success
    ? envelope.data.errors?.find((error) => error.code !== undefined)?.code
    : undefined;
  if (providerCode !== undefined && providerCode >= 0 && providerCode <= 999_999) {
    return `cf_api_${providerCode}`;
  }
  return `cf_http_${status}`;
}

export class CloudflareAPI {
  constructor(
    private readonly config: ControlPlaneConfig["cloudflare"],
    private readonly fetcher: CloudflareFetch,
  ) {}

  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    init: { body?: unknown; method?: string } = {},
  ): Promise<T> {
    const headers = new Headers({
      accept: "application/json",
      authorization: `Bearer ${this.config.apiToken}`,
    });
    let body: string | undefined;
    if (init.body !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.body);
    }

    let response: Response;
    try {
      response = await this.fetcher(new URL(path, API_BASE), {
        body,
        headers,
        method: init.method ?? "GET",
        redirect: "error",
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new CloudflareAPIError("cf_timeout");
      }
      throw new CloudflareAPIError("cf_network");
    }

    const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (mediaType !== "application/json") {
      if (!response.ok) throw new CloudflareAPIError(`cf_http_${response.status}`);
      throw new CloudflareAPIError("cf_invalid_response");
    }

    const text = await boundedResponseText(response);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new CloudflareAPIError(response.ok ? "cf_invalid_response" : `cf_http_${response.status}`);
    }

    const envelope = errorEnvelopeSchema.safeParse(value);
    if (!response.ok || !envelope.success || !envelope.data.success) {
      throw new CloudflareAPIError(providerErrorCode(value, response.status));
    }
    if (!value || typeof value !== "object" || !("result" in value)) {
      throw new CloudflareAPIError("cf_invalid_response");
    }
    const result = schema.safeParse(value.result);
    if (!result.success) throw new CloudflareAPIError("cf_invalid_response");
    return result.data;
  }

  async listTunnels(name: string): Promise<CloudflareTunnel[]> {
    const query = new URLSearchParams({ is_deleted: "false", name, per_page: "2" });
    const tunnels = await this.request(
      `accounts/${encodeURIComponent(this.config.accountId)}/cfd_tunnel?${query}`,
      z.array(tunnelSchema),
    );
    const exact = tunnels.filter((tunnel) => tunnel.name === name && tunnel.deleted_at == null);
    return exact.map(({ id, name: tunnelName }) => ({ id, name: tunnelName }));
  }

  async createTunnel(name: string): Promise<CloudflareTunnel> {
    const tunnel = await this.request(
      `accounts/${encodeURIComponent(this.config.accountId)}/cfd_tunnel`,
      tunnelSchema,
      { body: { config_src: "cloudflare", name }, method: "POST" },
    );
    if (tunnel.name !== name) {
      throw new CloudflareAPIError("cf_invalid_response");
    }
    return { id: tunnel.id, name: tunnel.name };
  }

  async configureTunnel(tunnelId: string, hostname: string): Promise<void> {
    const result = await this.request(
      `accounts/${encodeURIComponent(this.config.accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`,
      configurationSchema,
      {
        body: {
          config: {
            ingress: [
              { hostname, service: "http://127.0.0.1:8810" },
              { service: "http_status:404" },
            ],
          },
        },
        method: "PUT",
      },
    );
    const ingress = result.config.ingress;
    if (
      ingress.length !== 2
      || ingress[0]?.hostname !== hostname
      || ingress[0]?.service !== "http://127.0.0.1:8810"
      || ingress[1]?.hostname !== undefined
      || ingress[1]?.service !== "http_status:404"
    ) {
      throw new CloudflareAPIError("cf_invalid_response");
    }
  }

  async listDNSRecords(hostname: string): Promise<CloudflareDNSRecord[]> {
    const query = new URLSearchParams({
      "name.exact": hostname,
      per_page: "2",
      type: "CNAME",
    });
    const records = await this.request(
      `zones/${encodeURIComponent(this.config.zoneId)}/dns_records?${query}`,
      z.array(dnsRecordSchema),
    );
    return records
      .filter((record) => record.name.toLowerCase() === hostname)
      .map(({ content, id, name, proxied }) => ({ content, id, name, proxied }));
  }

  async createDNSRecord(hostname: string, tunnelId: string): Promise<CloudflareDNSRecord> {
    return this.writeDNSRecord("POST", hostname, tunnelId);
  }

  async updateDNSRecord(recordId: string, hostname: string, tunnelId: string): Promise<CloudflareDNSRecord> {
    return this.writeDNSRecord("PATCH", hostname, tunnelId, recordId);
  }

  private async writeDNSRecord(
    method: "PATCH" | "POST",
    hostname: string,
    tunnelId: string,
    recordId?: string,
  ): Promise<CloudflareDNSRecord> {
    const target = `${tunnelId}.cfargotunnel.com`;
    const suffix = recordId ? `/${encodeURIComponent(recordId)}` : "";
    const record = await this.request(
      `zones/${encodeURIComponent(this.config.zoneId)}/dns_records${suffix}`,
      dnsRecordSchema,
      {
        body: { content: target, name: hostname, proxied: true, ttl: 1, type: "CNAME" },
        method,
      },
    );
    if (
      record.name.toLowerCase() !== hostname
      || record.content.toLowerCase() !== target
      || !record.proxied
    ) {
      throw new CloudflareAPIError("cf_invalid_response");
    }
    return { content: record.content, id: record.id, name: record.name, proxied: record.proxied };
  }

  async getConnectorToken(tunnelId: string): Promise<string> {
    return this.request(
      `accounts/${encodeURIComponent(this.config.accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/token`,
      connectorTokenSchema,
    );
  }

  async deleteDNSRecord(recordId: string): Promise<void> {
    try {
      await this.request(
        `zones/${encodeURIComponent(this.config.zoneId)}/dns_records/${encodeURIComponent(recordId)}`,
        z.unknown(),
        { method: "DELETE" },
      );
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  async deleteTunnel(tunnelId: string): Promise<void> {
    try {
      await this.request(
        `accounts/${encodeURIComponent(this.config.accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}`,
        z.unknown(),
        { method: "DELETE" },
      );
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}
