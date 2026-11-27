import { useState, type FormEvent } from "react";
import { t } from "@/lib/i18n";
import type { McpBridge } from "@/lib/mcp-bridge";

export function McpOwnAppForm({ name, save }: { name: string; save: McpBridge["useOwnApp"] }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [app, setApp] = useState<{ redirectUri: string; tokenHost: string }>();

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const clientId = String(fields.get("clientId") ?? "");
    const clientSecret = String(fields.get("clientSecret") ?? "");
    form.reset();
    setError("");
    setBusy(true);
    try {
      const result = await save(name, { clientId, ...(clientSecret ? { clientSecret } : {}) });
      if (result.ok) setApp({ redirectUri: result.redirectUri, tokenHost: result.tokenHost });
      else setError(result.message);
    } catch {
      setError(t("mcp.ownApp.saveFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="mt-3 text-[12.5px] text-ink-secondary">
      <summary className="cursor-pointer text-accent-text">{t("mcp.ownApp.open")}</summary>
      {app && (
        <div role="status" className="mt-2 break-all">
          <p>{t("mcp.ownApp.redirect", { host: app.tokenHost })}</p>
          <code className="select-all">{app.redirectUri}</code>
        </div>
      )}
      <form onSubmit={(event) => void submit(event)} className="mt-2 space-y-2" autoComplete="off">
        <label className="block">
          <span className="block">{t("mcp.ownApp.clientId")}</span>
          <input name="clientId" required disabled={busy} className="w-full rounded border border-hairline bg-inset p-2 text-ink" />
        </label>
        <label className="block">
          <span className="block">{t("mcp.ownApp.optionalValue")}</span>
          <input name="clientSecret" type="password" autoComplete="new-password" disabled={busy} className="w-full rounded border border-hairline bg-inset p-2 text-ink" />
        </label>
        <button type="submit" disabled={busy} className="rounded border border-hairline bg-raised px-3 py-2 text-ink">
          {busy ? t("mcp.card.saving") : t("mcp.ownApp.save")}
        </button>
        {error && <p role="alert" className="text-danger">{error}</p>}
      </form>
    </details>
  );
}
