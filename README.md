# Twitch Zap

Navigation instantanée entre toutes les chaînes Twitch ouvertes dans Brave,
avec mute automatique de celles que tu ne regardes pas. Pensé pour un ZEvent :
20 onglets Twitch répartis sur 3 écrans, et zéro clic pour changer de chaîne.

## Ce que ça fait

- `Ctrl+Shift+Space` → une barre de recherche. Tu tapes `raf`, Entrée :
    - la chaîne est déjà ouverte → l'onglet **et** sa fenêtre passent au premier plan,
    - elle ne l'est pas → elle s'ouvre dans un nouvel onglet.
- **Catalogue automatique** : toute chaîne Twitch ouverte (même à la main) entre
  dans la recherche, avec son nom d'affichage et son favicon. Rien à déclarer.
  Elle y reste après fermeture de l'onglet, triée par usage puis récence.
- **Mute auto**, piloté par une _chaîne courante collante_ : elle ne change que
  sur une action volontaire — un zap, un changement d'onglet, ou un clic dans la
  page d'un stream. **Bouger la souris ne change jamais le son**, ce qui est
  indispensable en focus-follows-mouse sur trois écrans.
    - mode `solo` (défaut) : seule la chaîne courante a le son ;
    - mode `écrans` : l'onglet actif de _chaque_ fenêtre Brave affichée garde le
      son (donc jusqu'à 3 flux), et une fenêtre passée sur un workspace masqué se
      coupe toute seule.
    - option `suivi souris` : rétablit l'ancien comportement (le focus de fenêtre
      change la chaîne écoutée). Désactivée par défaut.
- **Exceptions manuelles, dans les deux sens** : un clic sur le haut-parleur
  d'une ligne coupe ou rétablit le son de cette chaîne, et l'auto-mute ne
  reviendra pas dessus. Revenir volontairement sur une chaîne qu'on avait
  forcée au silence lève l'exception. `Ctrl+Shift+U` remet tout à plat.
- **Filtre par fenêtre** : quand plusieurs fenêtres Brave contiennent des
  chaînes, une rangée de puces apparaît, nommée par écran (`DP-1`, `HDMI-A-1`…)
  grâce au daemon. Une fenêtre sur un workspace masqué est barrée.
- **Statut live sans ouvrir la chaîne** : une pastille rouge/grise par ligne, y
  compris pour les chaînes fermées ou les onglets déchargés. Sans recherche, les
  chaînes en direct remontent en tête de liste.
- **Volume par chaîne** : un curseur par ligne (`Ctrl+↑` / `Ctrl+↓` au clavier).
  Mémorisé et réappliqué au rechargement de l'onglet. Le mute onglet reste
  l'interrupteur général, le curseur fait le mixage.
- **Économie CPU/RAM** en trois crans (`eco off` / `eco pause` / `eco décharge`) :
  une chaîne qu'on ne voit sur aucun écran et qu'on n'écoute pas est mise en
  pause, ou l'onglet est entièrement déchargé. Reprise au direct au retour.
- **Statistiques** : temps avec le son et temps à l'écran, par chaîne, par jour.
  Le temps « son actif » exige que l'onglet émette réellement du son — une
  chaîne hors ligne ou en pause ne cumule rien, même si elle n'est pas muette.
- **Favoris** : `Alt+F` ou l'étoile en bout de ligne épingle une chaîne en tête
  de liste, y compris pendant une recherche.
- **Ordre de la liste** : favoris, puis chaînes en direct, puis alphabétique
  (insensible à la casse et aux accents). Pendant une recherche, la pertinence
  passe devant le statut live ; les favoris restent en tête.
- **Corbeille** : l'icône en bout de ligne (ou `Suppr`) retire la chaîne de la
  liste — elle ferme son onglet s'il y en a un, sinon elle reviendrait aussitôt
  par l'index des onglets ouverts.
- **Puce `catalogue`** : masque ou affiche les chaînes connues dont aucun onglet
  n'est ouvert. Taper un nom permet toujours d'en ouvrir une nouvelle.

## Raccourcis

| Touche                              | Effet                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| `Ctrl+Shift+Space`                  | ouvrir la barre de recherche                                                   |
| `Ctrl+Shift+X`                      | revenir à la chaîne précédente                                                 |
| `Ctrl+Shift+M`                      | basculer solo ↔ écrans                                                         |
| `Ctrl+Shift+U`                      | oublier les exceptions, remuter tout                                           |
| `↑` `↓` / `Ctrl+P` `Ctrl+N` / `Tab` | naviguer dans la liste                                                         |
| `Entrée`                            | aller sur la chaîne (ou l'ouvrir)                                              |
| `Ctrl+Entrée`                       | lui donner le son **sans** quitter l'onglet courant                            |
| `Shift+Entrée`                      | couper / rétablir le son de la chaîne                                          |
| `Alt+1` … `Alt+9`                   | zap direct sur la n-ième ligne (d'où la colonne de chiffres, qui s'arrête à 9) |
| `Ctrl+↑` / `Ctrl+↓`                 | volume de la chaîne sélectionnée                                               |
| `Alt+F`                             | épingler / retirer des favoris                                                 |
| `Suppr`                             | retirer la chaîne de la liste (ferme son onglet le cas échéant)                |
| `Échap`                             | annuler le filtre par fenêtre, sinon fermer                                    |

## Architecture

    extension/   extension Brave MV3
      background.js  moteur : etat, mute, economie, statut live, stats
      content.js     dans chaque page Twitch : clic = j'ecoute, volume, pause
      popup.*        barre de recherche fuzzy, reglages, stats
    daemon/      pont Hyprland (node, 127.0.0.1:8787)
    test/        scenarios du moteur, API chrome simulees : node test/engine.test.mjs

Le daemon est **optionnel mais recommandé** : sous Wayland,
`chrome.windows.update({focused:true})` ne remonte pas la fenêtre de façon
fiable. Le daemon fait le vrai focus via `hyprctl` et fournit en plus l'état
« cette fenêtre est-elle affichée sur un écran ? » nécessaire au mode `écrans`.
Sans lui, l'extension fonctionne en mode dégradé (le bon onglet est activé, mais
c'est au compositeur de remonter la fenêtre) et le mode `écrans` considère
toutes les fenêtres visibles.

Le point vert en bas à droite du popup indique si le pont est actif.

## Installation

    ./install.sh

Puis redémarrer Brave complètement. L'installeur :

1. écrit `~/.config/systemd/user/twitch-zap.service` et l'active ;
2. ajoute le chemin de `extension/` à `--load-extension=` dans
   `~/.config/brave-origin-flags.conf` (sauvegarde `.bak.<date>` créée).

## Si le daemon tombe

Il se relance seul (`Restart=always`, 3 s). Le point en bas à droite du popup
passe au gris quand il est absent ; l'extension continue de fonctionner, en
dégradé (pas de remontée de fenêtre, pas de noms d'écran).

    systemctl --user status twitch-zap
    systemctl --user restart twitch-zap
    journalctl --user -u twitch-zap -n 30
    curl -s http://127.0.0.1:8787/health

Le daemon ne tient pas de fichier de log : il écrit sur stdout/stderr et
journald archive (persistant sur cette machine, donc conservé après reboot).
Sont tracés : le démarrage, chaque focus réussi ou sans correspondance, les
requêtes en erreur, les exceptions non rattrapées et le conflit de port. Le
sondage `/visible`, lui, ne l'est pas — il tourne toutes les 30 s.

    journalctl --user -u twitch-zap -p warning     # que les anomalies
    journalctl --user -u twitch-zap --since "2026-09-05"

S'il refuse de repartir après plusieurs échecs :
`systemctl --user reset-failed twitch-zap && systemctl --user start twitch-zap`.

## Désinstallation

    systemctl --user disable --now twitch-zap.service
    rm ~/.config/systemd/user/twitch-zap.service
    # puis retirer le chemin de --load-extension= dans brave-origin-flags.conf

## Notes

- Hyprland ≥ 0.5x a migré `hyprctl dispatch` vers une API Lua ; le daemon
  utilise `hl.dispatch(hl.dsp.focus{window=w})` avec repli sur l'ancienne forme.
- Le mute est celui de l'onglet (API `chrome.tabs.update({muted})`) : le flux
  continue à tourner, seul le son est coupé. Pas de rebuffering au retour.
- Le catalogue, les volumes, le statut live et les stats vivent dans
  `chrome.storage.local` ; les exceptions de mute et la chaîne courante dans
  `chrome.storage.session` (remises à zéro au redémarrage de Brave).
- **Statut live** : lu dans le `<title>` de la page publique
  (`… - Live on Twitch` contre `… - Twitch`), sans API, sans compte et sans
  cookie. La réponse est coupée dès le titre lu (~118 octets), une chaîne est
  re-sondée au plus toutes les 3 minutes, 12 par passage.
- **Stats** : comptées par différence d'horodatage à chaque transition d'état,
  pas par minuterie — donc justes même quand le service worker est recyclé. Un
  plafond de 10 min par intervalle évite de compter une mise en veille.
- Le moteur de décision se teste hors navigateur : `node test/engine.test.mjs`
  (19 scénarios, API `chrome` simulées).
- **Incrémenter `version` dans le manifeste à chaque changement de code.** Sans
  ça, Brave garde le service worker en cache et un redémarrage complet ne suffit
  pas : les fichiers sont neufs, le worker est vieux. La ligne de diagnostic en
  bas du popup affiche la version réellement exécutée.
- **Piège MV3** : `chrome.alarms.create()` au niveau racine du service worker
  reprogramme l'alarme à chaque réveil. Avec des onglets Twitch qui changent de
  titre en permanence, elle n'arrive jamais à échéance et tout ce qui en dépend
  (stats, statut live) reste mort. On la crée sous condition d'absence.
- **Piège rechargement** : recharger une extension n'injecte pas le content
  script dans les onglets déjà ouverts. `chrome.scripting.executeScript` les
  rattrape une fois par session, avec un garde anti-double-injection des deux
  côtés.
- La ligne de diagnostic en bas du popup indique combien de chaînes ont un
  statut live connu et depuis quand — c'est le premier endroit à regarder.
