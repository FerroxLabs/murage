const title = document.querySelector("h1");
return title ? Math.round(title.getBoundingClientRect().top) : -1;
