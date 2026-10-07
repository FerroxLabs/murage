// First run, step two: "Type the code instead" on Get your code ready (or
// "Type the address instead" on the scanner's problem screens), then the
// address, the code, and Connect.
const find = (label) => [...document.querySelectorAll("button")].find((b) => b.textContent === label);
const wait = () => new Promise((resolve) => setTimeout(resolve, 300));
let type;
for (let i = 0; i < 60 && !type; i++) {
  type = [...document.querySelectorAll("button")].find((b) => b.textContent.startsWith("Type the "));
  if (!type) await wait();
}
if (!type) return "no typing offered";
type.click();
await wait();
const address = document.querySelector("input[name=address]");
const code = document.querySelector("input[name=code]");
if (!address || !code) return "no pairing form";
address.value = args.address;
code.value = args.code;
find("Connect").click();
return "submitted";
