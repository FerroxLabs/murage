/** Bind successful responses synchronously, before the transport dispatches the next frame. */
export async function openAcpSession(options: {
  method: 'session/new' | 'session/load';
  params: object;
  sessionId(): string | null;
  bind(id: string | null): void;
  owner?: { sessionId: string | null };
  request(receive: (result: any) => void): Promise<any>;
  receive(result: any): void;
  check(result: any): void;
  policyFailure(error: unknown): unknown;
}): Promise<any> {
  const previous = options.sessionId();
  const previousOwner = options.owner?.sessionId ?? null;
  const bind = (id: string | null) => {
    options.bind(id);
    if (options.owner) options.owner.sessionId = id;
  };
  try {
    const result = await options.request(result => {
      if (options.method === 'session/new' && typeof result?.sessionId === 'string') bind(result.sessionId);
      if (options.method === 'session/load' && result) bind((options.params as { sessionId: string }).sessionId);
      options.receive(result);
    });
    options.check(result);
    return result;
  } catch (error) {
    options.bind(previous);
    if (options.owner) options.owner.sessionId = previousOwner;
    throw options.policyFailure(error) ?? error;
  }
}
