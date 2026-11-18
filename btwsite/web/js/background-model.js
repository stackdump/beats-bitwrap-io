// The page in the background: the decisions, with no DOM and no clock of their own (unit.mjs tests them).
//
// What goes wrong in a hidden tab: the browser stops requestAnimationFrame and slows timers to once a second (and, after
// five minutes, to once a minute). The sound itself is made on the audio thread (the AudioWorklet in engine-worklet.js), which
// does not care. What the page owns is the program runtime, BtwRun: sections, bar counts and the `on phrase:` automations only
// advance when the page calls service() with the clock's beat, and that call used to be made from the animation frame. So a
// hidden tab went on playing the net it had, and sections, loads and ramps waited for the tab to come back.
//
// The fix is to service the runtime from something that does not stop: the worklet's own report (a message from the audio
// thread, every ~25 ms of audio, not a timer), with a coarse interval as the fallback for sources that have no such message
// (the streamed render, whose clock is the AudioContext's). Painting stays on the animation frame and is simply not done while
// hidden.

/** How long since the last animation frame before something else has to service the runtime. A frame is ~16 ms. */
export const FRAME_STALE_MS = 200;
/** The most often the runtime is serviced from a worklet report (the report comes every ~25 ms). */
export const PUMP_EVERY_MS = 40;
/** Hidden at least this long before the page offers the stream (a notification shade or a focus blip is not a background). */
export const OFFER_AFTER_MS = 3000;

/**
 * Whether the runtime has to be serviced by other means: the page is hidden, or the frame loop has not run for a while (an
 * occluded window, a screen that is off, a long task).
 */
export function needsPump({ hidden, now, lastFrameAt }) {
  if (hidden) return true;
  return lastFrameAt != null && now - lastFrameAt > FRAME_STALE_MS;
}

/** Whether the pump should run now, given when it last did (it is called from every worklet report, which is more than enough). */
export function pumpDue({ now, lastPumpAt }) {
  return lastPumpAt == null || now - lastPumpAt >= PUMP_EVERY_MS;
}

export function isAndroid(ua) {
  return /\bAndroid\b/i.test(String(ua || ''));
}

/**
 * Whether to offer the streamed render when the page comes back from the background, and why (a short reason for the banner), or
 * null for no offer. The stream is the server's render played through the same AudioContext, scheduled 24 s ahead, so it needs no
 * timer to keep time. The engine is more fragile in a background tab (a browser may suspend or starve a tab's AudioContext), so:
 *   - always when the context did not come back running, or the engine's clock fell behind the wall clock while hidden (`degraded`)
 *   - on Android, whenever the engine played through a background of more than a few seconds (a phone's browser is the one
 *     that suspends it; the offer is cheap and dismissable, and said once per page load)
 */
export function offerStream({ hiddenMs, wasPlaying, source, canStream, android, ctxState, degraded, offered }) {
  if (!wasPlaying || source !== 'engine' || !canStream || offered) return null;
  if (hiddenMs < OFFER_AFTER_MS) return null;
  if (ctxState && ctxState !== 'running') return 'The browser paused the sound while the page was in the background.';
  if (degraded) return 'The sound fell behind while the page was in the background.';
  if (android) return 'Phones can pause or starve a page that is in the background.';
  return null;
}

/**
 * Whether the audio clock kept up with the wall clock over a hidden stretch: `audioS` of context time passed in `wallS` of wall
 * time. Slack of a quarter second plus 5% (an AudioContext's clock is the sound card's, not the CPU's).
 */
export function clockKeptUp({ audioS, wallS }) {
  return audioS >= wallS * 0.95 - 0.25;
}

/** What the lock screen shows. */
export function mediaInfo({ name, source, tempo }) {
  const title = (name && String(name).trim()) || 'btw';
  const how = source === 'stream' ? 'streamed render' : source === 'engine' ? 'live engine' : '';
  const album = [how, tempo ? `${Math.round(tempo)} bpm` : ''].filter(Boolean).join(' · ');
  return { title, artist: 'btw.bitwrap.io', album };
}

/** The Media Session's playback state: 'playing' while a program plays; 'paused' while one is loaded and checks (so the lock screen keeps a Play); else 'none'. */
export function mediaState({ playing, loaded }) {
  if (playing) return 'playing';
  return loaded ? 'paused' : 'none';
}
