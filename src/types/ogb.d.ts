// The narrow bridge the Electron preload exposes. Absent in the browser.
export {};

declare global {
  interface Window {
    ogb?: {
      platform: string;
      screenFrame(): Promise<string | null>;
      speechStart(): Promise<void>;
      speechStop(): Promise<void>;
      onSpeechTranscript(
        cb: (line: { partial?: boolean; text?: string; error?: string }) => void,
      ): () => void;
      onSpeechEnd(cb: (info: { code: number | null }) => void): () => void;
    };
  }
}
