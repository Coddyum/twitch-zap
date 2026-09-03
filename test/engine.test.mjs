import fs from "node:fs";
import vm from "node:vm";

const SRC = new URL("../extension/background.js", import.meta.url).pathname;

function makeChrome(fixture) {
  const store = { local: {}, session: {} };
  const area = (name) => ({
    async get(keys) {
      if (keys === null || keys === undefined) return { ...store[name] };
      const ks = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of ks) if (k in store[name]) out[k] = store[name][k];
      return out;
    },
    async set(obj) { Object.assign(store[name], obj); },
  });
  const calls = { update: [], discard: [], msg: [], create: [], alarm: [], inject: [], chunks: 0 };
  return {
    store, calls,
    api: {
      storage: { local: area("local"), session: area("session") },
      tabs: {
        async query(q) {
          if (q.url) return fixture.tabs;
          return fixture.tabs.filter((t) => t.active && (!q.windowId || t.windowId === q.windowId));
        },
        async get(id) {
          const t = fixture.tabs.find((x) => x.id === id);
          if (!t) throw new Error("no tab");
          return t;
        },
        async update(id, props) {
          calls.update.push([id, props]);
          const t = fixture.tabs.find((x) => x.id === id);
          if (t && props.muted !== undefined) t.mutedInfo = { muted: props.muted, reason: "extension" };
          return t;
        },
        async remove() {}, async create(p) { calls.create.push(p); return { id: 99, windowId: 1 }; },
        async discard(id) { calls.discard.push(id); },
        async sendMessage(id, m) { calls.msg.push([id, m.type]); },
        onUpdated: { addListener() {} }, onActivated: { addListener() {} }, onRemoved: { addListener() {} },
      },
      windows: {
        WINDOW_ID_NONE: -1,
        async getAll() { return fixture.windows; },
        async getLastFocused() { return fixture.windows.find((w) => w.focused) || fixture.windows[0]; },
        async update() {},
        onFocusChanged: { addListener() {} },
      },
      alarms: {
        async get(name) { return fixture.alarms && fixture.alarms[name]; },
        async create(name, opts) {
          calls.alarm.push([name, opts]);
          (fixture.alarms || (fixture.alarms = {}))[name] = { name, ...opts };
        },
        onAlarm: { addListener() {} },
      },
      scripting: { async executeScript() { calls.inject.push(1); } },
      runtime: { onMessage: { addListener() {} }, onStartup: { addListener() {} }, onInstalled: { addListener() {} } },
      commands: { onCommand: { addListener() {} } },
    },
  };
}

function tab(id, windowId, login, opts = {}) {
  return {
    id, windowId, url: `https://www.twitch.tv/${login}`, title: `${login} - Twitch`,
    active: !!opts.active, pinned: !!opts.pinned, discarded: !!opts.discarded,
    audible: opts.audible !== false, mutedInfo: { muted: !!opts.muted, reason: "extension" },
  };
}

async function run(name, fixture, body, { daemon = true } = {}) {
  const { api, store, calls } = makeChrome(fixture);
  const ctx = vm.createContext({
    chrome: api, console, setTimeout, clearTimeout, AbortController, AbortSignal, TextDecoder,
    URL, Date, Math, JSON, Object, Array, Set, Map, Promise, String, Number, RegExp, Infinity,
    fetch: async (url) => {
      const u = String(url);
      if (u.startsWith("http://127.0.0.1")) {
        if (!daemon) throw new Error("down");
        if (u.endsWith("/visible")) return { ok: true, json: async () => ({ windows: fixture.hypr || [] }) };
        return { ok: true, json: async () => ({ ok: true }) };
      }
      // Fausse page Twitch, servie en morceaux : le titre est dans le premier,
      // le reste ne doit jamais etre lu.
      const login = u.split("/").pop();
      const live = (fixture.liveChannels || []).includes(login);
      const head = `<!DOCTYPE html><html><head><title>${login} - ${live ? "Live on Twitch" : "Twitch"}</title>`;
      const chunks = [head, "x".repeat(50_000), "y".repeat(50_000)];
      let i = 0;
      return {
        ok: true,
        body: {
          getReader: () => ({
            read: async () => {
              if (i >= chunks.length) return { done: true, value: undefined };
              calls.chunks++;
              return { done: false, value: new TextEncoder().encode(chunks[i++]) };
            },
          }),
        },
      };
    },
  });
  vm.runInContext(fs.readFileSync(SRC, "utf8"), ctx, { filename: "background.js" });
  const helpers = { store, calls, fixture };
  await body(ctx, helpers);
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
}

const eq = (a, b, what) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${what}\n    attendu ${B}\n    obtenu  ${A}`);
};

console.log("\nMoteur de decision (mode solo, 2 fenetres, 1 masquee)");

// 3 chaines : t1 active sur ecran visible, t2 active sur workspace masque,
// t3 onglet epingle en arriere-plan.
const base = () => {
  const t1 = tab(1, 10, "alpha", { active: true });
  const t2 = tab(2, 20, "beta", { active: true });
  const t3 = tab(3, 10, "gamma", { pinned: true });
  return {
    tabs: [t1, t2, t3],
    windows: [
      { id: 10, type: "normal", focused: true, tabs: [t1, t3] },
      { id: 20, type: "normal", focused: false, tabs: [t2] },
    ],
    hypr: [
      { address: "0xa", title: "alpha - Twitch - Brave Origin", monitorName: "DP-1", visible: true },
      { address: "0xb", title: "beta - Twitch - Brave Origin", monitorName: "DP-2", visible: false },
    ],
  };
};

await run("solo : seule la chaine courante a le son", base(), async (ctx) => {
  const st = await ctx.computeState();
  eq([...st.sound], [1], "sound");
  eq([...st.watched].sort(), [1], "watched (la fenetre masquee ne compte pas)");
});

await run("ecrans : chaque fenetre visible garde le son", base(), async (ctx) => {
  await ctx.setSettings({ mode: "screens" });
  const st = await ctx.computeState();
  eq([...st.sound], [1], "seule DP-1 est visible, DP-2 est sur un workspace masque");
});

await run("exception 'on' : une chaine demutee a la main reste audible", base(), async (ctx) => {
  await ctx.setException(3, "on");
  const st = await ctx.computeState();
  eq([...st.sound].sort(), [1, 3], "sound");
});

await run("exception 'off' : la chaine courante peut etre forcee au silence", base(), async (ctx) => {
  await ctx.setCurrent(1);
  await ctx.setException(1, "off");
  const st = await ctx.computeState();
  eq([...st.sound], [], "sound");
});

await run("revenir sur une chaine forcee au silence leve l'exception", base(), async (ctx) => {
  await ctx.setCurrent(3);
  await ctx.setException(3, "off");
  await ctx.setCurrent(1);
  await ctx.setCurrent(3);
  eq(await chromeGet(ctx, "session", "mutedExceptions"), {}, "exceptions");
});

console.log("\nEconomie CPU / RAM");

await run("mode 'off' : on ne touche a rien", base(), async (ctx, h) => {
  await ctx.syncAll();
  eq(h.calls.discard, [], "aucun dechargement");
});

await run("delai non ecoule : on ne decharge pas encore", base(), async (ctx, h) => {
  await ctx.setSettings({ background: "discard", backgroundDelay: 180 });
  await ctx.syncAll();
  eq(h.calls.discard, [], "rien avant le delai");
});

await run("delai ecoule : les chaines hors ecran sont dechargees", base(), async (ctx, h) => {
  await ctx.setSettings({ background: "discard", backgroundDelay: 180 });
  await ctx.syncAll();
  // on antidate le suivi comme si 10 minutes s'etaient ecoulees
  const bg = (await chromeGet(ctx, "session", "bgSince")) || {};
  for (const k of Object.keys(bg)) bg[k] -= 600_000;
  await ctx.chrome.storage.session.set({ bgSince: bg });
  h.calls.discard.length = 0;
  await ctx.syncAll();
  eq(h.calls.discard.sort(), [2, 3], "beta (workspace masque) et gamma (epingle) dechargees, pas alpha");
});

await run("mode 'pause' : message au content script, jamais sur ce qu'on regarde", base(), async (ctx, h) => {
  await ctx.setSettings({ background: "pause", backgroundDelay: 10 });
  await ctx.syncAll();
  const bg = (await chromeGet(ctx, "session", "bgSince")) || {};
  for (const k of Object.keys(bg)) bg[k] -= 600_000;
  await ctx.chrome.storage.session.set({ bgSince: bg });
  h.calls.msg.length = 0;
  await ctx.syncAll();
  const paused = h.calls.msg.filter(([, t]) => t === "pause").map(([id]) => id).sort();
  eq(paused, [2, 3], "pause");
  eq(h.calls.msg.some(([id]) => id === 1), false, "la chaine regardee n'est jamais touchee");
});

console.log("\nStatistiques de temps");

await run("le temps se cumule sur la chaine qui a le son", base(), async (ctx) => {
  await ctx.syncAll();                      // amorce le compteur
  const since = await chromeGet(ctx, "session", "since");
  since.audio.alpha -= 90_000;              // comme si 90 s s'etaient ecoulees
  since.watch.alpha -= 90_000;
  await ctx.chrome.storage.session.set({ since });
  await ctx.syncAll();
  const stats = await chromeGet(ctx, "local", "stats");
  const a = Math.round(stats.alpha.audio);
  if (a < 89 || a > 91) throw new Error(`temps alpha = ${a}s, attendu ~90`);
  if (stats.beta) throw new Error("beta ne doit rien cumuler : elle est muette et masquee");
});

await run("une chaine silencieuse ne cumule pas de temps d'ecoute", (() => {
  const f = base();
  // alpha est la chaine courante mais ne produit aucun son : hors ligne, en
  // pause, ou lecteur arrete. Elle ne doit rien cumuler.
  f.tabs[0].audible = false;
  return f;
})(), async (ctx) => {
  await ctx.syncAll();
  const since = await chromeGet(ctx, "session", "since");
  eq(Object.keys(since.audio), [], "aucune chaine en cours de comptage");
  eq(Object.keys(since.watch), ["alpha"], "mais elle reste comptee comme affichee a l'ecran");
});

await run("auto-mute desactive : seules les chaines qui parlent comptent", (() => {
  const f = base();
  f.tabs[1].audible = false;   // beta est ouverte mais silencieuse
  f.tabs[2].audible = false;   // gamma aussi
  return f;
})(), async (ctx) => {
  await ctx.setSettings({ autoMute: false });   // plus rien n'est mute
  await ctx.syncAll();
  const since = await chromeGet(ctx, "session", "since");
  eq(Object.keys(since.audio).sort(), ["alpha"], "seule celle qui emet du son");
});

await run("garde-fou : une mise en veille ne compte pas des heures", base(), async (ctx) => {
  await ctx.syncAll();
  const since = await chromeGet(ctx, "session", "since");
  since.audio.alpha -= 8 * 3600 * 1000;     // 8 h de veille
  await ctx.chrome.storage.session.set({ since });
  await ctx.syncAll();
  const stats = await chromeGet(ctx, "local", "stats");
  if (stats.alpha.audio > 601) throw new Error(`plafond non applique : ${stats.alpha.audio}s`);
});

console.log("\nPont Hyprland absent");

await run("sans daemon, toutes les fenetres sont considerees visibles", base(), async (ctx) => {
  await ctx.setSettings({ mode: "screens" });
  const st = await ctx.computeState();
  eq([...st.sound].sort(), [1, 2], "les deux onglets actifs gardent le son");
}, { daemon: false });

async function chromeGet(ctx, area, key) {
  const r = await ctx.chrome.storage[area].get(key);
  return r[key];
}

console.log("\nStatut live");

await run("lit le titre de la page et coupe le telechargement", base(), async (ctx, h) => {
  h.fixture.liveChannels = ["alpha", "gamma"];
  const live = await ctx.refreshLive(["alpha", "beta", "gamma"]);
  eq(live.alpha.live, true, "alpha en direct");
  eq(live.beta.live, false, "beta hors ligne");
  eq(live.gamma.live, true, "gamma en direct");
  eq(h.calls.chunks, 3, "un seul morceau lu par chaine (100 ko economises a chaque fois)");
});

await run("ne re-sonde pas une chaine encore fraiche", base(), async (ctx, h) => {
  h.fixture.liveChannels = ["alpha"];
  await ctx.refreshLive(["alpha"]);
  const first = h.calls.chunks;
  await ctx.refreshLive(["alpha"]);
  eq(h.calls.chunks, first, "aucune requete supplementaire");
});

await run("le statut survit a la fermeture de l'onglet", base(), async (ctx, h) => {
  h.fixture.liveChannels = ["beta"];
  await ctx.refreshLive(["beta"]);
  const stored = await chromeGet(ctx, "local", "live");
  eq(stored.beta.live, true, "cache persistant : une chaine fermee garde son statut");
});

console.log("\nService worker");

await run("l'alarme n'est pas reprogrammee a chaque reveil", base(), async (ctx, h) => {
  await ctx.ensureAlarm();          // laisse l'appel de haut niveau se poser
  h.calls.alarm.length = 0;
  // Chaque reveil du service worker rejoue le code de haut niveau : ces
  // appels-la ne doivent plus rien reprogrammer, sinon l'echeance recule
  // indefiniment et ni les stats ni le statut live ne tournent.
  await ctx.ensureAlarm();
  await ctx.ensureAlarm();
  await ctx.ensureAlarm();
  eq(h.calls.alarm.length, 0, "aucune reprogrammation");
  eq(!!h.fixture.alarms.tick, true, "l'alarme existe bien");
});

await run("les onglets deja ouverts recoivent le content script au demarrage", base(), async (ctx, h) => {
  eq(await ctx.injectExisting(), 3, "les 3 onglets Twitch sont reinjectes");
  eq(await ctx.injectExisting(), 0, "une seule fois par session : pas de double injection");
  eq(await ctx.injectExisting({ force: true }), 3, "sauf demande explicite");
});

console.log("\n\x1b[32mTous les scenarios passent.\x1b[0m\n");
