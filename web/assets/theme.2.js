// Runs before first paint: applies the viewer's saved skin + mode so there is no colour flash.
(function () {
  var skin = "mint";
  var mode = "auto";
  try {
    skin = localStorage.getItem("floss.skin") || skin;
    mode = localStorage.getItem("floss.mode") || mode;
  } catch (e) {}
  var root = document.documentElement;
  root.dataset.skin = skin;
  var dark = mode === "auto" ? !window.matchMedia("(prefers-color-scheme: light)").matches : mode === "dark";
  root.dataset.theme = dark ? "dark" : "light";
})();
