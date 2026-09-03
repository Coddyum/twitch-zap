# Twitch Zap

Navigation instantanée et mute automatique entre des dizaines de chaînes Twitch
ouvertes en même temps. `Ctrl+Shift+Espace`, on tape le pseudo, ça bascule.

Conçu pour suivre un ZEvent : une vingtaine d'onglets épinglés répartis sur
trois écrans, sans jamais chercher un onglet à la souris ni muter à la main.

Extension Chromium MV3 (Brave, Chrome, Edge, Vivaldi) + un daemon Node optionnel
qui sert de pont vers le gestionnaire de fenêtres.

---

## Ce que ça fait

| | |
|---|---|
| **Bascule instantanée** | Recherche floue : la chaîne est ouverte → son onglet **et** sa fenêtre passent devant ; sinon elle s'ouvre. |
| **Catalogue automatique** | Toute chaîne ouverte, même à la main, entre dans la liste. Rien à déclarer, et elle y reste après fermeture. |
| **Mute intelligent** | Seule la chaîne écoutée a le son. La « chaîne courante » est *collante* : elle ne change que sur une action volontaire, **jamais** en bougeant la souris. |
| **Statut live** | Pastille verte pulsée par chaîne, sans API ni compte — y compris pour une chaîne fermée ou un onglet déchargé. |
| **Volume par chaîne** | Un curseur par ligne, mémorisé et réappliqué au rechargement. Le mute d'onglet reste l'interrupteur général. |
| **Économie CPU/RAM** | Trois crans : rien, mise en pause, ou déchargement complet de l'onglet. Reprise au direct au retour. |
| **Statistiques** | Temps avec le son et temps à l'écran, par chaîne et par jour. |
| **Favoris & corbeille** | Épingler en tête de liste, ou retirer une chaîne définitivement. |

**Ordre de la liste** : favoris → en direct → alphabétique. Pendant une
recherche, la pertinence passe devant le statut live ; les favoris restent en
tête.

**Deux modes audio** : `solo` (une seule chaîne a le son) ou `écrans` (l'onglet
actif de *chaque* fenêtre affichée garde le son, et une fenêtre passée sur un
workspace masqué se coupe toute seule).

---

## Compatibilité

Développé et vérifié sur **Omarchy / Hyprland**. L'extension elle-même ne
contient aucune ligne spécifique à un OS : tout ce qui dépend de la plateforme
est isolé dans le daemon, qui est optionnel.

| Plateforme | Extension | Remontée de fenêtre | Mode `écrans` | Installation |
|---|---|---|---|---|
| **Linux + Hyprland** (Omarchy) | ✅ vérifié | ✅ via le daemon | ✅ | `./install.sh` |
| **Linux + X11** | ✅ | ✅ nativement | ⚠️ tout considéré visible | manuelle |
| **Linux + autre Wayland** (GNOME, KDE, sway) | ✅ | ⚠️ peu fiable, daemon à porter | ⚠️ tout considéré visible | manuelle |
| **macOS** | ✅ | ✅ nativement | ⚠️ tout considéré visible | manuelle + raccourcis à revoir |
| **Windows 10 / 11** | ✅ | ✅ nativement | ⚠️ tout considéré visible | manuelle |
| **Firefox** | ❌ | — | — | — |

Hors Hyprland, seules deux choses manquent, et elles dégradent proprement : le
mode `écrans` considère toutes les fenêtres comme visibles, et le filtre affiche
« Fenêtre 1/2/3 » au lieu des noms d'écran. Le reste fonctionne à l'identique.

**Pourquoi le daemon n'existe que sous Wayland.** Sous Wayland,
`chrome.windows.update({focused:true})` sélectionne la fenêtre en interne mais
ne la remonte pas — le daemon fait le vrai focus via `hyprctl`. Sur macOS,
Windows et X11 l'appel fonctionne nativement : **le daemon n'y sert à rien**.
Sur Windows, le système peut faire clignoter l'icône dans la barre des tâches
plutôt que voler le focus, selon ses règles de premier plan.

> Seule la ligne Hyprland est testée. Les autres décrivent le comportement
> attendu d'après les API utilisées, pas des mesures.

**Porter le daemon** est simple : deux routes HTTP, `POST /focus {title}` et
`GET /visible`. Remplacer les appels `hyprctl` par `swaymsg`, `yabai` ou
l'équivalent suffit — le contrat avec l'extension ne change pas.

**macOS** : `Ctrl+Espace` est pris par le changement de source de saisie. Il
faut ajouter des variantes `"mac"` en `Command+Shift+…` dans `manifest.json`.

---

## Installation

### Linux + Hyprland

```bash
./install.sh          # service systemd --user + --load-extension dans les flags Brave
```

Puis redémarrer le navigateur. Une sauvegarde du fichier de flags est créée.

### Partout ailleurs

1. `chrome://extensions` → activer le **mode développeur** ;
2. **Charger l'extension non empaquetée** → choisir le dossier `extension/` ;
3. régler les raccourcis dans `chrome://extensions/shortcuts`.

Le daemon n'est pas nécessaire (voir la section Compatibilité). Pour le lancer
quand même sous Hyprland : `node daemon/twitch-zap-daemon.mjs` (Node 18+).

---

## Raccourcis

| Touche | Effet |
|---|---|
| `Ctrl+Shift+Espace` | ouvrir la barre de recherche |
| `Ctrl+Shift+X` | revenir à la chaîne précédente |
| `Ctrl+Shift+M` | basculer solo ↔ écrans |
| `Ctrl+Shift+U` | oublier les exceptions, remuter tout |
| `Entrée` | aller sur la chaîne, ou l'ouvrir |
| `Ctrl+Entrée` | lui donner le son **sans** quitter l'onglet courant |
| `Shift+Entrée` | couper / rétablir le son |
| `Alt+1` … `Alt+9` | bascule directe sur la n-ième ligne |
| `Ctrl+↑` / `Ctrl+↓` | volume de la chaîne sélectionnée |
| `Alt+F` | épingler / retirer des favoris |
| `Suppr` | retirer la chaîne de la liste |
| `Échap` | annuler le filtre par fenêtre, sinon fermer |

Navigation dans la liste : `↑` `↓`, `Tab`, ou `Ctrl+P` / `Ctrl+N`.

---

## Architecture

```
extension/
  background.js   moteur : état, mute, économie, statut live, stats
  content.js      dans la page Twitch : clic = j'écoute, volume, pause
  popup.*         recherche, réglages, stats
daemon/           pont Hyprland (Node, 127.0.0.1:8787)
test/             19 scénarios du moteur, API chrome simulées
```

Le point en bas à droite du popup indique si le pont est actif : vert = présent,
gris = absent (l'extension continue, en dégradé).

### Développement

```bash
node test/engine.test.mjs     # teste le moteur sans navigateur
```

> **Incrémenter `version` dans `manifest.json` à chaque changement de code.**
> Sinon le navigateur garde le service worker en cache et un redémarrage complet
> ne suffit pas : les fichiers sont neufs, le worker est vieux. La ligne de
> diagnostic en bas du popup affiche la version réellement exécutée.

---

## Dépannage

| Symptôme | Cause | Correctif |
|---|---|---|
| Les modifications n'ont aucun effet | worker en cache | incrémenter `version`, recharger |
| Statut live vide, stats à zéro | alarme non déclenchée | voir la ligne de diagnostic du popup |
| Volume ou pause sans effet | content script absent | recharger l'onglet |
| Le bon onglet s'active, la fenêtre reste derrière | daemon arrêté | `systemctl --user status twitch-zap` |
| Le son saute en bougeant la souris | option « suivi souris » | la désactiver |
| Tout a le son en même temps | `auto-mute` désactivé | le réactiver |
| Une chaîne reste audible en arrière-plan | exception manuelle | `Ctrl+Shift+U` |

### Si le daemon tombe

Il se relance seul (`Restart=always`, 3 s).

```bash
systemctl --user status twitch-zap
journalctl --user -u twitch-zap -p warning      # que les anomalies
curl -s http://127.0.0.1:8787/health
```

Sont tracés : démarrage, chaque focus réussi ou sans correspondance, requêtes en
erreur, exceptions non rattrapées, conflit de port. Le sondage `/visible` ne
l'est pas, il tourne toutes les 30 s. S'il refuse de repartir :
`systemctl --user reset-failed twitch-zap && systemctl --user start twitch-zap`.

### Désinstallation

```bash
systemctl --user disable --now twitch-zap.service
rm ~/.config/systemd/user/twitch-zap.service
# puis retirer le chemin de --load-extension= dans les flags du navigateur
```

---

## Notes techniques

- **Statut live** : lu dans le `<title>` de la page publique (`… - Live on
  Twitch` contre `… - Twitch`), sans API ni cookie. Le titre arrive au 118ᵉ
  octet, la réponse est coupée dès sa lecture : ~200 ko économisés par chaîne.
- **Mute** : celui de l'onglet. Le flux continue de tourner, seul le son est
  coupé — pas de rebuffering au retour.
- **Stats** : comptées par différence d'horodatage à chaque transition d'état,
  pas par minuterie — justes même quand le service worker est recyclé. Plafond
  de 10 min par intervalle pour ne pas compter une mise en veille.
- **Stockage** : catalogue, volumes, favoris, live et stats dans
  `storage.local` ; exceptions de mute et chaîne courante dans
  `storage.session`, remises à zéro au redémarrage du navigateur.
- **Piège MV3** : `chrome.alarms.create()` à la racine du service worker
  reprogramme l'alarme à chaque réveil, qui n'arrive alors jamais à échéance.
- **Piège rechargement** : recharger une extension n'injecte pas le content
  script dans les onglets déjà ouverts ; `chrome.scripting.executeScript` les
  rattrape, avec un garde anti-double-injection.
- **Hyprland ≥ 0.5x** a migré `hyprctl dispatch` vers une API Lua ; le daemon
  utilise `hl.dispatch(hl.dsp.focus{window=w})`, avec repli sur l'ancienne forme.
