/** The exact-call receipt is offered only beside these complete, uncut fields. */
export function BotCallFields({ authority }: { authority: { spec: Record<string, unknown>; effective: unknown; specDigest: string } }) {
  const labels: Record<string, string> = { name: 'Name', role: 'Role', instructions: 'Instructions', section: 'Team', lead: 'Lead', modelSelection: 'Model' };
  return <section data-bot-card-renderer="bot-card@1" className="max-h-[60vh] w-full overflow-y-auto rounded-lg border border-hairline p-4">
    <p className="mb-3">If you Allow, it starts exactly as shown below.</p>
    <dl>{Object.entries(authority.spec).map(([key, value]) => <div key={key} className="my-3"><dt className="font-medium">{labels[key] ?? key}</dt><dd className="whitespace-pre-wrap break-words">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</dd></div>)}</dl>
    <h3 className="font-medium">Settings and saved approvals</h3><pre className="whitespace-pre-wrap break-words font-sans">{JSON.stringify(authority.effective, null, 2)}</pre>
  </section>;
}
