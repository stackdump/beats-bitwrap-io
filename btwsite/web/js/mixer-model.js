/**
 * mixer-model.js: the mixer the page reports with its state (MCP `get`), from the engine's `Dj.mixer()` JSON (djrust
 * host::deck::audible: the crossfader, the master and per deck its level, mute, EQ kills, filters and vocoder).
 *
 * A wasm built before `Dj.mixer` existed has no such method: the worklet sends nothing and the page reports null, so the
 * site's `get` says null and warns of nothing. Pure: no DOM, no engine (test/unit.mjs).
 */

/** A worklet `mixer` message's JSON text to the object reported, or null when it is not a mixer. */
export function parseMixer(text) {
  if (typeof text !== 'string' || !text) return null;
  let v;
  try { v = JSON.parse(text); } catch { return null; }
  if (!v || typeof v !== 'object' || Array.isArray(v) || typeof v.decks !== 'object' || v.decks === null) return null;
  return v;
}

/** What reportState says: the latest mixer while the in-browser engine is what plays (a stream has none), else null. */
export function reportedMixer(sourceKind, latest) {
  return sourceKind === 'engine' && latest ? latest : null;
}

/** Seconds between two mixer reports from the audio thread. */
export const MIXER_SECONDS = 0.5;
