// Who authored a program and what rights it has: one text, served by btwserve at /authorship (djrust-vevr-se
// docs/AUTHORSHIP.md). The share dialog shows one line and links it; the Android app's share page says the same
// (beatscript-app SiteLinks.RIGHTS_LINE). Neither repeats the text.

export const AUTHORSHIP_PATH = '/authorship';

/** The share dialog's line: the text's first sentence, then the link to the rest. */
export const SHARE_RIGHTS = Object.freeze({
  text: 'Programs here are CC0: anyone can use them for anything.',
  link: 'Who authored it, and what rights it has',
  href: AUTHORSHIP_PATH,
});
