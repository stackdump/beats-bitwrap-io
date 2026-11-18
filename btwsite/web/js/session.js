// The browser <-> MCP bridge (DESIGN.md "Sessions"): POST /api/session gives an id, an EventSource on
// /api/session/<id>/events delivers what an MCP tool asks (eval, load, stop, get), and the page reports its
// state back about every 500 ms while it plays and whenever it changes. Reconnects with backoff; a session
// the server forgot is made again.

export class SessionLink {
  constructor(app) {
    this.app = app;
    this.api = app.api;
    this.id = null;
    this.es = null;
    this.connected = false;
    this.backoff = 1000;
    this.dirty = true;
    this.lastSent = 0;
    this.timer = 0;
    this.stopped = false;
    this.error = '';
    app.on((type) => {
      if (type === 'eval' || type === 'stop' || type === 'check' || type === 'program' || type === 'edit' || type === 'user') this.dirty = true;
    });
  }

  async start() {
    this.stopped = false;
    try {
      const r = await this.api.createSession();
      this.id = r.id;
      this.error = '';
    } catch (e) {
      this.error = e.message;
      this.retry();
      return;
    }
    this.app.emit('session');
    this.connect();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 250);
  }

  connect() {
    if (this.stopped || !this.id) return;
    if (this.es) this.es.close();
    const es = new EventSource(this.api.eventsUrl(this.id));
    this.es = es;
    es.onopen = () => {
      this.connected = true;
      this.backoff = 1000;
      this.app.emit('session');
    };
    for (const type of ['eval', 'load', 'stop', 'get']) {
      es.addEventListener(type, (m) => this.onEvent(type, m.data));
    }
    es.onerror = () => {
      this.connected = false;
      es.close();
      this.app.emit('session');
      this.retry();
    };
  }

  retry() {
    if (this.stopped) return;
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 30000);
    setTimeout(async () => {
      if (this.stopped) return;
      // the server may have forgotten the session (a restart, the 10 minute TTL): ask again if it is gone
      if (this.id) {
        try { await this.api.report(this.id, this.app.reportState()); this.connect(); return; } catch (e) { if (e.status !== 404) { this.retry(); return; } }
      }
      this.start();
    }, wait);
  }

  async onEvent(type, data) {
    let ev = {};
    try { ev = JSON.parse(data || '{}'); } catch { /* empty */ }
    const app = this.app;
    try {
      if (type === 'get') {
        await this.api.reply(this.id, ev.request_id, app.reportState());
      } else if (type === 'stop') {
        app.stop();
      } else if (type === 'eval') {
        if (typeof ev.text === 'string') app.setProgram(ev.text, { name: 'from a client' });
        app.toast('An assistant sent a program to this page.', 'info');
        if (ev.play || app.isPlaying()) await app.play('eval');
      } else if (type === 'load') {
        const extra = ev.extra || {};
        if (ev.cid) await app.loadByCid(ev.cid);
        else if (extra.example) await app.loadExample(extra.example);
        else if (extra.url) await app.openAny(extra.url);
        else if (typeof ev.text === 'string') app.setProgram(ev.text, { name: 'from a client' });
        app.toast('An assistant loaded a program into this page.', 'info');
        if (ev.play) await app.play('load');
      }
    } catch (e) {
      app.showError(e);
    }
    this.dirty = true;
    this.send();
  }

  tick() {
    const playing = this.app.isPlaying();
    const due = Date.now() - this.lastSent >= (playing ? 500 : 5000);
    if ((this.dirty && Date.now() - this.lastSent >= 150) || due) this.send();
  }

  async send() {
    if (!this.id || this.stopped) return;
    this.lastSent = Date.now();
    this.dirty = false;
    try {
      await this.api.report(this.id, this.app.reportState());
    } catch (e) {
      if (e.status === 404) this.start();
    }
  }
}
