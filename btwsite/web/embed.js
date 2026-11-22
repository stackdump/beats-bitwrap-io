/*
 * embed.js: <beatscript-player>, a BeatScript program on any page.
 *
 *   <script src="https://beatscript.app/embed.js" defer></script>
 *   <beatscript-player cid="z4EBG9j..."></beatscript-player>
 *   <beatscript-player link="https://beatscript.app/p/z4EBG9j..." compact theme="light"></beatscript-player>
 *
 * Attributes: cid (a program's CID) or link (a /p/, /c/ or editor link to one); compact (a one-line player, 80 px
 * high); theme (dark, the default, or light). There is no autoplay: the player starts on a click, inside its frame.
 *
 * The element renders a sandboxed iframe of /embed/<CID> (in its own shadow root), so the host page's CSS and script
 * never touch the engine and the player's never touch the page. It is a classic script with no inline style (styles are
 * set through the CSSOM), so it loads under a strict CSP that allows the script itself. Only programs the site stores
 * as Creative Commons play; anything else shows the site's 404 in the frame.
 */
(function () {
  'use strict';

  var CID = /^z[1-9A-HJ-NP-Za-km-z]{20,120}$/;
  var SIZE = { full: [480, 152], compact: [480, 80] };
  var me = typeof document !== 'undefined' && document.currentScript && document.currentScript.src;
  var ORIGIN = me ? new URL(me).origin : 'https://beatscript.app';

  /** The CID (and the packed text, when the link carries it) a `cid` or `link` attribute names, or null. */
  function target(cid, link) {
    if (cid) return CID.test(cid) ? { cid: cid, packed: '' } : null;
    if (!link) return null;
    var u;
    try { u = new URL(link, ORIGIN); } catch (e) { return null; }
    var name = '';
    var m = /^\/(?:p|c|embed)\/([^/]+?)(?:\.jsonld|\.btw)?\/?$/.exec(u.pathname);
    if (m) name = decodeURIComponent(m[1]);
    else if (u.pathname === '/' && u.searchParams.get('cid')) name = u.searchParams.get('cid');
    else if (u.hash.length > 1) name = decodeURIComponent(u.hash.slice(1)).split('~')[0];
    var dot = name.indexOf('.');
    var c = dot < 0 ? name : name.slice(0, dot);
    var packed = dot < 0 ? '' : name.slice(dot + 1).split('.')[0];
    if (!CID.test(c)) return null;
    return { cid: c, packed: /^[A-Za-z0-9_-]+$/.test(packed) ? packed : '' };
  }

  /** The frame's URL for these attributes, or null when they name no program. */
  function embedSrc(attrs, origin) {
    var t = target(attrs.cid, attrs.link);
    if (!t) return null;
    var q = [];
    if (attrs.compact) q.push('compact=1');
    if (attrs.theme === 'light') q.push('theme=light');
    return (origin || ORIGIN) + '/embed/' + t.cid + (t.packed ? '.' + t.packed : '') + (q.length ? '?' + q.join('&') : '');
  }

  var Base = typeof HTMLElement !== 'undefined' ? HTMLElement : function () {};

  class BeatscriptPlayer extends Base {
    static get observedAttributes() { return ['cid', 'link', 'compact', 'theme']; }

    connectedCallback() { this.render(); }

    attributeChangedCallback() { if (this.isConnected) this.render(); }

    get attrs() {
      return { cid: this.getAttribute('cid'), link: this.getAttribute('link'), compact: this.hasAttribute('compact') && this.getAttribute('compact') !== 'false', theme: this.getAttribute('theme') };
    }

    render() {
      var a = this.attrs;
      var src = embedSrc(a, ORIGIN);
      var root = this.shadowRoot || this.attachShadow({ mode: 'open' });
      this.style.display = 'block';
      this.style.maxWidth = (a.compact ? SIZE.compact : SIZE.full)[0] + 'px';
      if (!src) {
        var p = document.createElement('p');
        p.textContent = 'beatscript-player: give it a cid or a link to a BeatScript program';
        root.replaceChildren(p);
        return;
      }
      var old = root.querySelector && root.querySelector('iframe');
      if (old && old.getAttribute('src') === src) return;
      var f = document.createElement('iframe');
      var size = a.compact ? SIZE.compact : SIZE.full;
      f.setAttribute('src', src);
      f.setAttribute('title', 'BeatScript player');
      f.setAttribute('width', '100%');
      f.setAttribute('height', String(size[1]));
      f.setAttribute('loading', 'lazy');
      f.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
      // scripts and its own origin (it fetches the engine from it); links open a new tab; nothing else
      f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox');
      f.style.border = '0';
      f.style.display = 'block';
      f.style.width = '100%';
      f.style.height = size[1] + 'px';
      root.replaceChildren(f);
    }
  }

  var api = { embedSrc: embedSrc, target: target, Element: BeatscriptPlayer, origin: ORIGIN };
  if (typeof globalThis !== 'undefined') globalThis.BeatscriptPlayer = api;
  if (typeof customElements !== 'undefined' && !customElements.get('beatscript-player')) customElements.define('beatscript-player', BeatscriptPlayer);
})();
