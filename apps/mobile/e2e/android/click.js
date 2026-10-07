for (let i = 0; i < 40; i++) {
  const button = [...document.querySelectorAll("button")].find((b) => b.textContent === args.label);
  if (button) {
    button.click();
    return "clicked";
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}
throw new Error(`no button "${args.label}"`);
