// Lays out one big link per href, stacked mid-screen, and returns each one's
// centre in device pixels relative to the WebView, for `adb shell input tap`
// (a real tap, so the WebView sees a user gesture).
document.querySelectorAll("a[data-p26]").forEach((node) => node.remove());
const out = [];
args.hrefs.forEach((href, index) => {
  const link = document.createElement("a");
  link.dataset.p26 = String(index);
  link.href = href;
  link.textContent = `p26 link ${index}`;
  link.style.cssText = `position:fixed;left:10%;width:80%;height:56px;top:${200 + index * 90}px;z-index:2147483647;background:#ff6b35;color:#000;display:block;font:20px sans-serif`;
  document.body.appendChild(link);
  const rect = link.getBoundingClientRect();
  out.push([Math.round((rect.left + rect.width / 2) * devicePixelRatio), Math.round((rect.top + rect.height / 2) * devicePixelRatio)]);
});
return out;
