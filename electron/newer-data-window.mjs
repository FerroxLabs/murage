// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one screen a start ends on when the data was saved by a newer Murage (shared/data-version-marker.mjs NEWER_DATA_CODES). It says what
// to install and offers the download page and Quit; nothing else. The restore page is never the answer here: nothing is damaged, and a
// restore would put older data in place of newer data. An inert window (no preload, no node, no app origin), like the start-up splash:
// its two buttons tell the shell through the page title.
import { MURAGE_DOWNLOAD_URL } from "../shared/data-version-marker.mjs";
import { memoryUpgradeLocale } from "./memory-upgrade-status.mjs";

export const NEWER_DATA_TEXT = Object.freeze({
  en: { title: "Murage needs a newer version", named: "Your Murage data was saved by a newer version. Install Murage {version} or newer to open it. Your data is safe and unchanged.", latest: "Your Murage data was saved by a newer version. Install the latest version of Murage to open it. Your data is safe and unchanged.", download: "Download Murage", quit: "Quit" },
  de: { title: "Murage braucht eine neuere Version", named: "Deine Murage-Daten wurden von einer neueren Version gespeichert. Installiere Murage {version} oder neuer, um sie zu öffnen. Deine Daten sind sicher und unverändert.", latest: "Deine Murage-Daten wurden von einer neueren Version gespeichert. Installiere die neueste Version von Murage, um sie zu öffnen. Deine Daten sind sicher und unverändert.", download: "Murage herunterladen", quit: "Beenden" },
  es: { title: "Murage necesita una versión más reciente", named: "Tus datos de Murage se guardaron con una versión más reciente. Instala Murage {version} o una posterior para abrirlos. Tus datos están a salvo y sin cambios.", latest: "Tus datos de Murage se guardaron con una versión más reciente. Instala la versión más reciente de Murage para abrirlos. Tus datos están a salvo y sin cambios.", download: "Descargar Murage", quit: "Salir" },
  fr: { title: "Murage a besoin d'une version plus récente", named: "Tes données Murage ont été enregistrées par une version plus récente. Installe Murage {version} ou une version plus récente pour les ouvrir. Tes données sont en sécurité et inchangées.", latest: "Tes données Murage ont été enregistrées par une version plus récente. Installe la dernière version de Murage pour les ouvrir. Tes données sont en sécurité et inchangées.", download: "Télécharger Murage", quit: "Quitter" },
  hi: { title: "Murage का नया संस्करण चाहिए", named: "आपका Murage डेटा एक नए संस्करण ने सहेजा था। इसे खोलने के लिए Murage {version} या उससे नया संस्करण इंस्टॉल करें। आपका डेटा सुरक्षित है और बदला नहीं गया है।", latest: "आपका Murage डेटा एक नए संस्करण ने सहेजा था। इसे खोलने के लिए Murage का नवीनतम संस्करण इंस्टॉल करें। आपका डेटा सुरक्षित है और बदला नहीं गया है।", download: "Murage डाउनलोड करें", quit: "बंद करें" },
  ja: { title: "新しいバージョンの Murage が必要です", named: "Murage のデータは新しいバージョンで保存されています。開くには Murage {version} 以降をインストールしてください。データは安全で、変更されていません。", latest: "Murage のデータは新しいバージョンで保存されています。開くには最新バージョンの Murage をインストールしてください。データは安全で、変更されていません。", download: "Murage をダウンロード", quit: "終了" },
  pt: { title: "O Murage precisa de uma versão mais nova", named: "Seus dados do Murage foram salvos por uma versão mais nova. Instale o Murage {version} ou mais recente para abri-los. Seus dados estão seguros e sem alterações.", latest: "Seus dados do Murage foram salvos por uma versão mais nova. Instale a versão mais recente do Murage para abri-los. Seus dados estão seguros e sem alterações.", download: "Baixar o Murage", quit: "Sair" },
  zh: { title: "需要更新版本的 Murage", named: "你的 Murage 数据由更新的版本保存。请安装 Murage {version} 或更高版本来打开它。你的数据安全无损，没有任何改动。", latest: "你的 Murage 数据由更新的版本保存。请安装最新版本的 Murage 来打开它。你的数据安全无损，没有任何改动。", download: "下载 Murage", quit: "退出" },
});

/** The screen's sentence: the version to install when one is known (newer than this build), else the latest version. */
export function newerDataSentence(language, version) {
  const text = NEWER_DATA_TEXT[memoryUpgradeLocale(language)];
  return version ? text.named.replace("{version}", version) : text.latest;
}

const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const TITLE_ACTION = /^murage-newer-data:(download|quit)(?::\d+)?$/;

export function newerDataPage({ language, version, dark = false }) {
  const code = memoryUpgradeLocale(language), text = NEWER_DATA_TEXT[code];
  const [bg, fg, muted, accent, accentFg] = dark ? ["#16171a", "#f2f2f3", "#3a3b40", "#e8e8ea", "#16171a"] : ["#f7f7f8", "#1b1c1f", "#d4d5d9", "#1b1c1f", "#ffffff"];
  return `<!doctype html><html lang="${code}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>Murage</title><style>
body{margin:0;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:${bg};color:${fg};display:flex;min-height:100vh;align-items:center;justify-content:center}
main{max-width:440px;padding:28px}h1{font-size:19px;margin:0 0 12px}p{margin:0 0 22px}
button{font:inherit;border-radius:8px;padding:8px 16px;margin-right:8px;cursor:pointer;border:1px solid ${muted};background:transparent;color:${fg}}
button.primary{background:${accent};color:${accentFg};border-color:${accent}}
</style></head><body><main><h1>${escape(text.title)}</h1><p>${escape(newerDataSentence(language, version))}</p>
<button class="primary" id="download">${escape(text.download)}</button><button id="quit">${escape(text.quit)}</button></main>
<script>let n=0;for(const id of ["download","quit"])document.getElementById(id).addEventListener("click",()=>{document.title="murage-newer-data:"+id+":"+(++n);});</script>
</body></html>`;
}

/** Open the screen. `onQuit` runs on Quit and when the window is closed: the start is over, and Murage ends rather than trying again. */
export function openNewerDataWindow({ BrowserWindow, openExternal, language, version = null, dark = false, icon, onQuit }) {
  const win = new BrowserWindow({
    width: 520, height: 320, resizable: false, maximizable: false, fullscreenable: false, center: true, show: true, title: "Murage",
    backgroundColor: dark ? "#16171a" : "#f7f7f8", ...(icon ? { icon } : {}),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.on("page-title-updated", (event, title) => {
    const action = TITLE_ACTION.exec(String(title))?.[1];
    if (!action) return;
    try { event?.preventDefault?.(); } catch { /* cosmetic */ }
    if (action === "download") { try { void Promise.resolve(openExternal(MURAGE_DOWNLOAD_URL)).catch(() => {}); } catch { /* the page stays */ } }
    else { try { onQuit?.(); } catch { /* the window close still ends the app */ } }
  });
  win.on("close", () => { try { onQuit?.(); } catch { /* as above */ } });
  void Promise.resolve(win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(newerDataPage({ language, version, dark }))}`)).catch(() => {});
  return { window: win };
}
