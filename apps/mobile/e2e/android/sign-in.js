// Inside the Murage app, /enter signs in by itself (first run: MurageApp/ UA
// plus installId), so the page may already be leaving: no button is a pass.
const go = document.getElementById("go");
if (!go) return "auto";
for (let i = 0; i < 40 && go.hidden; i++) await new Promise((resolve) => setTimeout(resolve, 250));
if (!document.contains(go)) return "auto";
go.click();
return "clicked";
