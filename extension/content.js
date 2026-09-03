// Twitch Zap - content script.
// Injecte deux fois (declaratif + rattrapage des onglets deja ouverts), il
// doublerait chaque message : on sort si l'instance precedente est la.
if (globalThis.__twitchZapLoaded) {
    // deja actif dans cet onglet
} else {
    globalThis.__twitchZapLoaded = true;

    // Trois roles :
    //   1. revendiquer le son au clic (remplace le suivi du focus fenetre) ;
    //   2. appliquer un volume par chaine (l'API onglet ne fait que muet/pas muet) ;
    //   3. mettre le lecteur en pause en arriere-plan, et le rattraper au direct.

    let lastClaim = 0;
    function claim() {
        const now = Date.now();
        if (now - lastClaim < 500) return;
        lastClaim = now;
        try {
            chrome.runtime.sendMessage({ type: "claim" });
        } catch {}
    }
    addEventListener("pointerdown", claim, true);
    addEventListener("keydown", claim, true);

    const video = () => document.querySelector("video");

    let wantedVolume = null;
    let paused = false;

    function applyVolume() {
        if (wantedVolume === null) return;
        // Le lecteur Twitch relit sa propre cle localStorage quand il se recree ;
        // on ecrit les deux, sinon le volume repart a 100 % au moindre changement
        // de qualite ou de chaine.
        try {
            localStorage.setItem("volume", String(wantedVolume));
        } catch {}
        const v = video();
        if (!v) return;
        if (Math.abs(v.volume - wantedVolume) > 0.005) v.volume = wantedVolume;
        if (wantedVolume > 0 && v.muted) v.muted = false;
    }

    function seekToLive(v) {
        try {
            if (v.seekable && v.seekable.length) {
                const end = v.seekable.end(v.seekable.length - 1);
                if (end - v.currentTime > 2) v.currentTime = end;
            }
        } catch {}
    }

    // Le lecteur Twitch se recree a chaque changement de qualite ou de chaine :
    // on repose le volume et l'etat de pause sur le nouvel element.
    const reapply = () => {
        const v = video();
        if (!v) return;
        applyVolume();
        if (paused && !v.paused) v.pause();
    };
    setInterval(reapply, 2000);

    // Au chargement (y compris apres un dechargement d'onglet), on redemande son
    // volume au service worker : l'etat vit cote extension, pas dans la page.
    try {
        chrome.runtime.sendMessage({ type: "hello" }, (r) => {
            if (chrome.runtime.lastError || !r) return;
            if (typeof r.volume === "number") {
                wantedVolume = r.volume;
                applyVolume();
            }
        });
    } catch {}

    chrome.runtime.onMessage.addListener((msg, _s, respond) => {
        const v = video();
        switch (msg.type) {
            case "volume":
                wantedVolume = Math.max(0, Math.min(1, msg.value));
                applyVolume();
                respond({ ok: !!v, volume: wantedVolume });
                break;
            case "pause":
                paused = true;
                if (v && !v.paused) v.pause();
                respond({ ok: true });
                break;
            case "resume":
                paused = false;
                if (v) {
                    seekToLive(v);
                    v.play().catch(() => {});
                }
                respond({ ok: true });
                break;
            case "probe":
                respond({
                    ok: true,
                    hasVideo: !!v,
                    volume: v ? v.volume : null,
                    paused: v ? v.paused : null,
                });
                break;
            case "ping":
                respond({ ok: true, hasVideo: !!v });
                break;
            default:
                respond({ ok: false });
        }
        return true;
    });
}
