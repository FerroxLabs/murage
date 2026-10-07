// First run, step one: the welcome's "Yes, let's connect", which shows
// "Get your code ready" (no scanner yet). type-pairing.js does the rest.
const yes = [...document.querySelectorAll("button")].find((b) => b.textContent === "Yes, let's connect");
if (!yes) return "no welcome";
yes.click();
return "tapped";
