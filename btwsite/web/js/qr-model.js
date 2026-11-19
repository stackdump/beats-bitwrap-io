// What the Share panel's QR code holds, as a pure function (unit-tested; no DOM, no network).
//
// The phone app claims <origin>/p and opens `<origin>/p#<CID>.<packed>` offline, verifying the CID itself, so that
// is the code's first choice: the same fragment as the self-sealing link, with /p before the #, and never the
// `~notes` (they are unverified and make the code bigger).
//
// QR_MAX_CHARS: a code at error-correction L grows with the text: ~1200 characters is about version 26 (117
// modules). Drawn at 3 px a module that is ~350 px, which a phone camera still reads off a laptop screen at arm's
// length; past it modules get too small to scan comfortably (the hard ceiling is 2953 bytes, and the server draws
// up to 2000). A longer program gets the CID-only short link instead, which needs a connection, or none.

export const QR_MAX_CHARS = 1200;

/** The app's link for a share report (`report.url` is `<origin>/#<CID>.<packed>[~notes]`), or '' if it has none. */
export function appLink(report, origin) {
  const url = report && report.url;
  if (typeof url !== 'string') return '';
  const i = url.indexOf('#');
  if (i < 0) return '';
  const frag = url.slice(i + 1).split('~')[0];
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(frag)) return '';
  return `${String(origin || '').replace(/\/+$/, '')}/p#${frag}`;
}

/**
 * Choose what the QR shows.
 *   report      a share report (cid, url), built without notes
 *   origin      the site's public origin
 *   signedIn    whether the user can store the CID-only short link
 *   shortStored whether that short link has been made (the panel's "Make short link")
 * Returns { kind, link?, chars?, message }:
 *   'self'          link = the app form; works with no network
 *   'short'         link = <origin>/p/<CID>; the program is on the server, so scanning needs a connection
 *   'short-pending' too long for a code; signed in but the short link is not made yet: the panel offers it
 *   'toolong'       too long and not signed in: no code, the copy links remain
 */
export function qrChoice({ report, origin, signedIn, shortStored, max = QR_MAX_CHARS }) {
  const link = appLink(report, origin);
  if (!link) return { kind: 'none', message: 'No link to scan for this program.' };
  if (link.length <= max) {
    return { kind: 'self', link, chars: link.length, message: "Scan with your phone's camera to open it in BeatScript." };
  }
  const cid = report && report.cid;
  if (signedIn && cid && /^[A-Za-z0-9]+$/.test(cid)) {
    const short = `${String(origin).replace(/\/+$/, '')}/p/${cid}`;
    if (shortStored) {
      return { kind: 'short', link: short, chars: short.length, message: "Scan with your phone's camera to open it in BeatScript. This is the short link: the phone needs a connection to fetch the program." };
    }
    return { kind: 'short-pending', message: `This program is too long for a QR code to scan comfortably (${link.length} characters, over ${max}). Make the short link below to get a code that holds only its CID; scanning it needs a connection.` };
  }
  return { kind: 'toolong', message: `This program is too long for a QR code to scan comfortably (${link.length} characters, over ${max}). Copy a link instead, or sign in to make a short link that fits.` };
}
