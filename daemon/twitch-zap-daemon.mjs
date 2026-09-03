#!/usr/bin/env node
// Pont Hyprland pour Twitch Zap.
//  POST /focus  {title}  -> remonte la fenetre Brave qui porte ce titre
//  GET  /visible         -> etat des fenetres Brave (workspace / moniteur / visible)
//
// Necessaire parce que chrome.windows.update({focused:true}) ne remonte pas
// la fenetre de maniere fiable sous Wayland.

import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

// journald horodate et classe deja : on ecrit juste un niveau lisible.
// stdout pour l'information, stderr pour ce qui merite un oeil.
function log(level, msg) {
  const line = `[${level}] ${msg}`;
  if (level === "info") console.log(line); else console.error(line);
}
const PORT = Number(process.env.TWITCH_ZAP_PORT || 8787);
const CLASS_RE = new RegExp(process.env.TWITCH_ZAP_CLASS || "brave|chromium|chrome", "i");

async function hypr(args) {
  const { stdout } = await run("hyprctl", args, { maxBuffer: 8 << 20 });
  return stdout;
}

async function hyprJson(cmd) {
  return JSON.parse(await hypr(["-j", cmd]));
}

async function browserWindows() {
  const [clients, monitors] = await Promise.all([hyprJson("clients"), hyprJson("monitors")]);
  const activeWs = new Set(monitors.map((m) => m.activeWorkspace && m.activeWorkspace.id).filter((x) => x != null));
  const monName = new Map(monitors.map((m) => [m.id, m.name]));
  const focusedMon = monitors.find((m) => m.focused);
  const focusedWsId = focusedMon && focusedMon.activeWorkspace ? focusedMon.activeWorkspace.id : null;
  return clients
    .filter((c) => CLASS_RE.test(c.class || "") && c.mapped !== false)
    .map((c) => ({
      address: c.address,
      title: c.title || "",
      class: c.class,
      workspace: c.workspace ? c.workspace.name : null,
      monitor: c.monitor,
      monitorName: monName.get(c.monitor) || null,
      // visible = sur un workspace affiche par un moniteur, et pas cache
      visible: activeWs.has(c.workspace && c.workspace.id) && !c.hidden,
      focusedWorkspace: c.workspace && c.workspace.id === focusedWsId,
    }));
}

function matchWindow(windows, title) {
  const t = (title || "").trim();
  if (!t) return null;
  return (
    windows.find((w) => w.title === t) ||
    windows.find((w) => w.title.startsWith(t)) ||
    windows.find((w) => w.title.includes(t)) ||
    null
  );
}

// Hyprland >= 0.5x expose les dispatchers via Lua (hl.dsp.focus). L'ancienne
// forme "dispatch focuswindow address:0x.." n'est plus acceptee, on garde
// quand meme un repli pour les versions plus anciennes.
async function focusAddress(address) {
  if (!/^0x[0-9a-fA-F]+$/.test(address)) throw new Error("bad address");
  const lua =
    `for _,w in ipairs(hl.get_windows()) do ` +
    `if w.address == "${address}" then hl.dispatch(hl.dsp.focus({window=w})) end end`;
  try {
    await hypr(["eval", lua]);
    return "lua";
  } catch {
    await hypr(["dispatch", "focuswindow", `address:${address}`]);
    return "legacy";
  }
}

async function focusByTitle(title) {
  const windows = await browserWindows();
  const win = matchWindow(windows, title);
  if (!win) {
    // Trace utile : on saura apres coup pourquoi un zap n'a pas remonte la
    // fenetre, et sur quel jeu de titres la correspondance a echoue.
    log("warn", `focus sans correspondance pour ${JSON.stringify(title)} ` +
      `parmi ${windows.length} fenetre(s) : ${windows.map((w) => w.title).join(" | ") || "aucune"}`);
    return { ok: false, reason: "no-match", title };
  }
  const via = await focusAddress(win.address);
  log("info", `focus ${win.address} (${via}) -> ${win.title}`);
  return { ok: true, address: win.address, matched: win.title, via };
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 64_000) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(data || "{}")); } catch { resolve({}); } });
  });
}

const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }

  const url = new URL(req.url, "http://127.0.0.1");
  const json = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  try {
    if (url.pathname === "/visible" && req.method === "GET") {
      json(200, { windows: await browserWindows() });
    } else if (url.pathname === "/focus" && req.method === "POST") {
      const body = await readBody(req);
      json(200, await focusByTitle(body.title));
    } else if (url.pathname === "/health") {
      json(200, { ok: true, port: PORT });
    } else {
      json(404, { ok: false });
    }
  } catch (err) {
    const msg = String((err && err.message) || err);
    // hyprctl injoignable est le cas interessant : sans lui le pont ne sert
    // plus a rien et l'extension bascule en mode degrade sans le dire.
    log("error", `${req.method} ${url.pathname} a echoue : ${msg}`);
    json(500, { ok: false, error: msg });
  }
});

// Une exception non rattrapee tuerait le process avec une trace brute et sans
// contexte. On la nomme avant de rendre la main a systemd, qui relancera.
process.on("uncaughtException", (err) => {
  log("error", `exception non rattrapee : ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  log("error", `promesse rejetee sans traitement : ${reason && reason.stack ? reason.stack : reason}`);
  process.exit(1);
});
process.on("SIGTERM", () => {
  log("info", "arret demande, fermeture propre");
  server.close(() => process.exit(0));
});

// Sans ca, un port deja pris se traduit par une trace d'exception illisible.
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    log("error", `le port ${PORT} est deja utilise. Une autre instance tourne ` +
      "probablement : `systemctl --user restart twitch-zap`, ou `pkill -f twitch-zap-daemon`.");
  } else {
    log("error", `erreur du serveur : ${err.message}`);
  }
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  log("info", `demarre sur http://127.0.0.1:${PORT}, node ${process.version}, pid ${process.pid}`);
});
