/*
 * beatscript-track.umd.js: the same player for a page that loads classic scripts only.
 *
 *   <script src="https://cdn.jsdelivr.net/npm/<package>@<version>/beatscript-track.umd.js"></script>
 *
 * The engine is ES modules (an AudioWorklet module imports the glue), so this is a loader: it imports
 * beatscript-track.js from beside itself, which defines <beatscript-track>. In a browser it does that at once and puts
 * `BeatScriptTrack.ready` (a promise of the module) on the global; under CommonJS or AMD it exports `load(base)`, which
 * does the same from `base` (the package's URL). No inline style, no eval: a CSP that allows the script's origin and
 * 'wasm-unsafe-eval' is enough.
 */
(function (root, factory) {
  var api = factory();
  if (typeof define === 'function' && define.amd) define([], function () { return api; });
  else if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BeatScriptTrack = api;
  if (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) api.ready = api.load(document.currentScript.src);
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  return {
    /** Import the element from `base` (this file's URL or the package's directory). */
    load: function (base) {
      return import(new URL('./beatscript-track.js', base).href);
    },
  };
});
