// Inline scripts for the panel. Plain constants: no server data is ever
// interpolated into script text. They run under the per-response CSP nonce.
// Each one reads the page language from <html lang> (English pages live at the
// root, Turkish ones under /tr) and picks its strings with t(english, turkish).

/** /join: the invite stays in the URL fragment and only goes into the freeband:// link. */
export const JOIN_JS = `
(function () {
  var EN = document.documentElement.lang === "en";
  var P = EN ? "" : "/tr";
  function t(en, tr) { return EN ? en : tr; }
  var m = /(?:^#|&)invite=([^&]+)/.exec(location.hash);
  var code = m ? decodeURIComponent(m[1]).trim() : "";
  var link = document.getElementById("join-link");
  var shown = document.getElementById("join-code");
  if (!code || code.length > 64) {
    shown.textContent = t("not in this link", "bu bağlantıda yok");
    link.hidden = true;
    return;
  }
  shown.textContent = code;
  link.href = "freeband://join?invite=" + encodeURIComponent(code) + "&hub=" + encodeURIComponent(location.origin);
})();
`;

export const LOGIN_JS = `
(function () {
  var EN = document.documentElement.lang === "en";
  var P = EN ? "" : "/tr";
  function t(en, tr) { return EN ? en : tr; }
  var form = document.getElementById("login-form");
  var out = document.getElementById("login-status");
  function say(t, isError) { out.textContent = t; out.classList.toggle("error", !!isError); }
  async function signIn(token) {
    say(t("Signing in.", "Giriş yapılıyor."));
    try {
      var res = await fetch("/v1/session", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token })
      });
      if (res.ok) { location.replace(P + "/app"); return; }
      if (res.status === 429) say(t("Too many attempts. Wait a few minutes and try again.", "Çok fazla deneme yapıldı. Birkaç dakika bekleyip tekrar dene."), true);
      else say(t("This key isn't valid. Tap Open web panel in the app again, or paste the key below.", "Bu anahtar geçerli değil. Uygulamada Web paneli aç'a yeniden dokun ya da anahtarı aşağıya yapıştır."), true);
    } catch (e) {
      say(t("Couldn't reach the server. Check your connection and try again.", "Sunucuya ulaşılamadı. Bağlantını kontrol edip tekrar dene."), true);
    }
    form.hidden = false;
  }
  var m = /(?:^#|&)token=([^&]+)/.exec(location.hash);
  if (m) {
    // Drop the token from the address bar and history before anything else.
    history.replaceState(null, "", location.pathname);
    signIn(decodeURIComponent(m[1]));
  } else {
    form.hidden = false;
  }
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var t = form.elements.token.value.trim();
    if (t) signIn(t);
  });
})();
`;

export const APP_JS = `
(function () {
  var EN = document.documentElement.lang === "en";
  var P = EN ? "" : "/tr";
  function t(en, tr) { return EN ? en : tr; }
  function $(id) { return document.getElementById(id); }
  function say(el, t, isError) { if (!el) return; el.textContent = t; el.classList.toggle("error", !!isError); }
  async function call(method, path, body) {
    var init = { method: method, credentials: "same-origin", headers: {} };
    if (body !== undefined) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(body); }
    var res = await fetch(path, init);
    var data = null;
    try { data = await res.json(); } catch (e) {}
    if (res.status === 401) { location.href = P || "/"; throw new Error(t("Your session has ended.", "Oturumun kapandı.")); }
    if (!res.ok) throw new Error((data && data.message) || t("The request didn't go through. Reload the page and try again.", "İstek tamamlanamadı. Sayfayı yenileyip tekrar dene."));
    return data;
  }
  function copyButton(btn, source) {
    if (!btn) return;
    btn.addEventListener("click", async function () {
      try { await navigator.clipboard.writeText(source.textContent); btn.textContent = t("Copied", "Kopyalandı"); }
      catch (e) { btn.textContent = t("Couldn't copy; select it by hand", "Kopyalanamadı, elle seç"); }
    });
  }

  var signout = $("signout");
  if (signout) signout.addEventListener("click", async function () {
    try { await call("DELETE", "/v1/session"); } catch (e) {}
    location.href = P || "/";
  });

  // Webhooks
  var whForm = $("wh-form");
  if (whForm) whForm.addEventListener("submit", async function (e) {
    e.preventDefault();
    var out = $("wh-out");
    say(out, t("Adding.", "Ekleniyor."));
    try {
      var r = await call("POST", "/v1/webhooks", { url: whForm.elements.url.value.trim() });
      say(out, "");
      $("wh-secret").textContent = r.secret;
      $("wh-created").hidden = false;
      whForm.hidden = true;
    } catch (err) { say(out, err.message, true); }
  });
  copyButton($("wh-copy"), $("wh-secret"));
  var whDone = $("wh-done");
  if (whDone) whDone.addEventListener("click", function () { location.reload(); });

  var whList = $("wh-list");
  if (whList) whList.addEventListener("click", async function (e) {
    var btn = e.target.closest("button[data-action]");
    if (!btn) return;
    var id = encodeURIComponent(btn.getAttribute("data-id"));
    var out = $("wh-status-" + btn.getAttribute("data-id"));
    if (btn.getAttribute("data-action") === "test") {
      say(out, t("Sending a test.", "Deneme gönderiliyor."));
      try {
        var r = await call("POST", "/v1/webhooks/" + id + "/test");
        if (r.delivered) say(out, t("Delivered, HTTP ", "Ulaştı, HTTP ") + r.status + ".");
        else say(out, t("Not delivered: ", "Ulaşmadı: ") + r.error + t(". Check the address and your server.", ". Adresi ve sunucunu kontrol et."), true);
      } catch (err) { say(out, err.message, true); }
    } else if (btn.getAttribute("data-action") === "delete") {
      if (!window.confirm(t("Delete this webhook?", "Bu webhook silinsin mi?"))) return;
      try { await call("DELETE", "/v1/webhooks/" + id); location.reload(); }
      catch (err) { say(out, err.message, true); }
    }
  });

  // Token rotation
  var rotStart = $("rot-start"), rotBox = $("rot-confirm");
  if (rotStart) rotStart.addEventListener("click", function () { rotBox.hidden = false; rotStart.hidden = true; });
  var rotCancel = $("rot-cancel");
  if (rotCancel) rotCancel.addEventListener("click", function () { rotBox.hidden = true; rotStart.hidden = false; });
  var rotGo = $("rot-go");
  if (rotGo) rotGo.addEventListener("click", async function () {
    var out = $("rot-out");
    rotGo.disabled = true;
    try {
      var r = await call("POST", "/v1/token/rotate");
      $("rot-token").textContent = r.token;
      $("rot-result").hidden = false;
      rotBox.hidden = true;
    } catch (err) { say(out, err.message, true); rotGo.disabled = false; }
  });
  copyButton($("rot-copy"), $("rot-token"));

  // Account deletion
  var delStart = $("del-start"), delBox = $("del-confirm"), delInput = $("del-input"), delGo = $("del-go");
  if (delStart) delStart.addEventListener("click", function () { delBox.hidden = false; delStart.hidden = true; delInput.focus(); });
  var delCancel = $("del-cancel");
  if (delCancel) delCancel.addEventListener("click", function () { delBox.hidden = true; delStart.hidden = false; delInput.value = ""; delGo.disabled = true; });
  if (delInput) delInput.addEventListener("input", function () { delGo.disabled = delInput.value.trim().toLocaleLowerCase(EN ? "en" : "tr") !== t("delete", "sil"); });
  if (delGo) delGo.addEventListener("click", async function () {
    var out = $("del-out");
    delGo.disabled = true;
    try { await call("DELETE", "/v1/account"); location.href = (P || "/") + "?deleted=1"; }
    catch (err) { say(out, err.message, true); delGo.disabled = false; }
  });
})();
`;
