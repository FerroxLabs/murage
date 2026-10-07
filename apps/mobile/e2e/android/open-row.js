// The launcher's list: open the first saved computer.
for (let i = 0; i < 40; i++) {
  const row = document.querySelector("button.row-main:not([disabled])");
  if (row) {
    row.click();
    return "opened";
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}
throw new Error("no saved computer on the list");
