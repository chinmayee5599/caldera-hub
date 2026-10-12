/* copyPrompt */
document.querySelectorAll("[data-copy]").forEach(function (b) {
  var pre = document.getElementById(b.getAttribute("data-copy"));
  var label = b.querySelector(".copy-label");
  b.addEventListener("click", function () {
    var done = function () { b.classList.add("is-copied"); label.textContent = "Copied"; setTimeout(function () { b.classList.remove("is-copied"); label.textContent = "Copy prompt"; }, 2000); };
    var fallback = function () { window.getSelection().selectAllChildren(pre); label.textContent = "Press Cmd/Ctrl+C"; };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(pre.innerText).then(done, fallback); else fallback();
  });
});
document.querySelectorAll("[data-lines]").forEach(function (m) {
  var pre = document.getElementById(m.getAttribute("data-lines"));
  m.textContent = " \u00b7 " + pre.innerText.split("\n").length + " lines";
});
document.querySelectorAll(".prompt-expand").forEach(function (b) {
  b.addEventListener("click", function () {
    var body = b.closest(".prompt-body"), open = body.classList.toggle("is-collapsed") === false;
    b.textContent = open ? "Collapse" : "Show the full prompt"; b.setAttribute("aria-expanded", String(open));
  });
});
/* invite: caldera.social/?invite=<handle> greets the friend with who invited them */
(function () {
  var box = document.getElementById("invited"); if (!box) return;
  var h = (new URLSearchParams(location.search).get("invite") || "").toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (!h) return;
  fetch("v1/profiles/" + h).then(function (r) { return r.ok ? r.json() : null; }).then(function (p) {
    if (!p) return;
    document.getElementById("invited-name").textContent = p.name || "@" + h;
    document.getElementById("invited-handle").textContent = "@" + h;
    var av = p.manifest && p.manifest.body && p.manifest.body.photos && p.manifest.body.photos.avatar;
    var img = document.getElementById("invited-av");
    if (av) img.src = "@" + h + "/" + String(av).replace(/^\.?\//, ""); else img.remove();
    var g = (p.manifest && p.manifest.body && p.manifest.body.garden) || [];
    var gb = document.getElementById("invited-garden");
    if (gb && g.length) {
      g = g.slice().sort(function (a, b) { return String(b.updated).localeCompare(String(a.updated)); });
      var icon = { seedling: "\uD83C\uDF31", budding: "\uD83C\uDF3F", evergreen: "\uD83C\uDF33" };
      gb.appendChild(document.createTextNode("From their garden: "));
      g.slice(0, 3).forEach(function (n, i) {
        if (!/^[a-z0-9-]+$/.test(n.slug || "")) return;
        if (i) gb.appendChild(document.createTextNode(" \u00b7 "));
        var a = document.createElement("a"); a.href = "@" + h + "/n/" + n.slug + ".html";
        a.textContent = (icon[n.stage] ? icon[n.stage] + " " : "") + String(n.title || n.slug); gb.appendChild(a);
      });
      var all = document.createElement("a"); all.href = "@" + h + "/garden.html"; all.className = "all";
      all.textContent = g.length > 3 ? "all " + g.length + " notes \u2192" : "walk the garden \u2192";
      gb.appendChild(document.createTextNode(" ")); gb.appendChild(all);
      gb.hidden = false;
    }
    box.hidden = false;
  }).catch(function () {});
})();
