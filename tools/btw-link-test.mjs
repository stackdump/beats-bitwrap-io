// node tools/btw-link-test.mjs: a link made by the language (djrust-vevr-se, `djctl btw share`) verifies in
// the page's own code, and a forged one does not.
import { openLink } from '../public/lib/btw/link.js';
const link = 'https://beats.bitwrap.io/p#z4EBG9jD5z7Kk3J1PeAG7PmE1hTNikEv1rNXWTdpYux1EDAEmMR.5VJRasMwDP3PKR7kZ_sYxDSMErZAd41RRhbbSYgdBzuMBkrPPs0ubrqUXqAY9J6kJwlbnoQeDVieJb2YIXXCRd1jV6DvCA84rc4ydoQbKivuaoKu7dpquspd48HjEd-Vc3j7lMxHz9Ck7OKcwL1bk9kjKGOqTiNjUentvkQ3uOndCuFEuOVHAS2U4TMN9CW5n7U5d5CBNJtLlOZFIU_zODRfVS-Vj9Wy_Nt2ZbUZ6F3r1lj-JPUz_rM6XbPmBuNLVia6cpOwBWSnCKFG5FmGlxJsmxExPxTc0i-yLhHEZ7BX79GqKQdlzPhljVIwA3ZBzoL8Fw';
const r = await openLink(link);
if (!r.verified || !r.link.text.startsWith('tempo 140')) { console.error('FAIL: a link the language made does not verify'); process.exit(1); }
const f = await openLink(link.replace('z4EBG9jD5z7K','z4EBG9jD5z7J'));
if (f.verified) { console.error('FAIL: a forged link verified'); process.exit(1); }
console.log('btw link: ok (a link made by djctl btw share verifies; a forged one does not)');
