// The djrust engine beats loads (`?engine=djrust`): a pinned npm version, served from a CDN.
// Audio djrust renders is a function of (share CID, this version); moving the pin is the only
// way rendered audio may change (BEATS-BACKPORT-PLAN.md, parity contract 2). A beats deploy
// only moves this pin; publishing djrust to npm is a separate step.
export const DJRUST_VERSION = '0.1.0';
export const DJRUST_CDN = `https://cdn.jsdelivr.net/npm/djrust@${DJRUST_VERSION}/`;
