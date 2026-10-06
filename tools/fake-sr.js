// SpeechRecognition simulado "tipo Chrome Android" para tests headless.
// - start() asíncrono (onstart a los 60 ms); InvalidStateError si ya está en marcha
// - tras SILENCE ms sin voz: onerror 'no-speech' + onend (Android corta solo)
// - stop(): entrega lo oído como final y luego onend; abort(): 'aborted' + onend
// - window.__sr.say(text) simula voz del vídeo; registra si el micro estaba abierto mientras hablaba el TTS
(() => {
  const S = window.__sr = {
    instances: [], starts: 0, stops: 0, aborts: 0, ends: 0, active: null, log: [],
    silenceMs: 1500, deny: false, networkFail: false, startTimes: [],
    activeDuringTts: 0,
  };
  const ttsSpeaking = () => { try { return window.speechSynthesis.speaking; } catch (e) { return false; } };
  class FakeSR {
    constructor() {
      this.lang = ''; this.continuous = false; this.interimResults = false; this.maxAlternatives = 1;
      this._state = 'idle'; this._results = []; this._pending = null; this._timer = 0;
      S.instances.push(this);
    }
    _emit(type, extra) {
      const ev = Object.assign({ type }, extra || {});
      S.log.push({ t: Math.round(performance.now()), type, err: ev.error, tts: ttsSpeaking() });
      const h = this['on' + type]; if (typeof h === 'function') h.call(this, ev);
    }
    _armSilence() {
      clearTimeout(this._timer);
      this._timer = setTimeout(() => { if (this._state === 'running') { this._emit('error', { error: 'no-speech' }); this._end(); } }, S.silenceMs);
    }
    _end() {
      if (this._state === 'ended') return;
      clearTimeout(this._timer); this._state = 'ended';
      if (S.active === this) S.active = null;
      S.ends++;
      setTimeout(() => this._emit('end'), 10);
    }
    start() {
      if (this._state !== 'idle') { const e = new Error('already started'); e.name = 'InvalidStateError'; throw e; }
      this._state = 'starting'; S.starts++; S.startTimes.push(Math.round(performance.now()));
      if (ttsSpeaking()) S.startedDuringTts = (S.startedDuringTts || 0) + 1;
      setTimeout(() => {
        if (this._state !== 'starting') return;
        if (S.deny) { this._emit('error', { error: 'not-allowed' }); this._end(); return; }
        if (S.networkFail) { this._state = 'running'; this._emit('start'); setTimeout(() => { this._emit('error', { error: 'network' }); this._end(); }, 30); return; }
        this._state = 'running'; S.active = this;
        this._emit('start'); this._emit('audiostart');
        this._armSilence();
      }, 60);
    }
    stop() {
      S.stops++;
      if (this._state === 'running' && this._pending) this._final(this._pending);
      if (this._state === 'running' || this._state === 'starting') this._end();
    }
    abort() {
      S.aborts++;
      if (this._state === 'running' || this._state === 'starting') { this._emit('error', { error: 'aborted' }); this._end(); }
    }
    _event(resultIndex) {
      const results = this._results.map((r) => { const a = [{ transcript: r.text, confidence: 0.9 }]; a.isFinal = r.final; return a; });
      return { resultIndex, results };
    }
    _interim(text) {
      const idx = this._results.findIndex((r) => !r.final);
      if (idx >= 0) this._results[idx].text = text; else this._results.push({ text, final: false });
      this._pending = text;
      this._emit('result', this._event(this._results.findIndex((r) => !r.final)));
      this._armSilence();
    }
    _final(text) {
      let idx = this._results.findIndex((r) => !r.final);
      if (idx < 0) { this._results.push({ text, final: true }); idx = this._results.length - 1; } else this._results[idx] = { text, final: true };
      this._pending = null;
      this._emit('result', this._event(idx));
      this._armSilence();
    }
  }
  // Simula que el vídeo dice una frase: parciales y luego final
  S.say = async (text, { finalDelay = 400, dupFinal = false } = {}) => {
    const r = S.active;
    if (!r) return false;
    if (ttsSpeaking()) S.activeDuringTts++;
    const words = text.split(' ');
    r._interim(words.slice(0, Math.ceil(words.length / 2)).join(' '));
    await new Promise((res) => setTimeout(res, finalDelay));
    if (r._state !== 'running') return false;
    r._final(text);
    if (dupFinal) { r._results.push({ text, final: true }); r._emit('result', r._event(r._results.length - 1)); }
    return true;
  };
  // vigila si el micro sigue abierto mientras suena la voz (no debería)
  setInterval(() => { if (S.active && ttsSpeaking()) S.activeDuringTts++; }, 50);
  window.SpeechRecognition = undefined;
  window.webkitSpeechRecognition = FakeSR;
})();
