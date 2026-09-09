import { useEffect, useRef, useState } from "react";
import { AUDIO_FORMATS, audioTranscriptionMime } from "@/lib/audio-intake";
import { formatSize } from "@/lib/composer-attachments";
import { noteForReason, postClip } from "./PushToTalk";

export function AudioAttachmentIntake({ file, configured, onAddTranscript, onRemove, onSettings }: {
  file: File; configured: boolean; onAddTranscript: (text: string) => void; onRemove: () => void; onSettings: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [transcript, setTranscript] = useState<string | null>(null);
  const [error, setError] = useState("");
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; active.current?.abort(); }; }, []);
  const transcribe = async () => {
    if (active.current || !configured || transcript !== null) return;
    const controller = new AbortController(); active.current = controller; setBusy(true); setError("");
    try {
      const mime = audioTranscriptionMime(file);
      const result = await postClip(file.slice(0, file.size, mime), undefined, controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      if (!result.text.trim()) throw new Error("No speech was returned. The original file is unchanged.");
      setTranscript(result.text);
    } catch (cause) {
      if (mounted.current) setError(noteForReason((cause as { reason?: string }).reason, cause instanceof Error ? cause.message : "Could not transcribe audio."));
    } finally { if (active.current === controller) active.current = null; if (mounted.current) setBusy(false); }
  };
  const button = "min-h-11 rounded-lg px-3 py-2 text-[12px] font-medium disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";
  return <section aria-label="Audio transcription" className="mb-3 rounded-xl border border-hairline/50 bg-card p-3 text-ink">
    <p className="break-words text-[13px] font-semibold">{file.name}</p><p className="mt-1 text-[12px] text-ink-secondary">{formatSize(file.size)} · {AUDIO_FORMATS} · up to 4 MiB</p>
    {transcript === null ? <>
      <p className="mt-2 text-[12px] leading-relaxed text-ink-secondary">Transcription sends this audio to Flux and its transcription provider and uses your Flux credits. Review the text before adding it to your draft. Your chat engine stays unchanged.</p>
      {!configured && <p role="status" className="mt-2 text-[12px] text-ink-secondary">Add a Flux key in engine settings before transcribing. Nothing has been uploaded.</p>}
      <div className="mt-3 flex flex-wrap gap-2"><button type="button" disabled={busy || !configured} onClick={() => void transcribe()} className={button + " bg-control text-ink"}>{busy ? "Transcribing…" : "Transcribe with Flux (uses credits)"}</button>
        {busy ? <button type="button" className={button + " text-ink-secondary"} onClick={() => active.current?.abort()}>Cancel transcription</button> : <button type="button" className={button + " text-ink-secondary"} onClick={onRemove}>Remove audio</button>}
        {!configured && <button type="button" className={button + " text-ink-secondary"} onClick={onSettings}>Open engine settings</button>}</div>
    </> : <>
      <label className="mt-3 block text-[12px] font-medium">Review transcript<textarea aria-label="Review transcript" value={transcript} onChange={event => setTranscript(event.target.value)} rows={4} className="mt-2 w-full resize-y rounded-lg border border-hairline/50 bg-inset p-2 text-[13px] text-ink" /></label>
      <p className="mt-1 text-[12px] text-ink-secondary">Add this as an editable text attachment. Existing text and attachments are kept; nothing is sent yet.</p>
      <div className="mt-2 flex gap-2"><button type="button" disabled={!transcript.trim()} className={button + " bg-control text-ink"} onClick={() => { onAddTranscript(transcript); onRemove(); }}>Add transcript to draft</button><button type="button" className={button + " text-ink-secondary"} onClick={onRemove}>Discard transcript</button></div>
    </>}
    {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
  </section>;
}
