const $ = (id) => document.getElementById(id);
const $q = $("q"), $wins = $("wins"), $list = $("list"), $stats = $("stats");
const $mode = $("mode"), $bg = $("bg"), $auto = $("auto"), $follow = $("follow");
const $catalog = $("catalog"), $statsBtn = $("statsBtn"), $remute = $("remute"), $daemon = $("daemon");
const $diag = $("diag");

let items = [], view = [], windows = [], stats = {}, favorites = {};
let winFilter = null, sel = 0, currentTabId = null, showStats = false;
let settings = { mode: "solo", autoMute: true, followFocus: false, background: "off", showCatalog: true };

const send = (msg) => chrome.runtime.sendMessage(msg);

const BG_LABEL = { off: "eco off", pause: "eco pause", discard: "eco decharge" };
const BG_TITLE = {
  off: "Aucune economie : toutes les chaines decodent en permanence.",
  pause: "Met en pause les chaines qu'on ne voit sur aucun ecran et qu'on n'ecoute pas. Reprise au direct au retour.",
  discard: "Decharge completement l'onglet (RAM et CPU liberes). Il reste dans la barre et se recharge au zap.",
};
const BG_NEXT = { off: "pause", pause: "discard", discard: "off" };

function fmt(sec) {
  sec = Math.round(sec || 0);
  if (sec < 60) return `${sec}s`;
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h}h${String(m).padStart(2, "0")}` : `${m}min`;
}

function score(needle, hay) {
  if (!needle) return 1;
  const n = needle.toLowerCase(), h = hay.toLowerCase();
  if (h === n) return 1000;
  if (h.startsWith(n)) return 700 - h.length;
  let i = 0, s = 0, streak = 0;
  for (let j = 0; j < h.length && i < n.length; j++) {
    if (h[j] === n[i]) {
      streak++;
      s += 10 + streak * 4 + (j === 0 || /[^a-z0-9]/.test(h[j - 1]) ? 8 : 0);
      i++;
    } else streak = 0;
  }
  return i < n.length ? -1 : s - h.length * 0.3;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function highlight(text, needle) {
  if (!needle) return escapeHtml(text);
  const n = needle.toLowerCase(), h = text.toLowerCase();
  let i = 0, out = "";
  for (let j = 0; j < text.length; j++) {
    const c = escapeHtml(text[j]);
    if (i < n.length && h[j] === n[i]) { out += `<b>${c}</b>`; i++; } else out += c;
  }
  return out;
}

// Tri alphabetique insensible a la casse et aux accents, sur le nom affiche.
const collator = new Intl.Collator("fr", { sensitivity: "base", numeric: true });
const alpha = (a, b) =>
  collator.compare(a.display || a.login, b.display || b.login);

const winLabel = (id) => (windows.find((x) => x.id === id) || {}).label || null;
const multiWin = () => windows.filter((w) => w.twitchCount > 0).length > 1;

function renderWindows() {
  if (!multiWin()) { $wins.innerHTML = ""; return; }
  $wins.innerHTML = "";
  const all = document.createElement("button");
  all.className = "win" + (winFilter === null ? " on" : "");
  all.textContent = "toutes";
  all.dataset.win = "";
  $wins.appendChild(all);
  for (const w of windows.filter((x) => x.twitchCount > 0)) {
    const b = document.createElement("button");
    b.className = "win" + (winFilter === w.id ? " on" : "") + (w.visible ? "" : " hidden-ws");
    b.dataset.win = String(w.id);
    b.title = w.visible ? "Fenetre affichee sur un ecran" : "Fenetre sur un workspace masque";
    b.innerHTML = `${escapeHtml(w.label)}<span class="n">${w.twitchCount}</span>`;
    $wins.appendChild(b);
  }
}

function render() {
  const q = $q.value.trim();
  let pool = items;
  if (winFilter !== null) pool = items.filter((it) => it.open && it.windowId === winFilter);
  // "catalogue" = chaine connue dont aucun onglet n'est ouvert. On peut les
  // masquer ; taper un nom permet toujours d'en ouvrir une nouvelle.
  else if (!settings.showCatalog) pool = items.filter((it) => it.open);

  view = pool
    .map((it) => ({ it, sc: Math.max(score(q, it.login), score(q, it.display || "")) }))
    .filter((x) => x.sc >= 0)
    .sort((a, b) => {
      // Ordre demande : 1) favoris, 2) en direct, 3) alphabetique.
      // Pendant une recherche, la pertinence passe devant le direct, sinon
      // taper "zer" remonterait une chaine live avant celle qu'on cherche.
      if (a.it.fav !== b.it.fav) return a.it.fav ? -1 : 1;
      if (q && b.sc !== a.sc) return b.sc - a.sc;
      if ((b.it.live === true) !== (a.it.live === true)) return a.it.live === true ? -1 : 1;
      return alpha(a.it, b.it);
    })
    .map((x) => x.it);

  if (q && winFilter === null && !view.some((it) => it.login === q.toLowerCase())) {
    view.push({ login: q.toLowerCase(), display: q, open: false, isNew: true, uses: 0, lastSeen: 0 });
  }

  sel = Math.min(sel, Math.max(view.length - 1, 0));
  $list.innerHTML = "";
  if (!view.length) { $list.innerHTML = '<li class="empty">Aucune chaine ici.</li>'; return; }

  view.forEach((it, i) => {
    const li = document.createElement("li");
    li.className = [
      i === sel ? "sel" : "",
      it.open && it.tabId === currentTabId ? "cur" : "",
      it.live === false ? "dim" : "",
    ].filter(Boolean).join(" ");
    li.dataset.i = String(i);

    const st = it.live === true ? "st live" : it.live === false ? "st off" : "st";
    const stTitle = it.live === true ? "En direct" : it.live === false ? "Hors ligne" : "Statut inconnu";

    const tags = [];
    if (it.isNew) tags.push('<span class="tag">ouvrir</span>');
    else if (!it.open) tags.push('<span class="tag">catalogue</span>');
    if (it.discarded) tags.push('<span class="tag zzz">decharge</span>');
    if (it.open && winFilter === null && multiWin()) {
      const lbl = winLabel(it.windowId);
      if (lbl) tags.push(`<span class="tag scr">${escapeHtml(lbl)}</span>`);
    }

    const vol = Math.round((it.volume === undefined ? 1 : it.volume) * 100);
    const slider = it.open
      ? `<input class="vol" type="range" min="0" max="100" step="5" value="${vol}" data-vol="${i}" title="Volume de la chaine : ${vol}%">`
      : "";
    const spk = it.open
      ? `<button class="spk${it.muted ? "" : " audible"}${it.forced ? " forced" : ""}" data-mute="${i}" title="${
          it.muted ? "Remettre le son" : "Couper le son"}${it.forced ? " (exception manuelle)" : ""}">${
          it.muted ? "🔇" : "🔊"}</button>`
      : "";

    const del = it.isNew ? "" :
      `<button class="del" data-del="${i}" title="${
        it.open ? "Fermer l'onglet et retirer la chaine de la liste" : "Retirer la chaine de la liste"} (Suppr)">🗑</button>`;

    const fav = it.isNew ? "" :
      `<button class="fav${it.fav ? " on" : ""}" data-fav="${i}" title="${
        it.fav ? "Retirer des favoris" : "Epingler en haut de la liste"} (Alt+F)">${it.fav ? "★" : "☆"}</button>`;

    li.innerHTML =
      `<span class="num">${i < 9 ? i + 1 : ""}</span>` +
      `<span class="${st}" title="${stTitle}"></span>` +
      `<img class="ico" src="${it.favIconUrl || "data:image/gif;base64,R0lGODlhAQABAAAAACw="}" alt="">` +
      `<span class="name">${highlight(it.display || it.login, q)}` +
      (it.display && it.display.toLowerCase() !== it.login
        ? ` <span class="sub">${escapeHtml(it.login)}</span>` : "") +
      `</span>` + tags.join("") + slider + spk + fav + del;
    $list.appendChild(li);
  });
  const cur = $list.querySelector("li.sel");
  if (cur) cur.scrollIntoView({ block: "nearest" });
}

function renderStats() {
  const day = new Date().toISOString().slice(0, 10);
  const rows = Object.entries(stats || {}).map(([login, s]) => ({
    login,
    audio: s.audio || 0,
    watch: s.watch || 0,
    dayAudio: ((s.days || {})[day] || {}).audio || 0,
  }));

  const byToday = rows.filter((r) => r.dayAudio >= 1).sort((a, b) => b.dayAudio - a.dayAudio).slice(0, 12);
  const byTotal = rows.filter((r) => r.audio >= 1).sort((a, b) => b.audio - a.audio).slice(0, 12);

  // Deux mesures differentes : le temps ou la chaine avait le son, et le temps
  // ou elle etait simplement affichee sur un ecran (souvent bien plus long).
  const block = (title, list, key, withWatch) => {
    if (!list.length) return `<h3>${title}</h3><div class="strow"><span class="nm">rien encore</span></div>`;
    const max = list[0][key] || 1;
    return `<h3>${title}</h3>` + list.map((r) =>
      `<div class="strow"><span class="nm">${escapeHtml(r.login)}</span>` +
      (withWatch ? `<span class="tm sub" title="Temps affiche a l'ecran">${fmt(r.watch)}</span>` : "") +
      `<span class="barw"><i style="width:${Math.max(3, (r[key] / max) * 100)}%"></i></span>` +
      `<span class="tm" title="Temps avec le son">${fmt(r[key])}</span></div>`).join("");
  };

  $stats.innerHTML =
    block("Aujourd'hui — son actif", byToday, "dayAudio", false) +
    block("Total — ecran / son", byTotal, "audio", true) +
    `<div class="foot"><button class="chip" id="resetStats">effacer les stats</button></div>`;

  $("resetStats").addEventListener("click", async () => {
    await send({ type: "resetStats" });
    await load();
  });
}

function refreshChips() {
  $mode.textContent = settings.mode === "solo" ? "solo" : "ecrans";
  $mode.classList.toggle("on", settings.mode === "screens");
  $mode.title = settings.mode === "solo"
    ? "solo : une seule chaine a le son, celle que tu ecoutes. Ctrl+Shift+M pour ecrans."
    : "ecrans : l'onglet actif de chaque fenetre affichee garde le son. Ctrl+Shift+M pour solo.";
  $bg.textContent = BG_LABEL[settings.background] || "eco off";
  $bg.title = BG_TITLE[settings.background] || BG_TITLE.off;
  $bg.classList.toggle("on", settings.background !== "off");
  $auto.classList.toggle("on", settings.autoMute);
  $auto.classList.toggle("warn", !settings.autoMute);
  $auto.textContent = settings.autoMute ? "auto-mute" : "auto-mute off";
  $follow.classList.toggle("on", settings.followFocus);
  $catalog.classList.toggle("on", settings.showCatalog !== false);
  $statsBtn.classList.toggle("on", showStats);
}

async function load() {
  const data = await send({ type: "list" });
  settings = data.settings;
  windows = data.windows || [];
  currentTabId = data.currentTabId;
  stats = data.stats || {};
  favorites = data.favorites || {};
  const exceptions = data.exceptions || {};
  const live = data.live || {};
  const volumes = data.volumes || {};

  $daemon.classList.toggle("on", data.daemon === true);
  $daemon.title = data.daemon === true
    ? "Pont Hyprland actif"
    : "Pont Hyprland absent : focus fenetre degrade, noms d'ecran indisponibles";

  const byLogin = new Map();
  for (const [login, c] of Object.entries(data.catalog || {})) {
    byLogin.set(login, { ...c, login, open: false, uses: c.uses || 0, lastSeen: c.lastSeen || 0 });
  }
  for (const t of data.tabs) {
    byLogin.set(t.login, {
      ...(byLogin.get(t.login) || { uses: 0, lastSeen: 0 }),
      login: t.login,
      display: t.display || t.login,
      favIconUrl: t.favIconUrl || (byLogin.get(t.login) || {}).favIconUrl,
      open: true, tabId: t.id, windowId: t.windowId, discarded: t.discarded,
      audible: t.audible, muted: t.muted, active: t.active,
      forced: exceptions[t.id] !== undefined,
    });
  }
  for (const it of byLogin.values()) {
    it.live = live[it.login] ? live[it.login].live : undefined;
    it.volume = volumes[it.login];
    it.fav = !!favorites[it.login];
  }
  items = [...byLogin.values()];

  if (winFilter !== null && !windows.some((w) => w.id === winFilter && w.twitchCount > 0)) winFilter = null;
  refreshChips();
  renderWindows();
  render();
  renderDiag(data.diag);
  if (showStats) renderStats();
}

function renderDiag(d) {
  if (!d) { $diag.textContent = ""; return; }
  const age = d.at ? Math.round((Date.now() - d.at) / 1000) : null;
  const parts = [];
  // La version affichee est celle que le service worker execute vraiment, pas
  // celle du disque : c'est ce qui permet de voir un worker reste en cache.
  if (d.boot) parts.push(`v${d.boot.version}`);
  parts.push(`live : ${d.known || 0} connues${age === null ? ", jamais releve" : `, maj il y a ${age}s`}`);
  const err = (d.lastError && d.lastError.msg) || d.error;
  if (err) parts.push(`erreur — ${err}`);
  $diag.classList.toggle("err", !!err);
  $diag.textContent = parts.join(" · ");
}

// Le service worker peut etre recycle des que le popup se ferme, ce qui tuait
// les requetes de statut live lancees en tache de fond. On les declenche donc
// depuis le popup, qui reste ouvert le temps qu'elles aboutissent.
async function pullLive(force = false) {
  const r = await send({ type: "refreshLive", force });
  if (!r || !r.live) return;
  for (const it of items) it.live = r.live[it.login] ? r.live[it.login].live : it.live;
  render();
  renderDiag(r.diag);
}

async function zapAt(i) {
  const it = view[i];
  if (!it) return;
  await send({ type: "zap", login: it.login });
  window.close();
}

// Donner le son a une chaine sans quitter l'onglet courant : pratique quand
// elle tourne sur un autre ecran et qu'on veut juste l'ecouter.
async function listenAt(i) {
  const it = view[i];
  if (!it || !it.open) return;
  await send({ type: "listen", tabId: it.tabId });
  await load();
}

async function toggleAt(i) {
  const it = view[i];
  if (!it || !it.open) return;
  await send({ type: "toggleMute", tabId: it.tabId });
  await load();
}

async function nudgeVolume(i, delta) {
  const it = view[i];
  if (!it) return;
  const cur = it.volume === undefined ? 1 : it.volume;
  const next = Math.max(0, Math.min(1, Math.round((cur + delta) * 20) / 20));
  it.volume = next;
  await send({ type: "volume", login: it.login, value: next });
  render();
}

$q.addEventListener("input", () => { sel = 0; render(); });
$q.addEventListener("keydown", async (e) => {
  if (e.altKey && /^[1-9]$/.test(e.key)) { e.preventDefault(); await zapAt(Number(e.key) - 1); return; }
  if (e.altKey && (e.key === "f" || e.key === "F")) {
    e.preventDefault();
    const it = view[sel];
    if (it && !it.isNew) { await send({ type: "favorite", login: it.login }); await load(); }
    return;
  }
  if (e.ctrlKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    e.preventDefault(); await nudgeVolume(sel, e.key === "ArrowUp" ? 0.05 : -0.05); return;
  }
  if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) { sel = Math.min(sel + 1, view.length - 1); render(); e.preventDefault(); }
  else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) { sel = Math.max(sel - 1, 0); render(); e.preventDefault(); }
  else if (e.key === "Tab") { e.preventDefault(); if (view.length) sel = (sel + (e.shiftKey ? view.length - 1 : 1)) % view.length; render(); }
  else if (e.key === "Enter") {
    e.preventDefault();
    if (e.ctrlKey) await listenAt(sel);
    else if (e.shiftKey) await toggleAt(sel);
    else await zapAt(sel);
  }
  else if (e.key === "Escape") { if (winFilter !== null) { winFilter = null; renderWindows(); render(); } else window.close(); }
  else if (e.key === "Delete" && view[sel]) {
    e.preventDefault();
    const it = view[sel];
    if (!it.isNew) { await send({ type: "remove", login: it.login }); await load(); }
  }
});

$wins.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-win]");
  if (!b) return;
  winFilter = b.dataset.win === "" ? null : Number(b.dataset.win);
  sel = 0; renderWindows(); render(); $q.focus();
});

$list.addEventListener("input", async (e) => {
  const slider = e.target.closest("input[data-vol]");
  if (!slider) return;
  const it = view[Number(slider.dataset.vol)];
  if (!it) return;
  it.volume = Number(slider.value) / 100;
  slider.title = `Volume de la chaine : ${slider.value}%`;
  await send({ type: "volume", login: it.login, value: it.volume });
});

$list.addEventListener("click", (e) => {
  if (e.target.closest("input[data-vol]")) { e.stopPropagation(); return; }
  const bin = e.target.closest("button[data-del]");
  if (bin) {
    e.stopPropagation();
    const it = view[Number(bin.dataset.del)];
    if (it) send({ type: "remove", login: it.login }).then(load);
    return;
  }
  const star = e.target.closest("button[data-fav]");
  if (star) {
    e.stopPropagation();
    const it = view[Number(star.dataset.fav)];
    if (it) send({ type: "favorite", login: it.login }).then(load);
    return;
  }
  const spk = e.target.closest("button[data-mute]");
  if (spk) { e.stopPropagation(); toggleAt(Number(spk.dataset.mute)); return; }
  const li = e.target.closest("li[data-i]");
  if (!li) return;
  const i = Number(li.dataset.i);
  if (e.ctrlKey) listenAt(i); else zapAt(i);
});

const patch = (p) => async () => {
  const r = await send({ type: "settings", patch: p() });
  settings = r.settings;
  await load();
};
$mode.addEventListener("click", patch(() => ({ mode: settings.mode === "solo" ? "screens" : "solo" })));
$bg.addEventListener("click", patch(() => ({ background: BG_NEXT[settings.background] })));
$auto.addEventListener("click", patch(() => ({ autoMute: !settings.autoMute })));
$follow.addEventListener("click", patch(() => ({ followFocus: !settings.followFocus })));
$catalog.addEventListener("click", patch(() => ({ showCatalog: settings.showCatalog === false })));
$remute.addEventListener("click", async () => { await send({ type: "remuteAll" }); await load(); });
$statsBtn.addEventListener("click", () => {
  showStats = !showStats;
  $stats.hidden = !showStats;
  $list.hidden = showStats;
  $wins.hidden = showStats;
  refreshChips();
  if (showStats) renderStats(); else $q.focus();
});

load().then(() => pullLive());
