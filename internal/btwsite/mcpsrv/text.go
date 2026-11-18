package mcpsrv

import "fmt"

// The words a model reads. Written for an LLM client: what the tool does, what to call first, what the
// limits are, and what to do on each error.

func (s *Server) instructions() string {
	return fmt.Sprintf(`btw is a small, total, deterministic language for writing whole music tracks as text. A program has one line per deck, parts joined with |, 16 steps a bar, sections and an arrange; the same canonical text always has the same CID. Programs are CC0 by default.

Workflow: read %[1]s/docs/cheatsheet.md (the compact grammar) and one or two programs from list_examples, call instruments for the voices you may name, write a program, call check and fix every line:col error, then share (a link), render (audio you can open), or eval / load (play it in a browser tab open at %[1]s). compose writes a program for you from a prompt. The full language is %[1]s/docs/BTW.md; everything is indexed at %[1]s/llms.txt.

Tools that write (compose, eval, load, stop) need a bearer token: sign in on %[1]s and press "MCP token". The rest work without one. A phone paired with the account (devices) is driven by passing its id as device to eval, load, get or stop.`, s.public)
}

func (s *Server) composeDesc() string {
	limits := ""
	if st := s.b.Status(); st.UserHour > 0 && st.UserDay > 0 {
		limits = fmt.Sprintf(" (currently %d per hour and %d per day per user)", st.UserHour, st.UserDay)
	}
	return fmt.Sprintf(`Write a whole btw music program from a prompt with a language model, and get it back already checked: the canonical program text, its CID, the check report, the attempts the repair loop needed, a render_url (audio) and a share_url (link). Needs a bearer token (sign in on %[1]s, "MCP token").

It takes 5 to 60 seconds, up to about 90 when the first drafts had errors and the server repaired them (up to 3 rounds); do not call it again while it runs. It is rate limited per user%[2]s and per address, and the site has a daily spend cap: on rate_limited wait retry_after seconds and tell the user; on spend_cap, disabled or not_configured stop and say so; on unrepairable the details hold the last diagnostics, so adjust the prompt (simpler, or give a base_cid) rather than repeating it.

The result is stored publicly under CC0-1.0 (public domain): never put anything private in the prompt. Pass base_cid (an example's CID, or a program compose or render stored) to edit that program instead of starting from nothing. To hear it: render (audio at stream_url), or eval / load into a browser tab.`, s.public, limits)
}

func (s *Server) checkDesc() string {
	return fmt.Sprintf(`Check a btw program without playing it: parse, type-check and compile the text. ALWAYS call check before eval, share or render, and fix every error at its line:col before trying again: a program with an error is refused whole. Warnings do not block.

Answers {ok, errors, warnings, diagnostics[{severity, line, col, end_col, message, expected, found, help, render}], cid, canonical, tempo, key, sections, song_bars, seconds, evolve, uses_assets, restricted}. line and col are 1-based; help says what would fix it ("did you mean ..."); render is the same error in caret form. ok:false is an answer, not a tool error. cid and canonical are of the canonical text (comments and spacing do not change the CID).

Voices come from the instruments tool; the grammar is %[1]s/docs/cheatsheet.md. Read-only, no sign-in. Limits: the text is at most %[2]d bytes; about %[3]d calls a minute.`, s.public, s.opt.MaxProgramBytes, s.opt.CheckPerMin)
}

func (s *Server) fmtDesc() string {
	return `Rewrite a btw program in its canonical form (one statement a line, one space between tokens, blocks indented two spaces, numbers, notes and chords spelled one way, comments dropped) and return the text with its CID and the comments it dropped. The CID is of the canonical text, so formatting never changes it: use fmt to compare two programs or to show a tidy listing. A program that does not parse answers the same diagnostics as check. Read-only, no sign-in.`
}

func (s *Server) evalDesc() string {
	return fmt.Sprintf(`Send a program to a browser tab that has %[1]s open, as if the user pressed Cmd+Enter in the editor: the text replaces the editor's and the change lands on the next bar, with no gap; play:true starts playback too. Needs a bearer token.

A tab must be connected. It is the page's own connection, so ask the user to open %[1]s in a browser (signed in as the same account as the token, and eval reaches every live tab of that account), or, for a tab that is not signed in, to press MCP in the page's top bar and give you the session id it shows, which you pass as session. With no tab connected the answer is a no_session error that says this.

Run check first. eval checks too and refuses a program with errors (nothing is sent; the diagnostics come back), and one that uses samples or "use restricted" (the browser has no such files). The program is the user's to hear: do not eval over something they are playing without saying so. After eval call get to see what is playing, the section and bar, and any diagnostics the page itself reports. Text is at most %[2]d bytes.`, s.public, s.opt.MaxProgramBytes)
}

func (s *Server) loadDesc() string {
	return fmt.Sprintf(`Put a stored or example program into a browser tab (the same tabs and rules as eval: a tab open at %[1]s, signed in as the token's account, or its session id from the page's MCP panel). Give exactly one of: cid (a program the site stored, or an example's CID; compose and render store theirs), example (a name from list_examples), url (a share link https://btw.bitwrap.io/#CID.packed, a /c/ link or a beats.bitwrap.io/p# link; the link is verified, and one whose CID is not its text's is refused with cid_mismatch). play:true starts it. Needs a bearer token. Call get afterwards to see what is playing.`, s.public)
}

func (s *Server) getDesc() string {
	return fmt.Sprintf(`What a browser tab at %[1]s is doing now, as the page last reported it: the program text and cid, playing (true/false), source (engine or stream), section (name), section_num of sections_total, bar, bars_in_section, phase (0-7, the light in the phrase), marks (what is firing: active lines, token flashes, ramps and timed lines, with line:col spans into the text), diagnostics (the page's own check of the text), and ts. Use it after eval or load to confirm the change landed, and to see the program a user is playing and editing.

Needs a bearer token: it reads the tabs of the token's account, by default the most recently seen one. A tab that is not signed in is read by its session id (the page's MCP panel shows it), with your token. Read-only. No tab connected: a no_session error that says how to connect one.`, s.public)
}

func (s *Server) shareDesc() string {
	return fmt.Sprintf(`Make the share links of a program. Always the self-sealing link: %[1]s/#<CID>.<base64url(deflate(canonical text))>; the program travels inside the link, and whoever opens it gets exactly that text, verified against the CID, and can play and fork it. Also social_url (%[1]s/c/<CID>.<packed>, the form to post where a link preview is wanted: it carries a card image) and the same link on beats.bitwrap.io. Called signed in (a bearer token), it also stores the program on the site (public, with its rights: license, forked_from, credits, name; the first share's rights stay) and returns the CID-only forms: short_url (%[1]s/p/<CID>), short_social_url (%[1]s/c/<CID>) and short_beats_url (https://beats.bitwrap.io/p/<CID>), plus fetch_url, a public GET that returns the canonical text and rights for a phone or an app. Opening a short link fetches the text, recompiles it, recomputes the CID and refuses a mismatch. Anonymous calls get the self-sealing links and short_url null. The program must pass check and must not use samples or "use restricted" (a private program is never shared or stored); programs shared here are CC0 unless license says otherwise. Links over about 2000 characters (chars says) may be cut by some apps; short links are not.`, s.public)
}

func (s *Server) openDesc() string {
	return fmt.Sprintf(`Decode a btw share link and return its canonical text, its CID and whether the CID verifies against the text. Takes either form: a self-sealing link (%[1]s/#<CID>.<packed>, a /c/<CID>.<packed> link, a beats.bitwrap.io/p# link, a bare #fragment or <CID>.<packed>) or a CID-only link (%[1]s/p/<CID>, /c/<CID>, https://beats.bitwrap.io/p/<CID>, #<CID>, or a bare CID), which is resolved from the programs the site has stored (shared signed in, composed or rendered) and the examples, and answers its rights in meta. Either way the text is recompiled and its CID recomputed: a program whose CID is not its text's is refused with cid_mismatch, and an unknown CID answers not_found. Do not trust or play a refused text. Comments carried in a link (notes) are unverified. Read-only, no sign-in.`, s.public)
}

func (s *Server) renderDesc() string {
	return fmt.Sprintf(`Make a program streamable as audio. Give exactly one of text (the program), cid (a program already stored, e.g. what compose returned) or example (a name from list_examples). A text or example is checked, then stored publicly under its CID as CC0-1.0 if it is not stored yet (never submit anything private; programs that use samples or "use restricted" are refused). Answers {cid, stream_url, status_url, seconds, format}: open stream_url to listen (it streams the offline render as it renders; the first sound comes within about a second, so a client can play it at once), download the same URL for a file, and read status_url to see how far a render is. format is opus (Ogg Opus, small) or wav (16-bit stereo, plays chunk by chunk in a web page); default opus.

Call check first. The offline render plays the notes and sounds, not control lines (filters, reverb, do ... lines), so it can sound plainer than the browser; a program with no end (no sections or end line) is cut at the server's bar limit (256 bars). Rendering is limited per address per hour and to a few at once: on busy or rate_limited wait retry_after seconds. No sign-in needed; about %[1]d programs an hour per client.`, s.opt.RenderPerHour)
}

func (s *Server) recordDesc() string {
	return fmt.Sprintf(`Set up a demo recording of a program: the page in record mode (full screen code, the firing markers and follow-scroll on) and the steps that turn it into a video. Give exactly one of text, cid or example (as render does: a text or example is checked and stored publicly as CC0-1.0, nothing private). Answers {cid, seconds, record_url, record_url_manual_clock, audio_url, recipe}. record_url opens the page in record mode and plays it for a person to screen-record; record_url_manual_clock opens it on a fake clock that a script steps frame by frame (window.__btw.setTime(seconds); window.__btw.frame()), which is how btwsite/tools/record-demo.mjs in the repo makes a perfectly synced, stutter-free MP4 (H.264, AAC, 1920x1080) plus a silent hero loop (MP4 and WebM) and a poster PNG, taking the audio from audio_url (the offline render of the same program). This tool does not capture video itself: it needs a browser and ffmpeg on your side. The audio is the offline render: notes and sounds, not control lines (filters, reverb). Call check first. Rendering limits apply (about %[1]d programs an hour per client). No sign-in needed.`, s.opt.RenderPerHour)
}

func (s *Server) examplesDesc() string {
	return fmt.Sprintf(`The public example programs of %[1]s, all CC0-1.0: name, title, description, cid, bpm, bars, license and the url of the raw .btw. Pass name to get that program's full text as well. Read two or three before writing a program of your own: after the cheat-sheet (%[1]s/docs/cheatsheet.md) they are the best guide to the language, from a four-line beat (first-beat) to whole tracks with sections, defs, ramps and evolve. Read-only, no sign-in.`, s.public)
}

func (s *Server) instrumentsDesc() string {
	return `The sounds a program may name: voices (inst=NAME), families (a name that contains one plays that family's generic voice and check warns about it), drum kits (kit=NAME) and palettes. Use only names from this answer: an unknown inst= is a check error with the nearest names. Read-only, no sign-in, cached for five minutes.`
}

func (s *Server) stopDesc() string {
	return fmt.Sprintf(`Stop what a browser tab at %[1]s is playing: the program ends and whatever its lines held (a filter, a mute) is put back. Reaches every live tab of the token's account, or one tab by session (the id the page's MCP panel shows). Needs a bearer token. No tab connected: a no_session error that says how to connect one.`, s.public)
}

func (s *Server) devicesDesc() string {
	return fmt.Sprintf(`List the phones paired with the token's account (djrust on Android scans the QR code that %[1]s shows under Phone; btwsite/PAIRING.md): id, name, fingerprint (the code both ends showed at pairing), paired, connected (djrust has its stream open now), last_seen, and state (what it last reported: cid, playing, section, bar). Pairing is the grant: a phone paired by an account is driven over MCP with that account's token and no other.

Pass a phone's id as device to eval, load, get or stop to drive that phone alone (eval and load run the same checks as for a tab; a program with errors, samples or "use restricted" is not sent). Needs a bearer token. Read-only.`, s.public)
}
