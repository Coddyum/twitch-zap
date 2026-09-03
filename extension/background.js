// Twitch Zap - service worker
//
// Responsabilites :
//   - indexer les onglets Twitch de toutes les fenetres du profil ;
//   - tenir un catalogue d'acces rapide alimente automatiquement ;
//   - decider qui a le son (chaine courante collante, jamais le focus souris) ;
//   - econimiser CPU/RAM sur les chaines en arriere-plan ;
//   - relever le statut live sans API ni onglet charge ;
//   - comptabiliser le temps passe par chaine.

const DAEMON = "http://127.0.0.1:8787";

// Segments de premier niveau twitch.tv qui ne sont PAS des chaines.
const RESERVED = new Set([
  "directory", "videos", "settings", "downloads", "store", "subscriptions",
  "wallet", "drops", "friends", "popout", "moderator", "following", "jobs",
  "turbo", "prime", "search", "activate", "team", "teams", "collections",
  "broadcast", "dashboard", "inventory", "payments", "products", "bits",
  "checkout", "login", "signup", "logout", "u", "p", "s", "user", "legal",
  "privacy", "terms", "creatorcamp", "safety", "about", "gift",
]);

const DEFAULT_SETTINGS = {
  mode: "solo",            // "solo" | "screens"
  autoMute: true,
  followFocus: false,      // suivre le focus fenetre (bruit de souris) : non
  showCatalog: true,       // afficher les chaines connues mais non ouvertes
  background: "off",       // "off" | "pause" | "discard"
  backgroundDelay: 180,    // secondes hors ecran avant d'agir
};

const LIVE_TTL = 180_000;      // fraicheur du statut live
const LIVE_BATCH = 12;         // chaines rafraichies par passage, au maximum
const ACCRUE_CAP = 600_000;    // garde-fou : jamais plus de 10 min d'un coup

// ---------------------------------------------------------------- utilitaires

function parseChannel(url) {
  if (!url) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/(^|\.)twitch\.tv$/.test(u.hostname)) return null;
  const m = u.pathname.match(/^\/([a-zA-Z0-9_]{2,25})\/?$/);
  if (!m) return null;
  const login = m[1].toLowerCase();
  return RESERVED.has(login) ? null : login;
}

function displayFromTitle(title, login) {
  if (!title) return login;
  const clean = title
    .replace(/\s*-\s*Live on Twitch\s*$/i, "")
    .replace(/\s*-\s*Twitch\s*$/i, "")
    .replace(/^\(\d+\)\s*/, "")
    .trim();
  return clean && clean.length <= 40 ? clean : login;
}

const today = () => new Date().toISOString().slice(0, 10);

async function local(key, fallback) {
  const r = await chrome.storage.local.get(key);
  return r[key] === undefined ? fallback : r[key];
}
async function session(key, fallback) {
  const r = await chrome.storage.session.get(key);
  return r[key] === undefined ? fallback : r[key];
}

async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(await local("settings", {})) };
}
async function setSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

// Exceptions de mute, dans les deux sens. tabId -> "on" | "off" :
//   "on"  = demute a la main -> on ne le remute jamais d'office
//   "off" = mute a la main   -> on ne le rallume jamais d'office
const getExceptions = () => session("mutedExceptions", {});
const setExceptions = (map) => chrome.storage.session.set({ mutedExceptions: map });
async function setException(tabId, value) {
  const ex = await getExceptions();
  if (value === null) delete ex[tabId]; else ex[tabId] = value;
  await setExceptions(ex);
}

// --------------------------------------------------- chaine courante collante
//
// Le son ne suit PAS le focus fenetre : en focus-follows-mouse, traverser un
// ecran rebasculerait le son en permanence. La chaine courante ne change que
// sur une action volontaire (zap, changement d'onglet, clic dans la page).

async function getCurrent() {
  const { currentTabId = null, previousTabId = null } =
    await chrome.storage.session.get(["currentTabId", "previousTabId"]);
  return { currentTabId, previousTabId };
}

async function setCurrent(tabId) {
  const { currentTabId } = await getCurrent();
  if (currentTabId === tabId) return;
  // Revenir volontairement sur une chaine annule le silence force qu'on lui
  // avait mis : sinon elle resterait muette sans raison visible.
  const ex = await getExceptions();
  if (ex[tabId] === "off") await setException(tabId, null);
  await chrome.storage.session.set({ currentTabId: tabId, previousTabId: currentTabId });
}

// --------------------------------------------------------------- favoris

const getFavorites = () => local("favorites", {});

async function toggleFavorite(login) {
  const fav = await getFavorites();
  if (fav[login]) delete fav[login]; else fav[login] = Date.now();
  await chrome.storage.local.set({ favorites: fav });
  return !!fav[login];
}

// -------------------------------------------------------------- catalogue

const getCatalog = () => local("catalog", {});

async function rememberChannel(login, { title, favIconUrl, bump = false } = {}) {
  const catalog = await getCatalog();
  const prev = catalog[login] || { login, uses: 0 };
  catalog[login] = {
    login,
    display: displayFromTitle(title, login) || prev.display || login,
    favIconUrl: favIconUrl || prev.favIconUrl || null,
    lastSeen: Date.now(),
    uses: (prev.uses || 0) + (bump ? 1 : 0),
  };
  await chrome.storage.local.set({ catalog });
}

async function forgetChannel(login) {
  const catalog = await getCatalog();
  delete catalog[login];
  await chrome.storage.local.set({ catalog });
}

// ------------------------------------------------------------ index onglets

async function twitchTabs() {
  const tabs = await chrome.tabs.query({ url: ["*://*.twitch.tv/*"] });
  const out = [];
  for (const t of tabs) {
    const login = parseChannel(t.url);
    if (!login) continue;
    out.push({
      id: t.id, windowId: t.windowId, login,
      title: t.title || login,
      display: displayFromTitle(t.title, login),
      favIconUrl: t.favIconUrl || null,
      active: t.active, pinned: t.pinned, discarded: !!t.discarded,
      audible: !!t.audible,
      muted: !!(t.mutedInfo && t.mutedInfo.muted),
    });
  }
  return out;
}

// ------------------------------------------------------- pont Hyprland (opt)

let daemonAlive = null;

async function daemonFetch(path, init) {
  try {
    const res = await fetch(DAEMON + path, { ...init, signal: AbortSignal.timeout(600) });
    daemonAlive = res.ok;
    return res.ok ? await res.json() : null;
  } catch {
    daemonAlive = false;
    return null;
  }
}

// chrome.windows.update({focused:true}) ne remonte pas la fenetre sous Wayland.
async function raiseWindow(tabId) {
  await new Promise((r) => setTimeout(r, 180));
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return; }
  if (!tab || !tab.title) return;
  await daemonFetch("/focus", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: tab.title }),
  });
}

// Fenetres Brave, avec l'ecran sur lequel elles sont posees.
async function windowMap() {
  let wins = [];
  try { wins = await chrome.windows.getAll({ populate: true }); } catch { return []; }
  wins = wins.filter((w) => w.type === "normal");
  const data = await daemonFetch("/visible");
  const hyprWins = (data && data.windows) || [];
  const used = new Set();
  const out = wins.map((w, i) => {
    const act = (w.tabs || []).find((t) => t.active);
    let match = null;
    if (act && act.title) {
      match = hyprWins.find((x) => !used.has(x.address) && x.title.startsWith(act.title)) || null;
      if (match) used.add(match.address);
    }
    return {
      id: w.id, order: i, focused: !!w.focused,
      monitor: match ? match.monitorName : null,
      visible: match ? match.visible : true,
      twitchCount: (w.tabs || []).filter((t) => parseChannel(t.url)).length,
    };
  });
  const seen = new Map();
  for (const w of out) {
    if (!w.monitor) { w.label = `Fenetre ${w.order + 1}`; continue; }
    const n = (seen.get(w.monitor) || 0) + 1;
    seen.set(w.monitor, n);
    w.label = n === 1 ? w.monitor : `${w.monitor} (${n})`;
  }
  return out;
}

// ------------------------------------------------------------------- etat
//
// Une seule fonction decide de tout : qui a le son, et qui est regarde.
//   sound   = onglets qui doivent etre audibles
//   watched = onglets visibles a l'ecran (meme muets) -> a ne jamais brider

async function computeState() {
  const [settings, tabs, exceptions, windows] = await Promise.all([
    getSettings(), twitchTabs(), getExceptions(), windowMap(),
  ]);
  const visibleWins = new Set(windows.filter((w) => w.visible).map((w) => w.id));

  const watched = new Set();
  for (const t of tabs) if (t.active && visibleWins.has(t.windowId)) watched.add(t.id);

  const { currentTabId } = await getCurrent();
  let current = tabs.find((t) => t.id === currentTabId) || null;
  if (!current) {
    let win = null;
    try { win = await chrome.windows.getLastFocused(); } catch {}
    current = tabs.find((t) => t.active && win && t.windowId === win.id)
      || tabs.find((t) => t.active) || null;
    if (current) await setCurrent(current.id);
  }
  if (current) watched.add(current.id);

  const playing = new Set();
  if (!settings.autoMute) {
    for (const t of tabs) playing.add(t.id);
  } else if (settings.mode === "solo") {
    if (current) playing.add(current.id);
  } else {
    for (const t of tabs) if (t.active && visibleWins.has(t.windowId)) playing.add(t.id);
  }

  const sound = new Set();
  for (const t of tabs) {
    let muted = !playing.has(t.id);
    const ex = exceptions[t.id];
    if (ex === "on") muted = false;
    else if (ex === "off") muted = true;
    if (!muted) sound.add(t.id);
  }
  return { settings, tabs, windows, exceptions, current, watched, sound };
}

// ------------------------------------------------------------------- audio

let audioTimer = null;
function scheduleAudio(delay = 120) {
  clearTimeout(audioTimer);
  audioTimer = setTimeout(() => { syncAll().catch(noteError("syncAll")); }, delay);
}

// Toute erreur etait avalee par des .catch(() => {}) : une panne devenait
// invisible et indiagnosticable. On garde la derniere, le popup l'affiche.
function noteError(where) {
  return (err) => {
    const msg = `${where}: ${(err && err.message) || err}`;
    chrome.storage.local.set({ lastError: { msg, at: Date.now() } }).catch(() => {});
    console.error("[twitch-zap]", msg, err);
  };
}

// Ecrit a chaque demarrage du service worker : c'est la preuve, lisible dans
// le profil, que le code charge est bien celui du disque.
async function markBoot() {
  const v = chrome.runtime.getManifest().version;
  await chrome.storage.local.set({ boot: { version: v, at: Date.now() } });
  console.log("[twitch-zap] service worker demarre, version", v);
}
markBoot().catch(() => {});

async function syncAll() {
  const st = await computeState();
  for (const t of st.tabs) {
    const wantMuted = !st.sound.has(t.id);
    if (t.muted !== wantMuted) chrome.tabs.update(t.id, { muted: wantMuted }).catch(() => {});
  }
  await applyVolumes(st);
  await applyBackground(st);
  await accrue(st);
}

// ------------------------------------------------------- volume par chaine

const getVolumes = () => local("volumes", {});

async function applyVolumes(st) {
  const volumes = await getVolumes();
  for (const t of st.tabs) {
    const v = volumes[t.login];
    if (v === undefined || t.discarded) continue;
    chrome.tabs.sendMessage(t.id, { type: "volume", value: v }).catch(() => {});
  }
}

async function setVolume(login, value) {
  const volumes = await getVolumes();
  volumes[login] = Math.max(0, Math.min(1, value));
  await chrome.storage.local.set({ volumes });
  const tabs = (await twitchTabs()).filter((t) => t.login === login && !t.discarded);
  for (const t of tabs) chrome.tabs.sendMessage(t.id, { type: "volume", value: volumes[login] }).catch(() => {});
  return volumes[login];
}

// ------------------------------------------------ economie CPU / RAM
//
// Une chaine qu'on ne voit sur aucun ecran et qu'on n'ecoute pas ne merite pas
// de decoder de la video. Au dela du delai configure on la met en pause, ou on
// decharge carrement l'onglet (il reste dans la barre et se recharge au zap).

async function applyBackground(st) {
  const mode = st.settings.background;
  const since = await session("bgSince", {});
  const now = Date.now();
  const next = {};
  const delay = Math.max(10, st.settings.backgroundDelay) * 1000;

  for (const t of st.tabs) {
    const active = st.watched.has(t.id) || st.sound.has(t.id);
    if (active) {
      // Redemarrer une chaine qu'on remet a l'ecran, en rattrapant le direct.
      if (since[t.id] && !t.discarded) {
        chrome.tabs.sendMessage(t.id, { type: "resume" }).catch(() => {});
      }
      continue;
    }
    next[t.id] = since[t.id] || now;
    if (mode === "off" || t.discarded) continue;
    if (now - next[t.id] < delay) continue;
    if (mode === "pause") {
      chrome.tabs.sendMessage(t.id, { type: "pause" }).catch(() => {});
    } else if (mode === "discard") {
      chrome.tabs.discard(t.id).catch(() => {});
    }
  }
  await chrome.storage.session.set({ bgSince: next });
}

// ------------------------------------------------------------------ stats
//
// Temps par chaine, accumule par transitions d'etat plutot que par minuterie :
// chaque passage ici solde le temps ecoule depuis le dernier passage.
//   audio = temps avec le son ; watch = temps affiche a l'ecran

const getStats = () => local("stats", {});

function addStat(stats, login, kind, seconds, day) {
  const s = stats[login] || (stats[login] = { audio: 0, watch: 0, days: {} });
  s[kind] += seconds;
  const d = s.days[day] || (s.days[day] = { audio: 0, watch: 0 });
  d[kind] += seconds;
}

async function accrue(st) {
  const now = Date.now();
  const prev = await session("since", { audio: {}, watch: {} });
  const stats = await getStats();
  const day = today();
  let touched = false;

  for (const kind of ["audio", "watch"]) {
    for (const [login, ts] of Object.entries(prev[kind] || {})) {
      const delta = Math.min(Math.max(now - ts, 0), ACCRUE_CAP) / 1000;
      if (delta >= 1) { addStat(stats, login, kind, delta, day); touched = true; }
    }
  }
  if (touched) await chrome.storage.local.set({ stats });

  const next = { audio: {}, watch: {} };
  for (const t of st.tabs) {
    // "Son actif" exige que l'onglet emette vraiment du son, pas seulement
    // qu'il ne soit pas coupe : sinon une chaine hors ligne, ou tout le monde
    // quand l'auto-mute est desactive, cumulerait du temps d'ecoute.
    if (st.sound.has(t.id) && t.audible) next.audio[t.login] = now;
    if (st.watched.has(t.id)) next.watch[t.login] = now;
  }
  await chrome.storage.session.set({ since: next });
}

// --------------------------------------------------------------- statut live
//
// Pas d'API Twitch ni de compte : le <title> de la page suffit et il arrive
// dans le tout premier bloc de la reponse, donc on coupe le telechargement des
// qu'on l'a lu. Marche aussi pour une chaine fermee ou un onglet decharge.

async function fetchLive(login) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`https://www.twitch.tv/${login}`, {
      signal: ctrl.signal, credentials: "omit",
    });
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (buf.length < 65536) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const m = buf.match(/<title>([^<]*)<\/title>/i);
      if (!m) continue;
      ctrl.abort();
      if (/-\s*Live on Twitch/i.test(m[1])) return true;
      if (/-\s*Twitch/i.test(m[1])) return false;
      return null;
    }
    return null;
  } catch (err) {
    if (err && err.name !== "AbortError") liveDiag.error = String(err.message || err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const getLive = () => local("live", {});

let liveDiag = { at: 0, asked: 0, ok: 0, error: null };

async function refreshLive(logins, { force = false } = {}) {
  const live = await getLive();
  const now = Date.now();
  // On ne rafraichit qu'un paquet par passage, les plus anciennes d'abord :
  // inutile de marteler twitch.tv pour trente chaines toutes les 30 secondes.
  const stale = logins
    .filter((l) => force || !live[l] || now - live[l].at > LIVE_TTL)
    .sort((a, b) => ((live[a] && live[a].at) || 0) - ((live[b] && live[b].at) || 0))
    .slice(0, force ? logins.length : LIVE_BATCH);
  if (!stale.length) return live;

  // Par petits paquets, pour ne pas ouvrir 30 connexions d'un coup.
  for (let i = 0; i < stale.length; i += 6) {
    const batch = stale.slice(i, i + 6);
    const res = await Promise.all(batch.map(fetchLive));
    batch.forEach((login, k) => {
      if (res[k] === null) return;
      live[login] = { live: res[k], at: Date.now() };
    });
    liveDiag.ok += res.filter((r) => r !== null).length;
  }
  liveDiag.at = Date.now();
  liveDiag.asked = stale.length;
  await chrome.storage.local.set({ live, liveDiag });
  return live;
}

// Chaines a surveiller : celles ouvertes, plus le catalogue recent.
async function watchlist() {
  const [tabs, catalog] = await Promise.all([twitchTabs(), getCatalog()]);
  const set = new Set(tabs.map((t) => t.login));
  Object.values(catalog)
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
    .slice(0, 30)
    .forEach((c) => set.add(c.login));
  return [...set];
}

// -------------------------------------------------------------------- zap

async function zap(login) {
  const tabs = await twitchTabs();
  const existing = tabs.filter((t) => t.login === login);
  let target = existing.find((t) => t.active) || existing[0];

  if (target) {
    await chrome.tabs.update(target.id, { active: true });
    await chrome.windows.update(target.windowId, { focused: true });
  } else {
    let winId;
    try { winId = (await chrome.windows.getLastFocused()).id; } catch {}
    const created = await chrome.tabs.create({
      url: `https://www.twitch.tv/${login}`, windowId: winId, active: true,
    });
    target = { id: created.id, windowId: created.windowId };
  }

  await setCurrent(target.id);
  await rememberChannel(login, { bump: true });
  scheduleAudio(250);
  raiseWindow(target.id).catch(() => {});
  return { ok: true, tabId: target.id };
}

// Retirer une chaine de la liste pour de bon : on ferme ses onglets s'il y en
// a, sinon elle reviendrait aussitot par l'index des onglets ouverts.
async function removeChannel(login) {
  const ids = (await twitchTabs()).filter((t) => t.login === login).map((t) => t.id);
  if (ids.length) await chrome.tabs.remove(ids);
  await forgetChannel(login);
  scheduleAudio(300);
  return { ok: true, closed: ids.length };
}

async function closeChannel(login) {
  const ids = (await twitchTabs()).filter((t) => t.login === login).map((t) => t.id);
  if (ids.length) await chrome.tabs.remove(ids);
  scheduleAudio();
  return { ok: true };
}

async function toggleMute(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const nowMuted = !(tab.mutedInfo && tab.mutedInfo.muted);
  await chrome.tabs.update(tabId, { muted: nowMuted });
  await setException(tabId, nowMuted ? "off" : "on");
  return { ok: true, muted: nowMuted };
}

async function remuteAll() {
  await setExceptions({});
  await syncAll();
}

// ------------------------------------------------------------- evenements

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.mutedInfo && changeInfo.mutedInfo.reason === "user") {
    await setException(tabId, changeInfo.mutedInfo.muted ? "off" : "on");
    return;
  }
  if (changeInfo.status === "complete" || changeInfo.url || changeInfo.title) {
    const login = parseChannel(tab.url);
    if (login) await rememberChannel(login, { title: tab.title, favIconUrl: tab.favIconUrl });
    scheduleAudio(400);
  }
  if (changeInfo.audible !== undefined) scheduleAudio(400);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  // Changer d'onglet est une action volontaire -> la chaine courante suit.
  try {
    const tab = await chrome.tabs.get(tabId);
    if (parseChannel(tab.url)) await setCurrent(tabId);
  } catch {}
  scheduleAudio();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await setException(tabId, null);
  scheduleAudio(300);
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  // Desactive par defaut : en focus-follows-mouse ce signal se declenche a
  // chaque traversee d'ecran, ce n'est pas une intention.
  const s = await getSettings();
  if (!s.followFocus || windowId === chrome.windows.WINDOW_ID_NONE) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (tab && parseChannel(tab.url)) await setCurrent(tab.id);
  } catch {}
  scheduleAudio();
});

// Piege MV3 : le service worker est relance a chaque evenement et rejoue son
// code de haut niveau. Un chrome.alarms.create() inconditionnel reprogramme
// l'alarme a zero a chaque fois -> avec des onglets Twitch qui changent de
// titre en permanence, elle n'arrive jamais a echeance. On ne la cree que si
// elle n'existe pas deja.
async function ensureAlarm() {
  const existing = await chrome.alarms.get("tick");
  if (!existing) await chrome.alarms.create("tick", { periodInMinutes: 0.5 });
}
ensureAlarm().catch(() => {});

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== "tick") return;
  await syncAll().catch(noteError("tick/syncAll"));
  await refreshLive(await watchlist()).catch(noteError("tick/refreshLive"));
});

// Recharger une extension n'injecte pas le content script dans les onglets
// deja ouverts : ils restent muets aux messages (volume, pause) jusqu'a un
// rechargement manuel. On les rattrape au demarrage.
async function injectExisting({ force = false } = {}) {
  // Une fois par session de navigation suffit : le drapeau vit dans
  // storage.session, qui est vide au demarrage de Brave comme au rechargement
  // de l'extension - exactement les deux cas ou le rattrapage est utile.
  if (!force && (await session("injected", false))) return 0;
  await chrome.storage.session.set({ injected: true });
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: ["*://*.twitch.tv/*"] }); } catch { return 0; }
  let done = 0;
  for (const t of tabs) {
    if (t.discarded) continue;
    try {
      await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["content.js"] });
      done++;
    } catch {}
  }
  return done;
}

function boot() {
  markBoot().catch(() => {});
  ensureAlarm().catch(noteError("ensureAlarm"));
  injectExisting().catch(noteError("injectExisting"));
  scheduleAudio(1500);
}
chrome.runtime.onStartup.addListener(boot);
chrome.runtime.onInstalled.addListener(boot);

chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd === "toggle-audio-mode") {
    const s = await getSettings();
    await setSettings({ mode: s.mode === "solo" ? "screens" : "solo" });
    await syncAll();
  } else if (cmd === "remute-all") {
    await remuteAll();
  } else if (cmd === "previous-channel") {
    const { previousTabId } = await getCurrent();
    if (previousTabId == null) return;
    try {
      const tab = await chrome.tabs.get(previousTabId);
      const login = parseChannel(tab.url);
      if (login) await zap(login);
    } catch {}
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "list": {
        injectExisting().catch(() => {});
        const [st, catalog, live, volumes, current, stats, favorites, diag] = await Promise.all([
          computeState(), getCatalog(), getLive(), getVolumes(), getCurrent(), getStats(),
          getFavorites(), local("liveDiag", liveDiag),
        ]);
        const [bootInfo, lastError] = await Promise.all([local("boot", null), local("lastError", null)]);
        sendResponse({
          tabs: st.tabs, windows: st.windows, settings: st.settings,
          exceptions: st.exceptions, currentTabId: current.currentTabId,
          catalog, live, volumes, stats, favorites, daemon: daemonAlive,
          diag: { ...diag, known: Object.keys(live).length, boot: bootInfo, lastError },
        });
        break;
      }
      // Une page Twitch qui vient de se charger reclame son volume memorise.
      case "hello": {
        const tab = sender && sender.tab;
        const login = tab ? parseChannel(tab.url) : null;
        const volumes = await getVolumes();
        sendResponse({ ok: true, volume: login ? volumes[login] : undefined });
        break;
      }
      case "claim": {
        const tab = sender && sender.tab;
        if (tab && parseChannel(tab.url)) { await setCurrent(tab.id); scheduleAudio(60); }
        sendResponse({ ok: true });
        break;
      }
      case "listen": await setCurrent(msg.tabId); await syncAll(); sendResponse({ ok: true }); break;
      case "zap": sendResponse(await zap(msg.login)); break;
      case "close": sendResponse(await closeChannel(msg.login)); break;
      case "remove": sendResponse(await removeChannel(msg.login)); break;
      case "toggleMute": sendResponse(await toggleMute(msg.tabId)); break;
      case "volume": sendResponse({ ok: true, value: await setVolume(msg.login, msg.value) }); break;
      case "forget": await forgetChannel(msg.login); sendResponse({ ok: true }); break;
      // Appele par le popup, qui reste ouvert le temps de la requete : c'est ce
      // qui garantit que le service worker n'est pas recycle en plein vol.
      case "refreshLive": {
        const live = await refreshLive(await watchlist(), { force: !!msg.force });
        sendResponse({ live, diag: { ...liveDiag, known: Object.keys(live).length } });
        break;
      }
      case "favorite": sendResponse({ ok: true, fav: await toggleFavorite(msg.login) }); break;
      case "reinject": sendResponse({ ok: true, count: await injectExisting({ force: true }) }); break;
      case "resetStats": await chrome.storage.local.set({ stats: {} }); sendResponse({ ok: true }); break;
      case "settings": {
        const s = await setSettings(msg.patch);
        await syncAll();
        sendResponse({ ok: true, settings: s });
        break;
      }
      case "remuteAll": await remuteAll(); sendResponse({ ok: true }); break;
      default: sendResponse({ ok: false });
    }
  })().catch((err) => {
    noteError(`message ${msg && msg.type}`)(err);
    try { sendResponse({ ok: false, error: String((err && err.message) || err) }); } catch {}
  });
  return true; // reponse asynchrone
});
