// CONNECTING ONE ACCOUNT, FROM ANYWHERE.
//
// The flow itself is not new: authorize, open the provider's page in the
// real browser, then watch the connector status until it turns. What is new
// is that it is a module rather than three closures inside the connected
// apps dialog (src/components/PluginsPanel.tsx), because the first run asks
// for exactly this from inside a chat message and a card cannot reach into
// a modal's state to borrow it.
//
// Everything that touches the world is an argument: the request function,
// the external open, the clock. That is what makes a browserless test of
// this possible, and a browserless test is the only kind this repository
// runs.

/** As `/api/connectors?services=…` reports one service. A subset of the
 *  dialog's own `ConnectorStatus`: this module reads only what it needs to
 *  decide whether to keep waiting. */
export interface ConnectAppStatus {
  connected: boolean;
  pending?: boolean;
  status?: string;
}

export interface ConnectAppOptions {
  /** The app's `api` helper, or a fake. */
  request: (path: string, init?: RequestInit) => Promise<any>;
  /** Hand the authorization URL to the real browser. */
  openExternal: (url: string) => Promise<void>;
  /**
   * Whether this is the desktop app.
   *
   * The same guard PluginsPanel applies (`if (desktop !== true) return`) and
   * for the same reason: authorizing writes a credential into the machine's
   * secure store, which a paired phone's view of this workspace has no
   * business doing. Undecided is not permission, so anything but `true`
   * refuses.
   */
  desktop: boolean | null;
  /** How long between status reads, and how many. The dialog polls every
   *  five seconds for two minutes; the card inherits that. */
  pollIntervalMs?: number;
  attempts?: number;
  /** Injectable sleep, so a test does not wait two real minutes. */
  wait?: (ms: number) => Promise<void>;
  /** Stop polling early, for a card that has left the screen. */
  cancelled?: () => boolean;
}

export const CONNECT_APP_DESKTOP_ONLY = "Connect this from Murage on your computer.";
export const CONNECT_APP_NO_URL = "That app did not give us a connection page. Try it again in a moment.";

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_ATTEMPTS = 24;

/** A status that has stopped moving, either way. `expired` and `failed` are
 *  the provider's own words for a page that was opened and abandoned. */
export function connectAppSettled(status: ConnectAppStatus | undefined): boolean {
  if (!status) return false;
  if (status.connected && !status.pending) return true;
  return Boolean(status.status && /^(expired|failed)$/i.test(status.status));
}

/** Read the status of one service. Never throws: a status read that fails is
 *  a reason to look again, not a reason to fail the connection that may well
 *  be succeeding in the browser. */
export async function readConnectAppStatus(
  slug: string,
  request: ConnectAppOptions["request"],
): Promise<ConnectAppStatus | undefined> {
  try {
    const body = await request(`/api/connectors?services=${encodeURIComponent(slug)}`);
    const service = body?.services?.[slug];
    if (!service || typeof service !== "object") return undefined;
    return {
      connected: Boolean(service.connected),
      ...(service.pending === undefined ? {} : { pending: Boolean(service.pending) }),
      ...(typeof service.status === "string" ? { status: service.status } : {}),
    };
  } catch {
    return undefined;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Connect one named app, start to finish.
 *
 * Resolves with the last status this saw: connected when the person
 * finished in the browser, and an unfinished one when the wait ran out. An
 * unfinished connection is NOT an error. The person may still be typing
 * their password into the provider's page, and a card that announced a
 * failure over their shoulder while they did would be wrong and rude.
 * Only a refused authorize throws.
 */
export async function connectApp(slug: string, options: ConnectAppOptions): Promise<ConnectAppStatus> {
  if (options.desktop !== true) throw new Error(CONNECT_APP_DESKTOP_ONLY);
  const authorized = await options.request(`/api/connectors/${encodeURIComponent(slug)}/authorize`, { method: "POST" });
  const url = typeof authorized?.url === "string" ? authorized.url : "";
  if (!url) throw new Error(CONNECT_APP_NO_URL);
  await options.openExternal(url);

  const interval = options.pollIntervalMs ?? DEFAULT_INTERVAL_MS;
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const pause = options.wait ?? sleep;
  let last: ConnectAppStatus = { connected: false, pending: true, status: "INITIATED" };
  for (let tries = 0; tries < attempts; tries += 1) {
    if (options.cancelled?.()) return last;
    await pause(interval);
    if (options.cancelled?.()) return last;
    const status = await readConnectAppStatus(slug, options.request);
    if (status) last = status;
    if (connectAppSettled(status)) return last;
  }
  return last;
}
