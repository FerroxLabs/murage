// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { useEffect, useState } from "react";
import { usableMcpBridge, type McpBridge } from "./mcp-bridge";

/** `ready` is false until the shell has said which mode it is in, so nothing is
 * sent before we know whether a value may ride the body. */
export function useMcpBridge(): { bridge: McpBridge | undefined; ready: boolean } {
  const [state, setState] = useState<{ bridge: McpBridge | undefined; ready: boolean }>({ bridge: undefined, ready: false });
  useEffect(() => {
    let live = true;
    void usableMcpBridge().then((bridge) => { if (live) setState({ bridge, ready: true }); });
    return () => { live = false; };
  }, []);
  return state;
}
