// Apply the pinned theme before first paint to avoid a flash. A file, not an inline
// script, because the server's Content-Security-Policy forbids inline scripts.
try {
  var t = localStorage.getItem("iv.theme");
  if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
} catch (e) {}
