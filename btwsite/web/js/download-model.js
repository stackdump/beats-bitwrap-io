// download-model.js: whether a program can be downloaded as an audio file, and what to tell the user (pure; unit-tested).
//
// The file is the server's offline render (GET /api/render/<cid>?format=opus|wav&download=1), which refuses a program
// longer than render.max_bars (/api/info; 256 on btw.bitwrap.io). The page says so before asking, with the length
// in bars and minutes, rather than letting the request fail.

export const DEFAULT_MAX_BARS = 256;

/** "m:ss" for a number of seconds. */
export function clock(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * plan({bars, maxBars, tempo, seconds}) -> {ok, bars, maxBars, seconds, length, message}
 *   bars     the song's length in bars (CheckReport.song_bars, or the render status's bars); null/0: no end
 *   maxBars  the server's render.max_bars
 *   tempo    bpm, for the length in time when `seconds` is not known
 */
export function plan({ bars, maxBars, tempo, seconds } = {}) {
  const max = Number(maxBars) > 0 ? Math.floor(Number(maxBars)) : DEFAULT_MAX_BARS;
  const n = Number(bars) > 0 ? Math.floor(Number(bars)) : 0;
  const bpm = Number(tempo) > 0 ? Number(tempo) : 0;
  const secs = Number(seconds) > 0 ? Number(seconds) : n && bpm ? (n * 4 * 60) / bpm : 0;
  const maxSecs = bpm ? (max * 4 * 60) / bpm : 0;
  const length = n ? `${n} bar${n === 1 ? '' : 's'}${secs ? ` · ${clock(secs)}` : ''}` : '';
  if (n > max) {
    return {
      ok: false, bars: n, maxBars: max, seconds: secs, length,
      message: `This song is ${n} bars${secs ? ` (${clock(secs)})` : ''}; a download is at most ${max} bars${maxSecs ? ` (${clock(maxSecs)} at ${bpm} bpm)` : ''}. Shorten the arrange, or add \`end at bar ${max}\` to download the first ${max} bars.`,
    };
  }
  return {
    ok: true, bars: n, maxBars: max, seconds: secs, length,
    message: n ? `${length}, rendered on the server from the program's text.` : `This program has no end, so the file is the render's default length. Add \`end at bar N\` (at most ${max}) to choose it.`,
  };
}
