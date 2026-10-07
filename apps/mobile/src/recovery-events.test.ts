import { describe, expect, it, vi } from "vitest";
import { listenForRecovery } from "./recovery-events";

function fixture() {
  const page = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const network = new EventTarget();
  let online = true;
  const recover = vi.fn();
  const dispose = listenForRecovery(page, network, () => online, recover);
  const emit = (target: EventTarget, event: string) => target.dispatchEvent(new Event(event));
  return { page, network, recover, dispose, emit, online: (value: boolean) => { online = value; } };
}

describe("RES-010: recovery event edges", () => {
  it("recovers once for duplicate online events, then again for another offline/online change", () => {
    const f = fixture();
    for (let i = 1; i <= 2; i++) {
      f.online(false); f.emit(f.network, "offline");
      f.online(true); f.emit(f.network, "online"); f.emit(f.network, "online");
      expect(f.recover).toHaveBeenCalledTimes(i);
    }
  });
  it("coalesces visibility and Capacitor resume, in either order", () => {
    const f = fixture();
    for (const first of ["resume", "visibilitychange"]) {
      f.page.visibilityState = "hidden"; f.emit(f.page, "visibilitychange"); f.emit(f.page, "pause");
      f.page.visibilityState = "visible";
      f.emit(f.page, first); f.emit(f.page, first === "resume" ? "visibilitychange" : "resume");
    }
    expect(f.recover).toHaveBeenCalledTimes(2);
  });
  it("does not recover offline or hidden, recovers on foreground, and removes listeners", () => {
    const f = fixture();
    f.page.visibilityState = "hidden"; f.emit(f.page, "visibilitychange");
    f.online(false); f.emit(f.network, "offline");
    f.online(true); f.emit(f.network, "online");
    expect(f.recover).not.toHaveBeenCalled();
    f.page.visibilityState = "visible"; f.emit(f.page, "resume");
    expect(f.recover).toHaveBeenCalledTimes(1);
    f.dispose();
    f.emit(f.page, "pause"); f.emit(f.page, "resume");
    f.emit(f.network, "offline"); f.emit(f.network, "online");
    expect(f.recover).toHaveBeenCalledTimes(1);
  });
});
