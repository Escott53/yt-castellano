(() => {
    const ss = window.speechSynthesis;
    window.__tts = { speaks: [], dropped: 0, notAllowed: 0, cancels: 0 };
    let lastCancel = 0; let cur = null; let timers = [];
    const voices = [
      { name: 'English United States', lang: 'en-US', localService: true, default: true, voiceURI: 'en' },
      { name: 'Español España', lang: 'es-ES', localService: true, default: false, voiceURI: 'es' },
    ];
    let voicesReady = false;
    ['pointerdown', 'touchend', 'mousedown'].forEach((ev) => document.addEventListener(ev, (e) => { if (e.isTrusted) window.__tapped = true; }, true));
    setTimeout(() => { voicesReady = true; try { ss.dispatchEvent(new Event('voiceschanged')); } catch (e) {} }, 1200);
    Object.defineProperty(ss, 'getVoices', { value: () => (voicesReady ? voices : []) });
    Object.defineProperty(ss, 'speaking', { get: () => !!cur });
    Object.defineProperty(ss, 'pending', { get: () => false });
    Object.defineProperty(ss, 'paused', { get: () => false });
    ss.pause = () => {}; ss.resume = () => {};
    ss.cancel = () => {
      window.__tts.cancels++; lastCancel = performance.now();
      timers.forEach(clearTimeout); timers = [];
      if (cur) { const u = cur; cur = null; setTimeout(() => u.onerror && u.onerror({ error: 'interrupted' }), 0); }
    };
    ss.speak = (u) => {
      const rec = { text: u.text, lang: u.lang, voice: u.voice && u.voice.name, rate: u.rate, t: performance.now(), activated: navigator.userActivation ? navigator.userActivation.hasBeenActive : null };
      window.__tts.speaks.push(rec);
      if ((navigator.userActivation && !navigator.userActivation.hasBeenActive) || (window.__requireTap && !window.__tapped)) {
        window.__tts.notAllowed++; rec.na = true; setTimeout(() => u.onerror && u.onerror({ error: 'not-allowed' }), 5); return;
      }
      if (performance.now() - lastCancel < 30) { window.__tts.dropped++; rec.dropped = true; return; } // quirk Android
      cur = u;
      timers.push(setTimeout(() => { u.onstart && u.onstart({}); }, 30));
      const ms = 30 + (u.text.length / (14 * (u.rate || 1))) * 1000;
      timers.push(setTimeout(() => { if (cur === u) cur = null; u.onend && u.onend({}); }, ms));
    };
})();
