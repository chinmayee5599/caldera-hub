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
    var add = document.getElementById("invited-add"); if (add) add.href = "obsidian://caldera?friend=" + encodeURIComponent(h);
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
/* invites + groups survive the trip to "Sign up with GitHub": ?invite=<handle> / ?group=<slug> are kept for 30 days */
(function () {
  var qs = new URLSearchParams(location.search), keep = {};
  ["invite", "group"].forEach(function (k) {
    var v = (qs.get(k) || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 31);
    try { if (v) localStorage.setItem("cal_" + k, JSON.stringify({ v: v, t: Date.now() })); var s = JSON.parse(localStorage.getItem("cal_" + k) || "null");
      if (s && Date.now() - s.t < 30 * 864e5) keep[k] = s.v; } catch (e) { if (v) keep[k] = v; }
  });
  if (!keep.invite && !keep.group) return;
  document.querySelectorAll('a[href^="/auth/github"]').forEach(function (a) {
    var u = new URL(a.getAttribute("href"), location.origin);
    Object.keys(keep).forEach(function (k) { u.searchParams.set(k, keep[k]); });
    a.setAttribute("href", u.pathname + u.search);
  });
})();
/* homepage: people who joined this week */
(function () {
  var box = document.getElementById("newcomers"), list = document.getElementById("nc-list"); if (!box || !list) return;
  fetch("/v1/directory?sort=new").then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
    if (!d) return;
    var wk = Date.now() - 7 * 864e5, fresh = (d.profiles || []).filter(function (p) { return Date.parse(p.created) > wk; });
    if (!fresh.length) return;
    fresh.slice(0, 8).forEach(function (p) {
      var a = document.createElement("a"); a.className = "nc"; a.href = "/@" + p.handle + "/";
      if (p.avatar) { var im = document.createElement("img"); im.src = p.avatar; im.alt = ""; im.loading = "lazy"; a.appendChild(im); }
      else { var i = document.createElement("span"); i.className = "nc-i"; i.textContent = (p.name || p.handle).trim().charAt(0).toUpperCase(); a.appendChild(i); }
      var t = document.createElement("span"), b = document.createElement("b"), s = document.createElement("small");
      b.textContent = p.name || "@" + p.handle; var hl = (p.headline || "").trim(); if (hl.replace(/^@/, "").toLowerCase() === p.handle.toLowerCase()) hl = "";   // a headline that's just the handle again
      s.textContent = "@" + p.handle + (hl ? " \u00b7 " + hl : "");
      t.appendChild(b); t.appendChild(s); a.appendChild(t); list.appendChild(a);
    });
    document.getElementById("nc-count").textContent = fresh.length + (fresh.length === 1 ? " person joined" : " people joined");
    box.hidden = false;
  }).catch(function () {});
})();

/* account menu: when this browser is signed in to Caldera, "Sign in" in the nav becomes @handle with Your page / Private view / Sign out */
(function () {
  var link = document.querySelector('.nav nav a[href="/signin"]'); if (!link || !window.fetch) return;
  fetch("/v1/session", { credentials: "same-origin", cache: "no-store" }).then(function (r) { return r.ok ? r.json() : null; }).then(function (s) {
    if (!s || !s.signedIn) return;
    var d = document.createElement("details"); d.className = "nav-acct";
    var sum = document.createElement("summary"); sum.textContent = "@" + s.handle + " \u25BE"; d.appendChild(sum);
    var m = document.createElement("span"); m.className = "nav-menu";
    [["Your public page", s.page], ["Private view", s["private"], s.privateExternal], ["Sign out", s.signout]].forEach(function (x) {
      var a = document.createElement("a"); a.textContent = x[0]; a.href = x[1]; if (x[2]) { a.target = "_blank"; a.rel = "noopener"; } m.appendChild(a); });
    d.appendChild(m); link.replaceWith(d);
    if (s.messages) {   // Messages, with the unread count, next to the account menu
      var ml = document.createElement("a"); ml.href = s.messages.url || "/messages"; ml.className = "nav-msgs"; ml.textContent = "Messages";
      if (s.messages.unread) { var bd = document.createElement("span"); bd.className = "nav-badge"; bd.textContent = s.messages.unread > 9 ? "9+" : String(s.messages.unread); ml.appendChild(bd); ml.setAttribute("aria-label", "Messages, " + s.messages.unread + " unread"); }
      d.before(ml);
    }
    var cta = document.querySelector('.nav > a.btn'); if (cta && s.page) { cta.textContent = "Your page"; cta.href = s.page; }   // signed in: the header button goes to your page
  }).catch(function () {});
})();
