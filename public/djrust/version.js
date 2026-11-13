// The audio engine beats loads (djrust): a pinned npm version, served from a CDN.
// Audio djrust renders is a function of (share CID, this version); moving the pin is the only
// way rendered audio may change (BEATS-BACKPORT-PLAN.md, parity contract 2). A beats deploy
// only moves this pin; publishing djrust to npm is a separate step.
export const DJRUST_VERSION = '0.2.0';
export const DJRUST_CDN = `https://cdn.jsdelivr.net/npm/djrust@${DJRUST_VERSION}/`;

// Audio URLs carry the engine version: /audio/{cid}.webm is served immutable, so a render by a
// newer engine must land at a URL no browser or podcast client has cached (the server adds the
// same query from this file: internal/audioengine).
export const AUDIO_QUERY = `?v=djrust-${DJRUST_VERSION}`;
