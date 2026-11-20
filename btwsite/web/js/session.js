// The browser <-> MCP bridge (DESIGN.md "Sessions"): POST /api/session gives an id, an EventSource on
// /api/session/<id>/events delivers what an MCP tool asks (eval, load, stop, get, and queue: the up-next list changed), and the page reports its
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
      if (type === 'eval' || type === 'stop' || type === 'check' || type === 'program' || type === 'edit') this.dirty = true;
      // a session belongs to whoever made it: signing in or out makes a new one, so an MCP token of this user reaches this tab
      if (type === 'user' && this.id && this.userKey !== this.currentUserKey()) this.restart();
    });
    this.userKey = this.currentUserKey();
  }

  currentUserKey() {
    return (this.app.user && this.app.user.id) || '';
  }

  restart() {
    if (this.es) this.es.close();
    this.es = null;
    this.connected = false;
    this.id = null;
    this.userKey = this.currentUserKey();
    this.start();
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
      this.syncQueue();
    };
    for (const type of ['eval', 'load', 'stop', 'get', 'queue']) {
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

  /** Read this session's up-next queue (after a (re)connect: a queue event sent while the stream was down is lost). */
  async syncQueue() {
    if (!this.id || !this.app.upNext || !this.api.queueGet) return;
    try {
      const r = await this.api.queueGet(this.id);
      if (r && r.queue) this.app.upNext.setView(r.queue);
    } catch { /* an older server has no queue */ }
  }

  /**
   * One pushed event. What arrives here is from whoever drives this session over MCP (the server has checked who), but the
   * page does not take it on trust: it can set the editor's text, load a CID or an example by name, play and stop, and
   * nothing else. There is no event that navigates, fetches a URL of its own choosing or reaches the DOM as markup:
   * text goes to the editor (size-limited by setProgram), a CID or an example name is checked against its pattern before
   * it becomes part of a path, and a link is opened by the module (which fetches nothing).
   */
  async onEvent(type, data) {
    let ev = {};
    try { ev = JSON.parse(data || '{}'); } catch { /* empty */ }
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) ev = {};
    const app = this.app;
    const str = (v) => (typeof v === 'string' ? v : undefined);
    try {
      if (type === 'get') {
        const rid = str(ev.request_id);
        if (rid && rid.length <= 128) await this.api.reply(this.id, rid, app.reportState());
      } else if (type === 'queue') {
        // the queue changed (MCP add/remove/clear, or an advance), or MCP asked to skip: the page only shows the list,
        // and a skip is an ordinary advance, under the same presence rules as the end of a track
        const extra = ev.extra && typeof ev.extra === 'object' ? ev.extra : {};
        if (app.upNext && extra.queue && typeof extra.queue === 'object') app.upNext.setView(extra.queue);
        if (app.upNext && extra.action === 'skip') app.upNext.advance('skip');
        return;
      } else if (type === 'stop') {
        app.stop();
      } else if (type === 'eval') {
        if (typeof ev.text === 'string') app.setProgram(ev.text, { name: 'from a client' });
        app.toast('An assistant sent a program to this page.', 'info');
        if (ev.play === true || app.isPlaying()) await app.play('eval');
      } else if (type === 'load') {
        const extra = ev.extra && typeof ev.extra === 'object' ? ev.extra : {};
        if (str(ev.cid)) await app.loadByCid(ev.cid);
        else if (str(extra.example)) await app.loadExample(extra.example);
        else if (str(extra.url)) await app.openAny(extra.url);
        else if (typeof ev.text === 'string') app.setProgram(ev.text, { name: 'from a client' });
        app.toast('An assistant loaded a program into this page.', 'info');
        if (ev.play === true) await app.play('load');
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
