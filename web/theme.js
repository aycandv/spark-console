/* Sets the theme before first paint. An external file, because the CSP forbids inline scripts. */
(function () {
  var t = "auto";
  try { t = localStorage.getItem("sc-theme") || "auto"; } catch (e) { /* private mode */ }
  if (t !== "dark" && t !== "light") t = "auto";
  var root = document.documentElement;
  root.setAttribute("data-theme", t);
  if (t !== "auto") {
    var c = t === "dark" ? "#141619" : "#e9ebee";
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i++) metas[i].setAttribute("content", c);
  }
})();
