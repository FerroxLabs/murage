import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Check } from "lucide-react";
import { identifyEmail, setEmailGateDone, track } from "@/lib/analytics";
import { useDesktopSurface } from "@/lib/use-surface";
import { api, useStore } from "@/state/store";
import { EngineSetup } from "./EngineSetup";
import { ProviderMark } from "./ProviderIcons";
import { StarterProfiles } from "./StarterProfiles";
import { ONBOARDING_CHOICES, ONBOARDING_PROGRESS_KEY, readOnboardingProgress, type OnboardingChoice } from "@/lib/onboarding-progress";

export function Onboarding({ onDone }: { onDone: () => void }) {
  const desktop = useDesktopSurface();
  const { state, dispatch } = useStore();
  const [saved] = useState(() => { try { return readOnboardingProgress(window.localStorage); } catch { return { choice: null, instanceId: "", model: "" }; } });
  const [choice, setChoice] = useState<OnboardingChoice | null>(saved.choice);
  const [instanceId, setInstanceId] = useState(saved.instanceId);
  const [model, setModel] = useState(saved.model);
  const [step, setStep] = useState(saved.choice ? 1 : 0);
  const [workspace, setWorkspace] = useState<"checking" | "empty" | "established" | "error">("checking");
  const [checking, setChecking] = useState(false);
  const [engineError, setEngineError] = useState("");
  const [details, setDetails] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileError, setProfileError] = useState("");
  const saveActive = useRef(false);
  const done = useRef(onDone); done.current = onDone;
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
  const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";
  const button = "min-h-11 rounded-lg px-4 py-2.5 text-[14px] font-medium disabled:opacity-40 " + focus;
  const finish = () => {
    try { localStorage.removeItem(ONBOARDING_PROGRESS_KEY); } catch { /* workspace admission prevents a repeat */ }
    setEmailGateDone("submitted"); track("onboarding_completed", { starter: choice ?? "empty" }); done.current();
  };
  const checkWorkspace = async () => {
    setWorkspace("checking");
    try {
      const value = await api("/api/bots?messages=0");
      if (!Array.isArray(value.bots) || !Array.isArray(value.groups)) throw new Error("Workspace not confirmed");
      if (value.bots.length || value.groups.length) { setWorkspace("established"); setEmailGateDone("submitted"); done.current(); }
      else setWorkspace("empty");
    } catch { setWorkspace("error"); }
  };
  useEffect(() => { if (desktop === true) void checkWorkspace(); }, [desktop]);
  useEffect(() => {
    if (workspace !== "empty") return;
    try { localStorage.setItem(ONBOARDING_PROGRESS_KEY, JSON.stringify({ choice, instanceId, model })); } catch { /* no import is retried automatically */ }
  }, [choice, instanceId, model, workspace]);
  const refreshEngines = async () => {
    setChecking(true); setEngineError("");
    try { const value = await api("/api/instances"); if (!Array.isArray(value.instances)) throw new Error("Engine check was not confirmed."); dispatch({ type: "instances", instances: value.instances }); }
    catch (cause) { setEngineError(cause instanceof Error ? cause.message : "Could not check engines."); }
    finally { setChecking(false); }
  };
  useEffect(() => { if (step === 1 && workspace === "empty") void refreshEngines(); }, [step, workspace]);
  const saveProfile = async () => {
    if (!valid || saveActive.current) return;
    saveActive.current = true; setProfileSaving(true); setProfileError("");
    const profile = { name: name.trim(), email: email.trim().toLowerCase() };
    try {
      const result = await api("/api/config", { method: "PUT", body: JSON.stringify({ profile }) });
      if (result?.profile?.name !== profile.name || result?.profile?.email !== profile.email) throw new Error("Your profile save could not be confirmed. Please retry, or choose Maybe later.");
      identifyEmail(profile.email); void api("/api/subscribe", { method: "POST", body: JSON.stringify(profile) }).catch(() => {}); setDetails(false);
    } catch (cause) { setProfileError(cause instanceof Error ? cause.message : "Could not save your profile. Please retry."); }
    finally { saveActive.current = false; setProfileSaving(false); }
  };
  const selected = state.instances.find(instance => instance.instanceId === instanceId);
  const ready = selected?.snapshot.state === "available" && (selected.access === "custom" || selected.snapshot.authenticated !== false);
  const modelReady = ready && Boolean(model) && selected.models.options.some(option => option.id === model);
  if (desktop !== true || workspace === "established" || state.appSettingsOpen) return null;
  return <div className="fixed inset-x-0 top-0 z-50 flex h-[var(--vvh,100dvh)] items-center justify-center bg-app p-8 max-md:p-4">
    <main aria-label="Set up your workspace" className="flex max-h-full w-full max-w-[620px] flex-col overflow-y-auto rounded-2xl border border-hairline/40 bg-panel p-8 max-md:p-5">
      {workspace === "checking" ? <p role="status" className="text-ink-secondary">Checking your workspace…</p> : workspace === "error" ? <>
        <h1 className="text-xl font-semibold text-ink">Could not check your workspace</h1><p role="alert" className="mt-2 text-sm text-ink-secondary">Reconnect and try again before creating a crew.</p><button className={button + " mt-4 bg-control text-ink"} onClick={() => void checkWorkspace()}>Check again</button>
      </> : <>
        {step > 0 && <button className={button + " mb-3 flex w-fit items-center gap-2 px-0 text-ink-secondary"} onClick={() => setStep(step - 1)}><ArrowLeft size={16} />Back</button>}
        {step === 0 && <>
          <p className="text-[12px] font-medium text-accent">WELCOME TO MURAGE</p><h1 className="mt-2 text-[26px] font-semibold leading-tight text-ink">What would you like to do?</h1><p className="mt-2 text-[14px] leading-relaxed text-ink-secondary">Start with a small crew and one useful task. You can change everything later.</p>
          <div className="mt-5 grid gap-2.5" aria-label="Choose your first outcome">{ONBOARDING_CHOICES.map(item => <button key={item.id} className={"rounded-xl border border-hairline/50 bg-card p-4 text-left hover:bg-control " + focus} onClick={() => { setChoice(item.id); setStep(1); }}><span className="block text-[15px] font-semibold text-ink">{item.title}</span><span className="mt-1 block text-[13px] leading-relaxed text-ink-secondary">{item.detail}</span></button>)}</div>
          <div className="mt-4 flex flex-wrap gap-2"><button className={button + " bg-control text-ink"} onClick={finish}>Start empty</button><button className={button + " text-ink-secondary"} onClick={() => { dispatch({ type: "showTeamLibrary", view: "teams" }); finish(); }}>Import existing</button></div>
          <p className="mt-3 text-[12px] leading-relaxed text-ink-secondary">Import existing opens the library, where you can choose a file and review its contents. Local memory is on for new workspaces; you can pause it in Settings. Permissions and account connections are requested when you need them.</p>
          {!details ? <button className={button + " mt-2 w-fit px-0 text-ink-secondary"} onClick={() => setDetails(true)}>Add your details (optional)</button> : <div className="mt-4 border-t border-hairline/40 pt-4">
            <p className="text-[13px] text-ink-secondary">Save your name and receive product updates.</p>
            <input aria-label="Your name" placeholder="Your name" value={name} disabled={profileSaving} onChange={event => setName(event.target.value)} className="mt-3 min-h-11 w-full rounded-lg border border-hairline/40 bg-inset px-3 text-ink" />
            <input aria-label="Email" type="email" placeholder="you@example.com" value={email} disabled={profileSaving} onChange={event => setEmail(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void saveProfile(); } }} className="mt-2 min-h-11 w-full rounded-lg border border-hairline/40 bg-inset px-3 text-ink" />
            <button className={button + " mt-3 bg-accent text-accent-ink"} disabled={!valid || profileSaving} onClick={() => void saveProfile()}>{profileSaving ? "Saving…" : "Continue"}</button><button className={button + " ml-2 text-ink-secondary"} disabled={profileSaving} onClick={() => setDetails(false)}>Maybe later</button>{profileError && <p role="alert" className="mt-2 text-sm text-danger">{profileError}</p>}
          </div>}
        </>}
        {step === 1 && <>
          <h1 className="text-[22px] font-semibold text-ink">Choose an engine</h1><p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">Fuigo is included with Murage. Choose it or another installed engine, then choose a model. Account access and model pricing depend on that choice.</p><p className="mt-2 text-[12px] text-ink-secondary">No credentials are copied and no paid fallback is enabled by this setup.</p>
          {checking && <p role="status" className="mt-3 text-sm text-ink-secondary">Checking engines…</p>}
          <div className="mt-4 grid gap-2" aria-label="Choose an engine">{state.instances.filter(instance => instance.enabled !== false).map(instance => <button key={instance.instanceId} aria-pressed={instanceId === instance.instanceId} className={"flex items-center gap-3 rounded-xl border p-3 text-left " + (instanceId === instance.instanceId ? "border-accent bg-accent/5 " : "border-hairline/50 bg-card ") + focus} onClick={() => { setInstanceId(instance.instanceId); setModel(""); }}><ProviderMark driverKind={instance.driverKind} size={20} /><span className="flex-1 text-sm text-ink">{instance.displayName}{instance.driverKind === "fuigoAgent" && <> <span className="ml-2 text-xs text-ink-secondary">Included</span></>}</span>{instanceId === instance.instanceId && <Check size={16} className="text-accent" />}</button>)}</div>
          {selected && (!ready || !selected.models.options.length) && <EngineSetup instance={selected} intent={selected.access === "custom" ? "inject" : "cloud"} />}
          {ready && selected.models.options.length > 0 && <label className="mt-4 text-sm font-medium text-ink">Model<select aria-label="Model" className="mt-2 min-h-11 w-full rounded-lg border border-hairline/50 bg-inset px-3 text-ink" value={model} onChange={event => setModel(event.target.value)}><option value="">Choose a model</option>{selected.models.options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>}
          {engineError && <p role="alert" className="mt-3 text-sm text-danger">{engineError}</p>}{!state.instances.length && !checking && <button className={button + " mt-3 bg-control text-ink"} onClick={() => void refreshEngines()}>Check engines again</button>}
          <button className={button + " mt-5 bg-accent text-accent-ink"} disabled={!modelReady || checking} onClick={() => setStep(2)}>Preview my crew</button>
        </>}
        {step === 2 && choice && modelReady && <StarterProfiles initialProfileId={choice} modelSelection={{ instanceId, model }} onFirstTask={finish} />}
        {step === 2 && !modelReady && <><p role="alert" className="text-sm text-ink-secondary">Your selected engine needs another check before creating the crew.</p><button className={button + " mt-3 bg-control text-ink"} onClick={() => setStep(1)}>Check engine</button></>}
      </>}
    </main>
  </div>;
}
