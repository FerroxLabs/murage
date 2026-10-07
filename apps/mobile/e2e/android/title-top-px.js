// The launcher title's top in device pixels, to compare with the status bar inset.
const title = document.querySelector("h1");
return title ? Math.round(title.getBoundingClientRect().top * devicePixelRatio) : -1;
