// The panels: a drawer for compose, the MCP panel and sign-in, and two small popovers for share and open.
// Built with DOM calls (no inline handlers, no innerHTML of anything from the server). Loaded when first asked for.

import { h, shortCid, accountKind } from './util.js';
import { describeError, ApiError } from './errors.js';
import { qrChoice } from './qr-model.js';
import { signIn, hasWallet, localKeyInfo, resetLocalKey } from './auth.js';

const GENRES = ['ambient', 'dnb', 'dubstep', 'house', 'techno', 'trance', 'lofi', 'jazz', 'bossa', 'funk', 'hardcore', 'breakbeat', 'synthwave', 'garage'];

export class Panels {
  constructor(app) {
    this.app = app;
    this.el = app.el;
    this.current = null;
    this.trigger = null;
    this.abort = null;
    this.tokenView = null; // the node that shows a new MCP token: kept across re-renders, dropped when the panel closes
    app.on((type) => {
      if (this.current === 'mcp' && (type === 'session' || type === 'user')) this.render();
      if (this.current === 'phone' && type === 'user') { this.phoneStop(); this.render(); }
      if ((this.current === 'compose' || this.current === 'user') && type === 'user') this.render();
      if (this.current === 'compose' && (type === 'check' || type === 'program')) this.refreshFork();
    });
  }

  show(which) {
    const tb = { compose: 'btn-compose', mcp: 'btn-mcp', phone: 'btn-phone', user: 'btn-user', share: 'btn-share', open: 'btn-open' }[which];
    if (this.current === which) return this.close();
    this.close();
    this.current = which;
    this.trigger = this.el[tb];
    this.trigger.setAttribute('aria-expanded', 'true');
    this.render();
  }

  close() {
    if (this.abort) this.abort.abort();
    this.phoneStop();
    this.wipeToken();
    // the focus is in the panel (or nowhere) when it closes: it goes back to the button that opened it
    const ae = document.activeElement;
    const inPanel = !ae || ae === document.body || this.el.drawer.contains(ae) || !!(this.app.pop && this.app.pop.contains(ae));
    this.el.drawer.hidden = true;
    this.popClose();
    for (const b of ['btn-compose', 'btn-mcp', 'btn-phone', 'btn-user', 'btn-share', 'btn-open']) this.el[b].setAttribute('aria-expanded', 'false');
    const was = this.trigger;
    this.current = null;
    this.trigger = null;
    // a button inside the closed narrow-screen menu cannot take the focus: the menu's button does
    if (was && inPanel) (was.getClientRects().length ? was : this.el['btn-menu'] || was).focus();
  }

  popClose() {
    if (this.app.pop) { this.app.pop.remove(); this.app.pop = null; }
  }

  /** A token is shown once and kept nowhere: when the panel closes or the user signs out it leaves the page's DOM. */
  wipeToken() {
    if (this.tokenView) this.tokenView.remove();
    this.tokenView = null;
  }

  render() {
    const w = this.current;
    if (!w) return;
    if (w === 'share') return this.share();
    if (w === 'open') return this.open();
    const body = this.el['drawer-body'];
    const title = { compose: 'Compose', mcp: 'MCP', phone: 'Mobile', user: this.app.user ? 'Account' : 'Sign in' }[w];
    this.el['drawer-title'].textContent = title;
    body.replaceChildren(...(w === 'compose' ? this.composeBody() : w === 'mcp' ? this.mcpBody() : w === 'phone' ? this.phoneBody() : this.userBody()));
    this.el.drawer.hidden = false;
    this.popClose();
    const first = body.querySelector('textarea:not(:disabled), input:not(:disabled), select:not(:disabled), button:not(:disabled)'); // a disabled control cannot take the focus
    if (first && !this._noFocus) first.focus({ preventScroll: true });
  }

  // ---- sign-in ------------------------------------------------------------------------------------------------------

  /** The hosts a sign-in challenge may name: this page's, and the server's public URL's. */
  signInHosts() {
    const hosts = [location.host];
    try { hosts.push(new URL(this.app.info.public_url).host); } catch { /* no public url */ }
    return hosts;
  }

  userBody() {
    const app = this.app;
    const u = app.user;
    const out = [];
    const status = h('div', { role: 'status' });
    if (u) {
      out.push(h('p', { class: 'note' }, `Signed in with ${accountKind(u)}. Your account's key:`));
      out.push(h('pre', { class: 'acct-key', title: u.id }, u.id));
      out.push(h('p', { class: 'note' }, 'You can compose, create MCP tokens and let an assistant drive this page.'));
      out.push(h('button', { type: 'button', class: 'tb', onclick: async () => { try { await app.api.logout(); } catch (e) { app.showError(e); } this.wipeToken(); app.user = null; app.updateUser(); this.render(); } }, 'Sign out'));
      if (u.kind === 'ed25519') {
        out.push(h('p', { class: 'note' }, 'Your identity is a key kept in this browser. Clearing site data loses it, and the account with it.'));
      }
      out.push(this.legalLinks());
      return out;
    }
    out.push(h('p', { class: 'note' }, 'Anyone can read, play, share and open programs. Signing in is for composing with a model and for driving this page from an assistant over MCP. You prove who you are by signing a one-time message; no password and no email.'));
    const doSign = async (kind) => {
      status.replaceChildren();
      try {
        app.user = await signIn(app.api, kind, { hosts: this.signInHosts() });
        app.updateUser();
        this.render();
      } catch (e) {
        const d = describeError(e);
        status.replaceChildren(h('div', { class: 'err' }, d.title));
      }
    };
    const wallet = h('button', { type: 'button', class: 'tb primary', disabled: !hasWallet(), onclick: () => doSign('eth') }, 'Sign in with a wallet');
    out.push(wallet);
    if (!hasWallet()) out.push(h('p', { class: 'note' }, 'No wallet extension was found in this browser (an eth wallet such as MetaMask provides window.ethereum).'));
    out.push(h('button', { type: 'button', class: 'tb', onclick: () => doSign('ed25519') }, localKeyInfo() ? 'Sign in with this browser\'s key' : 'Make a browser key and sign in'));
    out.push(h('p', { class: 'note' }, 'A browser key is an Ed25519 key made here and kept in this browser, where this page can use it to sign but nothing can read it out. It identifies you on this site only and is lost if you clear site data.'));
    const k = localKeyInfo();
    if (k) {
      out.push(h('p', { class: 'note' }, 'This browser\'s key: ', h('code', {}, `${k.slice(0, 10)}…${k.slice(-6)}`)));
      out.push(h('button', { type: 'button', class: 'tb tb-sm', onclick: async () => { await resetLocalKey(); this.render(); } }, 'Forget this key'));
    }
    out.push(status);
    out.push(this.legalLinks());
    return out;
  }

  /** The privacy policy and the delete-account page: plain links, reachable without signing in. */
  legalLinks() {
    return h('p', { class: 'note legal' }, h('a', { href: '/privacy', class: 'link' }, 'Privacy policy'), h('a', { href: '/delete-account', class: 'link' }, 'Delete your account and data'));
  }

  // ---- compose ----------------------------------------------------------------------------------------------------------

  composeBody() {
    const app = this.app;
    const info = app.info && app.info.compose;
    const signedIn = !!app.user;
    const notConfigured = info && info.configured === false;
    const disabledAll = !signedIn || notConfigured || (info && info.enabled === false);
    const out = [];
    if (!signedIn) {
      out.push(h('p', { class: 'note warn' }, 'Compose is for signed-in users: a model writes a BeatScript program for you, and it costs something to run. Sign in (a wallet or a key in this browser), then come back.'));
      out.push(h('button', { type: 'button', class: 'tb primary', onclick: () => app.panel('user') }, 'Sign in'));
    } else if (notConfigured) {
      out.push(h('p', { class: 'note warn' }, 'Compose is not configured on this server (there is no model key).'));
    } else if (info && info.enabled === false) {
      out.push(h('p', { class: 'note warn' }, 'Compose is switched off for now.'));
    } else {
      out.push(h('p', { class: 'note' }, 'Describe a track. A model writes the program, the checker fixes it up to three times, and the result is stored as CC0 and plays at once.'));
      out.push(h('p', { class: 'note' }, (app.info && app.info.notice) || 'Everything generated here is public: the program, its link and its audio are released under CC0-1.0, and the prompt goes to a third-party model.', ' ', h('a', { href: "/privacy#generated", class: "link", target: "_blank", rel: "noopener" }, 'Privacy and licence')));
    }
    const maxPrompt = String((info && info.limits && info.limits.max_prompt_chars) || 800);
    const prompt = h('textarea', { id: 'c-prompt', maxlength: maxPrompt, placeholder: 'dark techno, 128, with an acid line that opens up', 'aria-label': 'What to compose' });
    const genre = h('input', { type: 'text', id: 'c-genre', list: 'c-genres', placeholder: 'genre' });
    const dl = h('datalist', { id: 'c-genres' }, ...GENRES.map((g) => h('option', { value: g })));
    const bpm = h('input', { type: 'number', id: 'c-bpm', min: '40', max: '300', step: '1', placeholder: 'bpm' });
    const key = h('input', { type: 'text', id: 'c-key', placeholder: 'key, e.g. am' });
    const len = h('select', { id: 'c-len' }, ...['', 'short', 'medium', 'long'].map((v) => h('option', { value: v }, v || 'any length')));
    this.fork = h('input', { type: 'checkbox', id: 'c-fork' });
    this.forkLabel = h('label', { class: 'check' }, this.fork, h('span', {}, 'fork the current program'));
    const status = h('div', { role: 'status' });
    const go = h('button', { type: 'button', class: 'tb primary' }, 'Compose');
    const fs = h('fieldset', { class: 'plain', disabled: disabledAll },
      h('label', {}, 'Prompt', prompt),
      h('div', { class: 'row' }, h('label', {}, 'Genre', genre, dl), h('label', {}, 'BPM', bpm)),
      h('div', { class: 'row' }, h('label', {}, 'Key', key), h('label', {}, 'Length', len)),
      this.forkLabel, go);
    out.push(fs, status);
    this.refreshFork();
    go.addEventListener('click', async () => {
      const req = { prompt: prompt.value.trim() };
      if (!req.prompt) { status.replaceChildren(h('div', { class: 'err' }, 'Write a prompt first.')); return; }
      if (genre.value.trim()) req.genre = genre.value.trim();
      if (bpm.value) req.bpm = Number(bpm.value);
      if (key.value.trim()) req.key = key.value.trim();
      if (len.value) req.length = len.value;
      if (this.fork.checked && !this.fork.disabled && app.cid) req.base_cid = app.cid;
      app.ensureAudio(); // the click is the gesture the sound needs
      go.disabled = true;
      go.textContent = 'Composing…';
      status.replaceChildren(h('p', { class: 'note' }, 'Asking the model, then checking what it wrote…'));
      this.abort = new AbortController();
      try {
        const r = await app.api.compose(req, this.abort.signal);
        const attempts = r.attempts || [];
        app.stored.add(r.cid);
        // the text as the model wrote it keeps its comments; they are not in the CID, so it checks to the same one
        app.setProgram(r.text || r.program, { name: req.prompt.slice(0, 48), cid: r.cid });
        if (r.program && (!app.report || app.report.cid !== r.cid)) app.setProgram(r.program, { name: req.prompt.slice(0, 48), cid: r.cid });
        status.replaceChildren(h('div', { class: 'okbox' },
          h('div', {}, h('b', {}, 'Composed. '), `${attempts.length} attempt${attempts.length === 1 ? '' : 's'}`, r.cost_usd != null ? ` · $${Number(r.cost_usd).toFixed(4)}` : '', ` · ${r.composedBy || r.model || ''}`),
          h('div', { class: 'note' }, 'CID ', h('code', {}, shortCid(r.cid, 8, 8)), ` · ${r.license || 'CC0-1.0'}${r.forkedFrom ? ` · forked from ${shortCid(r.forkedFrom)}` : ''}`),
          ...(attempts.length > 1 ? [h('pre', {}, attempts.map((a) => `attempt ${a.n}: ${a.ok ? 'ok' : `${a.errors} error(s)`}`).join('\n'))] : [])));
        await app.play('load'); // the stream starts at once; the engine loads behind it
      } catch (e) {
        if (e.name === 'AbortError') return;
        const d = describeError(e);
        status.replaceChildren(h('div', { class: 'err' }, d.title, ...(d.lines.length ? [h('pre', {}, d.lines.join('\n'))] : [])));
        if (e instanceof ApiError && e.code === 'auth_required') { app.user = null; app.updateUser(); }
      } finally {
        go.disabled = false;
        go.textContent = 'Compose';
        this.abort = null;
      }
    });
    return out;
  }

  /** "Fork current" works when the current program's CID is stored on the server (an example, or one put or composed). */
  refreshFork() {
    if (!this.fork) return;
    const app = this.app;
    const cid = app.report && app.report.ok ? app.report.cid : null;
    const stored = !!cid && (app.stored.has(cid) || app.examples.some((e) => e.cid === cid));
    this.fork.disabled = !stored;
    if (!stored) this.fork.checked = false;
    this.forkLabel.title = stored ? 'The model edits this program instead of starting fresh' : 'Play the program once (or pick an example) so the server has it, then it can be forked';
  }

  // ---- MCP ------------------------------------------------------------------------------------------------------------------

  mcpBody() {
    const app = this.app;
    const out = [];
    const sid = app.session && app.session.id;
    const origin = (app.info && app.info.public_url) || location.origin;
    out.push(h('p', { class: 'note' }, 'An assistant (Claude Code, for one) can use this site over MCP: write, check and format programs, and drive this very page so you can listen while it works.'));
    out.push(h('div', {}, h('div', { class: 'note' }, 'This page\'s session id'), h('pre', {}, sid || (app.session && app.session.error) || 'connecting…'),
      h('p', { class: 'note' }, app.session && app.session.connected ? 'Connected: tools that target a session can reach this tab.' : 'Not connected yet.')));
    const result = h('div', { role: 'status' });
    if (this.tokenView && app.user) result.append(this.tokenView); // a token already shown stays until the panel is closed
    const make = h('button', { type: 'button', class: 'tb primary', disabled: !app.user, onclick: async () => {
      make.disabled = true;
      try {
        const r = await app.api.createToken();
        const cmd = `claude mcp add --transport http beatscript ${origin.replace(/\/$/, '')}/mcp --header "Authorization: Bearer ${r.token}"`;
        this.tokenView = h('div', { class: 'okbox' }, h('b', {}, 'Your token (shown once):'), h('pre', {}, r.token), h('div', { class: 'note' }, 'Add it to Claude Code:'), h('pre', {}, cmd),
          h('button', { type: 'button', class: 'tb tb-sm', onclick: () => this.copy(cmd) }, 'Copy the command'),
          h('p', { class: 'note warn' }, 'It is not stored and cannot be shown again. Make another if you lose it. It leaves this page when you close this panel.'));
        result.replaceChildren(this.tokenView);
      } catch (e) {
        const d = describeError(e);
        result.replaceChildren(h('div', { class: 'err' }, d.title));
      } finally { make.disabled = !app.user; }
    } }, 'Create an MCP token');
    out.push(make);
    if (!app.user) out.push(h('p', { class: 'note warn' }, 'Sign in to make a token (the write tools, eval, load and compose, need one).'), h('button', { type: 'button', class: 'tb', onclick: () => app.panel('user') }, 'Sign in'));
    else out.push(h('button', { type: 'button', class: 'tb tb-sm', onclick: async () => { try { await app.api.revokeTokens(); this.wipeToken(); app.toast('All your MCP tokens and app connections are revoked.', 'ok'); if (this.reloadConnections) this.reloadConnections(); } catch (e) { app.showError(e); } } }, 'Revoke all my tokens'));
    out.push(result);
    out.push(h('p', { class: 'note' }, 'Or connect without a token: claude.ai and Claude Code sign in by OAuth. Add ', h('code', {}, `${origin.replace(/\/$/, '')}/mcp`), ' as a connector (or ', h('code', {}, `claude mcp add --transport http beatscript ${origin.replace(/\/$/, '')}/mcp`), ') and approve it here when asked.'));
    if (app.user) out.push(this.connectionsView());
    out.push(h('p', { class: 'note' }, 'Read-only tools (check, fmt, share, open, instruments, list_examples) need no token. Docs for assistants: ', h('a', { href: '/llms.txt', class: 'link' }, '/llms.txt'), '.'));
    return out;
  }

  /** The signed-in account's OAuth connections (each with Disconnect) and pasted tokens (when each was made). */
  connectionsView() {
    const app = this.app;
    const box = h('div', { class: 'connections' }, h('div', { class: 'note' }, 'Loading connections…'));
    const when = (t) => { try { return new Date(typeof t === 'number' ? t * 1000 : t).toLocaleString(); } catch { return String(t); } };
    const load = async () => {
      try {
        const r = await app.api.connections();
        const rows = [];
        rows.push(h('div', { class: 'note' }, (r.clients || []).length ? 'Connected apps:' : 'No apps connected by OAuth.'));
        for (const c of r.clients || []) {
          rows.push(h('div', { class: 'conn' }, h('b', {}, c.client_name), ' ', h('span', { class: 'note' }, `→ ${c.redirect_uri} · since ${when(c.created)} · last used ${when(c.last_used)}`), ' ',
            h('button', { type: 'button', class: 'tb tb-sm', onclick: async () => { try { await app.api.disconnect(c.id); app.toast(`${c.client_name} is disconnected.`, 'ok'); load(); } catch (e) { app.showError(e); } } }, 'Disconnect')));
        }
        const toks = r.tokens || [];
        rows.push(h('div', { class: 'note' }, toks.length ? `Pasted tokens: ${toks.length} (made ${toks.map((t) => when(t.created)).join(', ')}).` : 'No pasted tokens.'));
        box.replaceChildren(...rows);
      } catch (e) {
        box.replaceChildren(h('div', { class: 'note' }, 'Connections are not available on this server.'));
      }
    };
    load();
    this.reloadConnections = load;
    return box;
  }

  // ---- phone: pair the BeatScript Android app by a QR code (btwsite/PAIRING.md) ----------------------------------------------------------

  phoneStop() {
    clearTimeout(this.phoneTimer);
    clearTimeout(this.phoneListTimer);
    this.phoneTimer = this.phoneListTimer = null;
    this.phoneOffer = null;
  }

  phoneBody() {
    const app = this.app;
    const out = [];
    out.push(h('p', { class: 'note' }, 'Connect the BeatScript app on an Android phone: in the app open the menu, then beatscript.app › Scan to connect, and point it at the code (or scan it with the phone\'s camera, which opens the app). It is a pairing code, not an invite. Then this page (and an assistant over MCP) can send programs to the phone and play them there.'));
    if (!app.user) {
      out.push(h('p', { class: 'note warn' }, 'Sign in first: a phone is paired to your identity (a wallet or this browser\'s key).'), h('button', { type: 'button', class: 'tb primary', onclick: () => app.panel('user') }, 'Sign in'));
      return out;
    }
    const qrBox = h('div', { class: 'pair-qr', role: 'status' });
    const list = h('div', { class: 'pair-devices' });
    const show = h('button', { type: 'button', class: 'tb primary', onclick: () => this.phoneOfferNew(qrBox, list) }, 'Show a pairing code');
    out.push(show, qrBox);
    const beta = app.info && app.info.android_beta_url;
    if (beta) out.push(h('p', { class: 'note pair-beta' }, 'Don\'t have the app? ', h('a', { href: beta, class: 'link', target: '_blank', rel: 'noopener' }, 'Join the Android beta on Google Play →')));
    out.push(h('h3', {}, 'Paired phones'), list);
    out.push(h('p', { class: 'note' }, 'The code works once and for two minutes. It carries no lasting secret: the phone makes its own key, and only its public half is kept here. Unpair here or on the phone at any time.'));
    this.phoneList(list);
    return out;
  }

  async phoneOfferNew(qrBox, list) {
    this.phoneStop();
    try {
      const o = await this.app.api.pairNew();
      this.phoneOffer = o;
      const left = h('span', {});
      qrBox.replaceChildren(h('img', { src: o.qr, alt: 'Pairing QR code', width: '240', height: '240', class: 'qr' }),
        h('p', { class: 'note' }, 'Waiting for the phone… ', left));
      const ends = Date.now() + o.expires_in * 1000;
      const tick = async () => {
        if (this.phoneOffer !== o || this.current !== 'phone') return;
        const s = Math.max(0, Math.round((ends - Date.now()) / 1000));
        left.textContent = `(${s} s)`;
        let st = null;
        try { st = await this.app.api.pairState(o.pair_id); } catch { /* keep trying until it expires */ }
        if (st && st.state === 'paired') {
          const d = st.device || {};
          qrBox.replaceChildren(h('div', { class: 'okbox' }, h('b', {}, `Paired: ${d.name || 'a phone'}`), h('div', { class: 'note' }, 'Its key fingerprint (the phone shows the same): ', h('code', {}, d.fingerprint || '?'))));
          this.phoneOffer = null;
          this.phoneList(list);
          return;
        }
        if ((st && st.state !== 'waiting') || s === 0) {
          const why = st && st.state === 'used' ? 'That code was used up.' : 'That code expired.';
          qrBox.replaceChildren(h('p', { class: 'note warn' }, `${why} Show a new one to try again.`));
          this.phoneOffer = null;
          return;
        }
        this.phoneTimer = setTimeout(tick, 1000);
      };
      tick();
    } catch (e) {
      qrBox.replaceChildren(h('div', { class: 'err' }, describeError(e).title));
    }
  }

  async phoneList(list) {
    const app = this.app;
    clearTimeout(this.phoneListTimer);
    // while the panel is open the list follows the phones' connection state
    this.phoneListTimer = setTimeout(() => { if (this.current === 'phone' && list.isConnected) this.phoneList(list); }, 4000);
    let r;
    try { r = await app.api.devices(); } catch (e) { list.replaceChildren(h('div', { class: 'err' }, describeError(e).title)); return; }
    const ds = (r && r.devices) || [];
    if (!ds.length) { list.replaceChildren(h('p', { class: 'note' }, 'None yet.')); return; }
    list.replaceChildren(...ds.map((d) => {
      const st = d.state || {};
      const line = d.connected ? (st.playing ? `connected, playing${st.section ? ` (${st.section}, bar ${st.bar})` : ''}` : 'connected') : `not connected${d.last_seen ? ` (last seen ${d.last_seen})` : ''}`;
      const push = async (type) => {
        try {
          const body = type === 'stop' ? { type } : { type: 'eval', text: app.editor.text, play: true };
          await app.api.pushDevice(d.id, body);
          app.toast(type === 'stop' ? `Stopped ${d.name}.` : `Sent to ${d.name}.`, 'ok');
        } catch (e) { app.showError(e); }
        this.phoneList(list);
      };
      return h('div', { class: 'pair-device' },
        h('div', {}, h('b', {}, d.name), ' ', h('code', { title: 'key fingerprint' }, d.fingerprint)),
        h('div', { class: 'note' }, line),
        h('button', { type: 'button', class: 'tb tb-sm primary', disabled: !d.connected, onclick: () => push('eval') }, 'Play this on the phone'),
        h('button', { type: 'button', class: 'tb tb-sm', disabled: !d.connected, onclick: () => push('stop') }, 'Stop'),
        h('button', { type: 'button', class: 'tb tb-sm', onclick: async () => { try { await app.api.unpairDevice(d.id); app.toast(`Unpaired ${d.name}.`, 'ok'); } catch (e) { app.showError(e); } this.phoneList(list); } }, 'Unpair'));
    }));
  }

  // ---- share + open popovers -----------------------------------------------------------------------------------------------------

  pop(title, ...kids) {
    this.popClose();
    this.el.drawer.hidden = true;
    const box = h('div', { class: 'pop', role: 'dialog', 'aria-label': title }, h('h3', {}, title), ...kids);
    this.app.pop = box;
    document.getElementById('app').append(box);
    return box;
  }

  async copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      this.app.toast('Copied.', 'ok');
      return true;
    } catch {
      this.app.toast('Could not copy automatically; select the text and copy it.', 'warn');
      return false;
    }
  }

  share() {
    const app = this.app;
    const text = app.editor.text;
    const report = app.runCheckNow();
    if (app.isPrivate(text, report)) {
      // a link carries the program's text, and its social form is carded by the server: a private program makes none
      app.toast('This program is private (restricted sounds, assets or #! visibility: private), so there is no share link for it. Remove what makes it private to share it.', 'warn');
      this.current = null;
      this.trigger && this.trigger.setAttribute('aria-expanded', 'false');
      return;
    }
    if (!report || !report.ok) {
      app.toast('Fix the errors before sharing: a link carries a program that checks.', 'warn');
      this.current = null;
      this.trigger && this.trigger.setAttribute('aria-expanded', 'false');
      return;
    }
    const origin = (app.info && app.info.public_url) || location.origin;
    const build = (withNotes) => {
      const r = app.btw.share(text, null, !!withNotes, origin);
      if (!r.ok) throw new ApiError({ code: 'bad_request', message: r.error || 'the program could not be shared' });
      return r;
    };
    const notes = h('input', { type: 'checkbox', id: 'sh-notes' });
    const rows = h('div', { class: 'stack' });
    const paint = () => {
      let r;
      try { r = build(notes.checked); } catch (e) { rows.replaceChildren(h('div', { class: 'err' }, describeError(e).title)); return; }
      const row = (label, url, extra) => h('div', {}, h('div', { class: 'note' }, label, extra ? ` · ${extra}` : ''), h('div', { class: 'linkrow' }, h('input', { type: 'text', readonly: true, value: url, 'aria-label': label, onfocus: (e) => e.target.select() }), h('button', { type: 'button', class: 'tb tb-sm', onclick: () => this.copy(url) }, 'Copy')));
      rows.replaceChildren(
        row('Self-sealing link', r.url, `${r.chars} characters`),
        row('Link for posts (shows a card)', r.social_url || r.url));
      const frag = r.url.split('#')[1];
      if (frag) history.replaceState(null, '', `#${frag}`);
      this.lastShare = r;
    };
    paint();
    notes.addEventListener('change', paint);
    // The CID-only form: the program is kept on this server under its CID (rights: CC0-1.0), so the link is short. Signed-in only.
    const shortBox = h('div', { class: 'stack' });
    // The QR code: the app's link (`/p#CID.packed`, no notes), else the short link, else a note. Drawn by POST /api/qr.
    const qrBox = h('div', { class: 'qrbox' });
    let shortStored = false;
    let qrSeq = 0;
    const paintQR = async () => {
      const seq = ++qrSeq;
      let rep;
      try { rep = build(false); } catch { qrBox.replaceChildren(); return; }
      const c = qrChoice({ report: rep, origin, signedIn: !!app.user, shortStored: shortStored && this.lastShare && this.lastShare.cid === rep.cid });
      if (!c.link) { qrBox.replaceChildren(h('div', { class: 'note' }, c.message)); return; }
      qrBox.replaceChildren(h('div', { class: 'note' }, 'Drawing the QR code…'));
      try {
        const q = await app.api.qr(c.link);
        if (seq !== qrSeq) return;
        // whole pixels per module, at least 3 (a camera needs it), up to 8 for a small code; the quiet zone is 4 modules a side
        const side = (q.modules + 8) * Math.max(3, Math.min(8, Math.floor(300 / (q.modules + 8))));
        qrBox.replaceChildren(
          h('img', { class: 'qrimg', src: q.qr, width: side, height: side, alt: `QR code for the link to this program (${c.chars} characters). Scan it with a phone camera to open the program in BeatScript.` }),
          h('div', { class: 'note' }, c.message));
      } catch (e) {
        if (seq === qrSeq) qrBox.replaceChildren(h('div', { class: 'note' }, `No QR code: ${describeError(e).title}. The links above still work.`));
      }
    };
    // The family tree of a program the server keeps: how many forks it has, where it came from, a link to /p/<CID>/tree.
    const treeBox = h('div', { class: 'stack' });
    const paintTree = async (cid) => {
      if (!cid) { treeBox.replaceChildren(); return; }
      let t;
      try { t = await app.api.lineage(cid); } catch { treeBox.replaceChildren(); return; } // not stored, or not public: nothing to show
      if (!t || t.program !== cid) return;
      const n = t.forkCount | 0;
      const forks = n === 0 ? 'no forks yet' : n === 1 ? '1 fork' : `${n} forks`;
      const from = Array.isArray(t.ancestors) && t.ancestors.length ? ` · forked from ${shortCid(t.ancestors[0])}` : '';
      treeBox.replaceChildren(h('div', { class: 'note' }, h('a', { href: `/p/${cid}/tree`, target: '_blank', rel: 'noopener' }, 'Family tree'), ` · ${forks}${from}`));
    };
    const paintShort = (links) => {
      if (links) { shortStored = true; paintQR(); paintTree(this.lastShare && this.lastShare.cid); }
      const row = (label, url) => h('div', {}, h('div', { class: 'note' }, label), h('div', { class: 'linkrow' }, h('input', { type: 'text', readonly: true, value: url, 'aria-label': label, onfocus: (e) => e.target.select() }), h('button', { type: 'button', class: 'tb tb-sm', onclick: () => this.copy(url) }, 'Copy')));
      if (links) {
        shortBox.replaceChildren(row('Short link (CID only; the page fetches and checks it)', links.short_url), row('Short link for posts (shows a card)', links.short_social_url), row('Short link in beats.bitwrap.io', links.short_beats_url));
        return;
      }
      if (!app.user) {
        shortBox.replaceChildren(h('div', { class: 'note' }, 'A CID-only short link keeps the program on this server. Sign in to make one.'), h('button', { type: 'button', class: 'tb tb-sm', onclick: () => app.panel('user') }, 'Sign in'));
        return;
      }
      const mk = h('button', { type: 'button', class: 'tb tb-sm', onclick: async () => {
        mk.disabled = true;
        try {
          const cur = this.lastShare;
          paintShort(await app.api.putShare(cur.cid, { text: cur.canonical }));
        } catch (e) {
          mk.disabled = false;
          if (e instanceof ApiError && e.code === 'auth_required') { app.user = null; app.updateUser(); paintShort(); return; }
          app.showError(e);
        }
      } }, 'Make short link');
      shortBox.replaceChildren(h('div', { class: 'note' }, 'A CID-only short link keeps the program on this server (public, CC0-1.0) instead of carrying it in the link.'), mk);
    };
    paintShort();
    paintQR();
    if (this.lastShare && (app.stored.has(this.lastShare.cid) || app.examples.some((e) => e.cid === this.lastShare.cid))) paintTree(this.lastShare.cid);
    const box = this.pop('Share this program', h('p', { class: 'note' }, 'The link carries the program and its CID; opening it checks that the text hashes to the CID before anything plays. The address bar now holds it too.'),
      rows, qrBox, shortBox, treeBox, h('label', { class: 'check dim' }, notes, 'also carry my comments (as unverified notes; they are not part of the CID)'),
      h('div', { class: 'btnrow' }, h('button', { type: 'button', class: 'tb primary', onclick: () => this.copy(this.lastShare.url) }, 'Copy link'), h('button', { type: 'button', class: 'tb', onclick: () => this.close() }, 'Close')));
    // copy at once: the click that opened this is the gesture
    this.copy(this.lastShare.url);
    box.querySelector('input').focus({ preventScroll: true });
  }

  open() {
    const app = this.app;
    const input = h('input', { type: 'text', id: 'open-in', placeholder: 'a BeatScript link (#CID.packed) or a bare CID', 'aria-label': 'Link or CID' });
    const go = async () => {
      const v = input.value.trim();
      if (!v) return;
      this.close();
      history.replaceState(null, '', location.pathname + location.search);
      await app.openAny(v);
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    this.pop('Open a link or a CID', h('p', { class: 'note' }, 'A link is checked against its own CID and refused if they differ. A bare CID is fetched from this server and checked the same way. Nothing plays until you press play.'),
      h('div', { class: 'linkrow' }, input, h('button', { type: 'button', class: 'tb primary', onclick: go }, 'Open')));
    input.focus();
  }
}
