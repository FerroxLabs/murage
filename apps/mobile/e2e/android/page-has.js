for (let i = 0; i < 60; i++) {
  if (document.body && document.body.innerText.includes(args.text)) return true;
  await new Promise((resolve) => setTimeout(resolve, 500));
}
return false;
