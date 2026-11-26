// Settings v10 route mount (owner: core). index.ts calls handleSettingsV10Route once, in the owner API chain, before the
// bot access route. Each lane registers its routes from its own module (stubs seated by core; the lane named on each
// register line owns that module). A route returns true when it answered.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store } from "../store.ts";
import type { AppConfig } from "../config.ts";
import type { Surface } from "../sse-visibility.ts";

export interface SettingsV10RouteContext {
  method: string;
  path: string;
  url: URL;
  req: IncomingMessage;
  res: ServerResponse;
  json: (res: ServerResponse, status: number, body: unknown) => unknown;
  readBody: (req: IncomingMessage) => Promise<any>;
  store: Store;
  cfg: AppConfig;
  /** Request surface (requestSurface in index.ts): phone projections must refuse desktop-only rows. */
  surface: Surface;
}
export type SettingsV10Route = (ctx: SettingsV10RouteContext) => Promise<boolean> | boolean;

export class SettingsV10Router {
  private readonly routes: { owner: string; route: SettingsV10Route }[] = [];
  add(owner: string, route: SettingsV10Route): void { this.routes.push({ owner, route }); }
  owners(): string[] { return this.routes.map((entry) => entry.owner); }
  async handle(ctx: SettingsV10RouteContext): Promise<boolean> {
    for (const { route } of this.routes) if (await route(ctx)) return true;
    return false;
  }
}
