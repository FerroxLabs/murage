// A form posted to another origin: shouldOverrideUrlLoading never sees a POST,
// so onPageStarted must stop it and this document must stay.
window.__p26mark = args.mark;
const form = document.createElement("form");
form.method = "post";
form.action = "https://example.com/";
const field = document.createElement("input");
field.name = "p26";
field.value = "1";
form.appendChild(field);
document.body.appendChild(form);
setTimeout(() => form.submit(), 100);
return "posting";
