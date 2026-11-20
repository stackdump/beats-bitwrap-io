# Engine vs stream: what differs, and why

beatscript.app plays a program two ways (`pickSource`, `web/js/app.js`): the **stream** is `GET /api/render/<cid>`, which
pipes `btwd render` (djrust-vevr-se `crates/btwd/src/render.rs`); the **engine** is `web/js/engine.js` +
`web/js/engine-calls.js` driving djrust's wasm facade in an AudioWorklet. On auto, a program that is **loaded** (opened,
composed) plays on the stream, and an **edit** (Cmd+Enter) plays on the engine. So the first listen of a composed track
is the stream, and the next one, after any edit, is the engine. That switch is where the difference is heard.

The harness is `btwsite/test/parity/` (`make parity`; its README says how it works). This report is from its runs on
2026-11-19: djrust-vevr-se `b22bb96` (main) built on valoper for the repros, then the full corpus on workbit with
djrust-vevr-se `val/parity-c8ae6943` (main plus the loop fix) and with the deployed wasm (`4444a54`).

**The reference is btwd's render** (Matt: the stream sounds right). Every difference below is the engine straying from the
render, ranked by how far (the mean score, under Corpus). In practice almost every difference is a control line the
engine plays and the render does not: a filter, reverb, level or EQ line, `kit=` / `sound=`, or a tempo curve. Moving
the engine toward the render for those means **dropping** them from the engine. The other way to close the gap is to
render them in btwd ("Not fixed", 1-3), which changes the reference. Which way to go is Matt's call, so neither is done
here. Two differences were the render's own bug or a shared one, not the engine's: `end after SECTION` (fixed in btwd)
and a silent outro in `assert.btw` (both sides).

## The short answer

1. **With no control lines, engine and stream are sample-identical.** The notes, voices, sections, evolve and swing
   are the same code on both sides, and `00-base` matches to the sample. Everything below comes from what each side
   does with the *rest* of a program.
2. **The stream renders no control line at all.** btwd says so in its own `start` event ("control lines ... are not
   rendered"). Every filter, reverb, level, EQ, crossfader, mix block, duck, trick and ramp is missing from the stream.
   It also skips **`kit=` and `sound=`**: a program that sets a kit renders byte-identical to the same program without it.
3. **The engine renders some control lines and skips the rest.** It honours filters, reverb, crush, levels, EQ,
   crossfader, mute, mix blocks, `kit=` and `sound=`. It skips tricks, freeze, vocoder, delay, resonance, crush on a
   deck, duck, moves and tempo ramps, which the stream skips too.
4. So a composed program that uses a filter or a reverb sounds different on the two sources, because the engine plays
   that line and the stream does not. In the 33 programs in the site's store, `master: filter` appears in 31, reverb
   in 26 and `kit=` in 13.
5. Two engine bugs made it worse, and both are fixed on this branch. The engine's master filter and crush were stuck
   at their end stops, and deck B could start a render quantum or more behind deck A.

## Ranked differences (by audibility), each with a minimal repro

Each repro is `btwsite/test/parity/repros/NN-*.btw`: one 8-bar groove (kick, hats, clap on A; sub bass and pad on B, 128
BPM, `end at bar 8`) plus the one line shown. The numbers are per program: bars flagged (of 8), engine minus stream
integrated loudness, mean log-mel distance, and engine true peak (the stream's is +0.0 dBTP throughout). They are after
the fixes. "Before" is the engine as deployed.

| # | repro (line added to the groove) | flagged | dLUFS | mel dB | who plays it | heard as |
|---|---|---|---|---|---|---|
| 1 | `master: filter lp 300 -> 8k over 8 bars` (01) | 7/8 | -0.2 | 13.6 | engine only | the sweep is absent from the stream. **Before the fix the engine did not sweep either** (lp stuck open) |
| 2 | `master: filter hp 1k` (02) | 8/8 | -7.5 | 9.6 | engine only | thin, bass-less on the engine; full on the stream. Before: the HP sat at its end stop (5 kHz) on deck A only |
| 3 | `master: level 0.4` (13) | 8/8 | -8.0 | 7.6 | engine only | 8 dB quieter on the engine |
| 4 | `master: reverb 0.6` (05) | 8/8 | -7.3 | 7.1 | engine only (as each strip's reverb wet) | washed out and 7 dB quieter on the engine (strip wet replaces dry) |
| 5 | `mix { A level 0.5, B eq low -6 }` (26) | 8/8 | -5.1 | 3.7 | engine only | quieter, less bass on the engine |
| 6 | `crossfader 0` (12) | 8/8 | -0.6 | 5.3 | engine only | deck B gone on the engine |
| 7 | `sound=synth:wobble-lead` on the bass (28) | 7/8 | -2.2 | 2.9 | engine only | a wobble lead on the engine, the sub bass on the stream |
| 8 | `master: reverb 0 -> 0.8 over 8 bars` (24) | 5/8 | -3.7 | 4.9 | engine only | the build-up's wash is absent from the stream |
| 9 | `deck B: reverb 0.6` (09) | 7/8 | -2.7 | 1.1 | engine only | |
| 10 | `at bar 2 for 4 bars: deck B: mute` (14) | 4/8 | -1.5 | 1.7 | engine only | the bass and pad drop out on the engine only |
| 11 | `deck A: low 0` / `deck B: high 0` (11) | 5/8 | -1.7 | 0.6 | engine only | |
| 12 | `kit=drums-808` on the kick (27) | 6/8 | 0.0 | 1.7 | engine only | an 808 kick on the engine, the default kit on the stream |
| 13 | `master: crush 0.6` (07) | 0/8 | 0.0 | 5.1 | engine only | grit on the engine. Before: crushed at the maximum whatever the value |
| 14 | `deck B: level 1 -> 0 over 8 bars` (10) | 2/8 | -1.3 | 1.0 | engine only | |
| 15 | `deck B: filter lp 400` (03) | 0/8 | 0.0 | 0.8 | engine only | the pad darkens on the engine |
| — | `master: resonance 0.9` (04) | — | | | neither | dropped on both (the engine logs `inserts filter.res`). 04 also sets `master: filter lp 800`, which only the engine plays |
| — | delay (06, 25), crush on a deck (08), tricks (15-18), freeze (19), vocoder (20), duck (21), move (22), tempo ramp (23) | 0/8 | 0.0 | 0 | neither | identical, because both drop them. The desktop plays them, so they sound wrong on both |

A program in the store hits several of these at once: a filter ramp per section, a reverb in the breakdown and a kit.

### Before the fixes (engine as deployed)

- **Master filter (1, 2) and master crush (13).** `masterFx` takes a *position*, 0..1 of the slider
  (`MasterFxKey::slider_value`), but engine-calls.js sent the slider's own 0..100. Anything above 1 hit the end stop:
  low-pass always open (so `master: filter lp ...` did nothing at all), high-pass and crush always fully on. The unit is
  also per deck, so a Master target reached deck A only. **Fixed** (`13b2aa6`).
- **Deck B a quantum late.** The two `play`s of a program's first pass were posted one after the other and could land in
  different render quanta. Deck B then ran behind deck A for the whole song (21 ms in the offline render; at least one
  128-frame quantum live). The parity run caught it as nondeterminism: the same program was sample-identical to the
  stream on one run and flagged on 3 of 8 bars on the next. **Fixed** (`4c0f03e`): one pass's plays and knobs reach
  the worklet as one message.

## Corpus

**112 programs, 108 compared.** Run on workbit (M4 Pro) on 2026-11-19: btwd and the wasm built from djrust-vevr-se
`val/parity-c8ae6943` (`89fdc3f`, main plus the loop fix), with this branch's page JS. The corpus is the 29 repros, the 8 site
examples, 42 `.btw` files from djrust-vevr-se (`crates/btwapi/tests/{corpus,extra}`, `crates/djlive/tests/fixtures`,
`docs/btw`, `examples`, `examples/btw`), and the 33 programs in a read-only copy of the beatscript.app store. Four are not
compared: two do not check (`extra/assets-forgot-restricted`, `examples/btw/ports-import`, which needs an import store) and
btwd refuses two (`assets-open`: samples; `assets-restricted`: private). Some programs appear in more than one set (the
site examples are also in djrust's corpus and in the store), so the 108 rows hold about 85 distinct programs.

| set | programs | compared | no flagged bar | flagged bars | median mean score |
|---|---|---|---|---|---|
| repros | 29 | 29 | 15 | 91 / 232 | 0.73 |
| site examples | 8 | 8 | 1 | 321 / 356 | 3.10 |
| djrust-vevr-se `.btw` | 42 | 38 | 10 | 1345 / 1697 | 2.05 |
| store | 33 | 33 | 0 | 2291 / 2416 | 2.73 |

The **mean score** measures how far the engine strays from the render (btwd, the reference). For each bar it takes the
largest measure over its threshold (loudness / 3 LU, mel / 6 dB, onsets / 15 ms, onset correlation), and it averages
that over the song: 0 means the engine matches the render, 1 means at the threshold, and 10 is a bar where only one
side sounds. Every store program strays (median score 2.73, median integrated loudness 2.1 LU quieter on the engine).

**By cause** (from the calls each program sends and the engine's `ignored` list):

| cause | programs | median / max score | what the engine does that the render does not |
|---|---|---|---|
| a tempo curve (`tempo 100 -> 128 over 8 bars`, a section's `tempo`) | 3 | 4.16 / 5.15 | **follows it**, and btwd does not. btwd renders `tempo.btw` at its first tempo all the way through: 40 bars in 96 s is 100 BPM. The engine's nets carry each section's tempo, so it speeds up through the curve, drifts off the render bar by bar and ends 18 s early (78 s). The engine's per-pass `deck tempo` call is still ignored. Wiring it to `Dj.set_tempo` was tried and reverted: the engine then followed the curve more closely and strayed further (`tempo.btw` 5.15 to 5.34; repro 23, a timed `at bar 2: tempo` that btwd drops, 0 to 1.93) |
| `master: filter` (lp / hp, ramps) | 60 | 2.73 / 4.15 | plays the filter (15-30 dB mel in the filtered bars). A sweep that ends on `hp 4k` before a drop leaves the drop thin on the engine |
| other mix and FX lines (reverb, level, EQ, crossfader, mute, mix blocks) | 13 | 1.53 / 2.65 | plays them, mostly 3-8 LU quieter (a strip's reverb wet replaces its dry) |
| no control line but `kit=` / `sound=`, evolve, a one-quantum lag | 9 | 0.92 / 2.00 | see below |
| nothing differs | 23 | 0 / 0.84 | - |

**Most strayed, each a repro** (score, flagged bars, engine minus render integrated loudness, mean mel, then slow blocks / worst ms):

| program | score | flagged | dLUFS | mel dB | slow (n / max ms) | why |
|---|---|---|---|---|---|---|
| djrust `examples/btw/tempo.btw` | 5.15 | 40/40 | -2.6 | 19.7 | 2 / 7 | the engine follows the tempo curves and btwd holds 100 BPM, so the engine ends 18 s early (silent for the render's last bars); also the master filter |
| djrust `examples/btw/showcase.btw` | 4.16 | 64/64 | -6.2 | 19.4 | 10 / 10 | a tempo curve (as `tempo.btw`), the master filter, and trick, delay and vocal ignored |
| djrust `btwapi/tests/extra/sections-end.btw` | 4.15 | 12/20 | +0.7 | 12.9 | 2 / 7 | **render bug**: btwd ignored `end after bridge` and rendered 20 bars where the program (and the engine) stop at 12. Fixed in btwd (djrust-vevr-se `677e8c7`) |
| store `z4EBG9jEr93n...` | 3.23 | 128/128 | -3.9 | 15.3 | 406 / 17 | master filter per section |
| `hand-dubstep-140-v4` (site) | 3.10 | 68/68 | -3.1 | 17.4 | 8 / 7 | master filter, wheel, moves, filter.res |
| `markers-demo` (site) | 3.19 | 24/24 | -5.0 | 17.0 | 2 / 8 | master filter and reverb |
| `acid-line` (site) | 3.18 | 16/16 | -0.9 | 19.1 | 1 / 7 | master filter (filter.res ignored on both) |
| `matrix-130` (site) | 2.73 | 78/80 | -2.5 | 11.7 | 9 / 8 | master filter, wheel |
| `trance-138` (site) | 2.55 | 64/64 | +0.1 | 4.6 | 7 / 12 | filter ramps; moves ignored |
| djrust `examples/btw/linked.btw` | 1.57 | 24/24 | -0.1 | 2.6 | 1 / 7 | no control line: "hits differ" at a constant 2.7 ms, one 128-frame quantum. A deck or net lands one quantum off |
| `evolve-demo` (site) | 0.53 | 8/32 | 0.0 | 0.3 | 2 / 8 | no control line: generations 3 and 5 (bars 13-16, 21-24) have their hits in other places (onset correlation < 0.13, same spectrum). Probably the `thin ... seed=3` draw: to investigate |
| djrust `examples/btw/assert.btw` | 0.74 | 2/32 | -0.1 | 1.3 | 1 / 7 | the render cuts to silence at the outro, and the engine plays two bars of tail. **Both** are then silent for outro bars 3-8, where deck B has a harmony: a bug on both sides |
| `first-beat` (site) | 0 | 0/8 | 0.0 | 0 | 1 / 7 | identical |

**Deployed build.** The same corpus with the module beatscript.app serves now (`PARITY_WASM_DIR`, wasm `4444a54`; this branch's page JS and
the same btwd, so only the wasm differs): **89 compared, 87 score the same** as the local build. The two that differ are
`sections-end` (btwd's `end` fix landed between the runs: 4.15 to 0.76) and one store program (3.23 to 3.15). **19
programs do not check on the deployed module at all**: it predates `duck`, `mix { }`, a timed `tempo`, `assert`, `sing`,
`?` chance steps, `ports`, `scale`, and the arithmetic and shape syntax. Among them are repros 21, 23 and 26 and twelve of
djrust's examples (`tempo`, `showcase`, `mix`, `perform`, `timing`, ...). On the live site those programs cannot play on
the engine at all. `deep-house-60` timed out (30 min) on the deployed module and finished on the local build. The
deployed module also had about 20x fewer slow blocks offline (261 against 5316 on the same programs). The local module
for the corpus run was built without wasm-opt (none was installed here), so its offline slow-block counts are inflated.
The real-time runs below use a wasm-opt'd build.

### stats.slow (`?perf=1`)

Every run records the worklet's slow blocks: 3 ms or more by its `Date.now()`, with how the time split between install,
bar plays, render, tick and grid (`engine.stats.slow`). They are collected as each report comes in, because `stats.slow`
keeps only the last 200. run.mjs places each block in a bar of the render and checks it against the flagged bars and
section starts (`perf` in `report.json` and in each program's json; there is a column in RESULTS.md).

- **Offline** (all 108): 5413 slow blocks, worst 35 ms. 64% were plain render blocks (`-`, no install or landing
  that quantum). 27% were tick and grid work (`T`, `TG`, `G`). 9% were a net landing and installing (`LI`, `LIT`,
  `LITG`, `LIG`): 472 blocks, 3.7 s in all. Bars with a slow block were flagged 96% of the time, against 79% for bars
  without one. Section starts with a slow block in or just before them landed "late" (onsets off or unlike the render)
  79% of the time, against 72% without one. Offline, though, a slow block cannot drop out (the render waits for it), and
  both rates are dominated by the control-line differences above: the long store programs have the most slow blocks
  *and* the most filter lines. **No difference in the corpus is explained by a slow install.** Where the engine strays,
  the cause is a line it plays or drops (the tables above), and it strays just as much in bars with no slow block.
- **Real time**: `test/audio-perf.mjs` now places every slow block and underrun in its section and bar (and lists the parity run's
flagged bars beside them with `--parity`). Eight programs ran 60 s each in real time on the engine (wasm-opt'd local build,
Chrome's null sink): the four store programs with the most or the worst slow blocks, `deep-house-60`,
`hand-dubstep-140-v4`, `trance-138` and `markers-demo`. Over 8 minutes and 14 section changes there were **0
underruns**, 2-7 process() overruns a minute, and 48 slow blocks. 22 of those were start-up (the first net's install,
worst 11-16 ms). Of the 26 after start-up, **17 fell in the bar before a section change, every one a net landing and
installing (`LI` / `LIT`)**, 1.2-1.6 s before the section starts. That is the runtime installing the next section's nets
in its bar of notice, and its install steps sometimes take a whole block. The worst was 32 ms, eleven times the 2.9 ms
quantum budget, in the bar before store `z4EBG9jBD41n...`'s `drop2`. Here the page's buffer (base latency 0.1 s)
absorbs it, and nothing landed late: offline, the section starts that strayed did so for the control-line reasons
above. On a slower device, or with app.js's old 10 ms / 23 ms buffer (the drop-outs at every section change its comment
recalls), a 10-30 ms block in the bar before a section is where a glitch would come from. **The next thing to make
smaller is the install step's budget** (`installBudget`, KB a quantum), not the render.

## What the engine drops or approximates (inventory)

From `engine-calls.js` and from the `ignored` events and console lines captured during the runs. The stream drops
**all** of these and everything in the "honoured" list too.

**Ignored by the engine** (the page logs `btw engine: ignoring <what>` once per kind, and now lists it as "not played here"):

| what the engine logs | btw that triggers it |
|---|---|
| `inserts filter.res` | `master: resonance 0.7`, `deck A: resonance 0.2 -> 0.8 over 4 bars` |
| `inserts delay`, `inserts delay on A` | `master: delay 0.4`, `deck A: delay 0 -> 0.7 over 8 bars` |
| `inserts crush on A` / `on B` | `deck B: crush 0.6` (crush is honoured only on the master) |
| `inserts <param>` | `do inserts set target=Master param=filter.mix value=0.5` (anything but `filter.sweep`, `reverb.mix`, `crush.mix`) |
| `inserts on Wheel` | `do inserts ... target=Wheel` |
| `trick` | `trick on deck=A kind=stutter` / `tape_stop` / `spin_back` / `filter` / ..., and `duck B under A.kick 6db` (a `pump` trick) |
| `freeze` | `freeze phrase bars=1`, `do freeze ...` |
| `vocoder` | `do vocoder set mix=0 -> 0.8 over 8 bars`, `vocoder ...` |
| `moves` | `move filter_exit on B over 4 bars` (also `echo_out`, `loop_roll`, `bass_swap`, `phrase_sync`, `vocoder_handoff`) |
| `deck tempo` | `at bar 2: tempo 128 -> 150 over 4 bars`, any tempo curve (the runtime sets the deck tempo each pass) |
| `deck load`, `deck sync` | `deck B: load techno:42`, `deck A: sync` |
| `loopsets` | `load pair dnb:2602 group 2` |
| `autodj` | `swap pairs with echo_out` |
| `queue` | `queue play`, `queue jump 3` |
| `vocal` | `deck B: sing "words" on melody`, `vocal create "..."` |
| `mixer pfl` / `aux` / `headphone_*` | `do mixer deck=A pfl=true` and the like |
| the noun itself | any other `do NOUN`: `td3`, `wheel`, `effects`, `aux`, `automix`, `record`, `mashup`, `clips`, `loops`, `voice`, `kits` (`pd705`), `key detect` |

**Honoured but approximated:**

| btw | in the engine | how it differs from the desktop |
|---|---|---|
| `master: filter lp/hp F` (+ ramps) | both decks' master FX units, `lp-freq` / `hp-freq` | the cutoff is mapped across; the filter is the master chain's (Tone-style LP), not the insert's sweep filter |
| `deck A: filter ...` | the strip's filter knob (2nd-order Butterworth) | cutoff clamped to the knob's range (LP 200 Hz..20 kHz, HP 20 Hz..5 kHz) |
| `master: reverb X` | each strip's reverb wet | there is no master reverb; strip wet trades dry for wet, so the engine gets quieter as the reverb rises (repro 4: -7 LU) |
| `master: crush X` | both decks' crush bits at position X | bits, not a dry/wet mix |
| `kit=` / `sound=` | `setKit` / `setRoleVoice` once the net lands | as the desktop runtime |

## `loop`

`node btwsite/test/parity/loop.mjs` plays each case on the engine for three passes. It compares the result with btwd's
render of the same arrangement written out three times without `loop`, which is what a loop means. Each bar is
identified against reference bars (p1 = one kick, p2 = two, p3 = three, `four` = four on the floor).

| case | written out (stream) | engine | |
|---|---|---|---|
| single-section arrange, 2-bar section, a 3-bar alternation `<p1 p2 p3>` | p1 p2 p1 p2 p1 p2 | p1 p2 p1 p2 p1 p2 | same since the fix (before: p1 p2 **p3** p1 p2 **p3**) |
| single-section, 3-bar section (the alternation fits) | p1 p2 p3 ×3 | p1 p2 p3 ×3 | same |
| single-section, evaluated while another program plays | p1 p2 p1 p2 ... | p1 p2 p1 p2 ... | same since the fix |
| single-section, evaluated again in its second bar | p1 p2 p1 p2 ... | p1 p2 p1 p2 ... | same since the fix |
| two sections `arrange one two` + loop | p1 p2 four four, ×3 | the same | same: 2+ sections loop correctly |
| no sections, `end at bar 4` (reference) | p1 p2 p3 p1 | the same | same |

- **Engine, single section: fixed** (djrust-vevr-se `89fdc3f`, same branch name). When the lap turned, the runtime did
  not reload the section's net: `sync_nets` saw the same load key on the deck, so the net ran on with its own phase,
  which sounds right only when every pattern's cycle divides the section length. Now a section's first bar loads its
  nets again, once per bar line, unless the stretch is a `chain` (the later stretch of a `stack(...)` or of a section
  too long for one net: the same section going on). The same fix covers a section named twice in `arrange`. Test:
  djlive `a_section_that_starts_again_reloads_its_nets_on_its_bar_line`; `cargo test -p djlive` 1043 passed. Re-run
  with the rebuilt wasm, every case above matches its written-out render bar for bar, at 0.0 LU and under 1 dB mel. The
  bars loop.mjs still flags are "hits differ" only (onset correlation 0.33-0.45 on one- and two-kick bars, a constant
  2.7 ms = one 128-frame quantum in the first pass): the detector on near-empty bars, not a sound difference.
- **Header "section · groove bar 3/2".** Not reproduced. The runtime's `status()` wrapped correctly (`song_bar` 1, 2,
  1, 2 ...) in every case above, on both the main build and the deployed `4444a54` build, on a synthetic clock
  (`loop-status.mjs`) and in the real engine. That covered 2-, 3-, 8-, 16- and 32-bar sections, evolve, a chain of
  nets, evaluating over another program, and re-evaluating. The header prints "section · NAME" without "n/m" only when
  `song_bar` falls outside every section, so something sent a `song_bar` past `song_bars`. Next step: run the actual
  program with `node btwsite/test/parity/loop-status.mjs that.btw`. It exits 1 and prints the beat where the header
  would read past the section.
- **Stream.** The stream is a finite render of one pass (btwd's note: "the song loops: the render is one pass through
  its sections"). On auto a loaded program goes to the stream, so a looping program played one pass, ended, and after
  1.5 s the page showed "The render ended." and stopped. **Fixed** on this branch (`6257fab`): `pickSource` sends a
  looping program to the engine when the engine is ready. When the stream still plays one (the engine not loaded yet,
  or stream chosen by hand), the end toast says it was one pass of a loop. Not done, and an option: let the stream
  player go back to the start when its source loops. The render is cached and seamless at the bar line, and the
  runtime's clock would need the same wrap (`StreamPlayer.mediaTime` modulo the pass).

## Fixes made (branch `val/parity-c8ae6943`, beats-bitwrap-io)

- `13b2aa6` engine-calls.js: the master filter and crush reach the sound (a position, both decks), with tests in
  `wasm-parity.mjs`.
- `4c0f03e` engine.js / engine-worklet.js: one pass's plays and knobs go as one `batch` message, so the decks start in
  the same quantum. Also adds the `engine.preparing` and `engine.resetNotes()` hooks.
- `6257fab` page: what the engine ignores is listed with the problems as "not played here", so the strip no longer
  says "No problems" over it (smoke step 3 checks it). `pickSource` moved to `source-model.js` (unit-tested), and a
  looping program goes to the engine.
- `e30d55d` the harness, `make parity`.
- djrust-vevr-se `89fdc3f` (branch `val/parity-c8ae6943`): the single-section `loop` restart (above).
- djrust-vevr-se `677e8c7`: btwd honours `end at bar N` / `end after SECTION` in an arranged program (it rendered every
  section past the end; `sections-end.btw` streamed 20 bars where the program ends at 12).
- the harness records the worklet's slow blocks (`?perf=1`, `stats.slow`) in every run and ties them to bars, flagged
  bars and section starts; `test/audio-perf.mjs` places each real-time slow block and underrun in its section and bar.

## Not fixed (bigger than a quick fix), in order of payoff

1. **btwd: render what the desktop render already renders.** djhost `btw_render::arrangement_report` (what `djctl btw
   render` uses) carries the mixer lines (level, EQ, crossfader, master level), `deck play/stop`, `duck`, `mix` and
   tempo curves. btwd's own lazy `Sections` carries none of them. Merging `control_events` / `mix_events` and
   `btw_tempo::Curve` into its event stream (they are already in beat order and public) closes rows 3, 5, 6, 10, 11 and 14
   and the tempo ramp, on both the stream and the desktop's offline render. Its test pinning `Sections` to
   `btw_render::arrangement` keeps them in step. (The Rust render server under way, run 877941d9, inherits whatever btwd does.)
2. **Sounds in every offline render.** Neither btwd nor `btw_render` applies `kit=` / `sound=` (`DeckIr::sounds()`, which
   only the live runtime reads). Set them right after each section's `Load` (the arrangement has `SetKit` /
   `SetRoleVoice` ops) to close rows 7 and 12.
3. **Inserts in the offline render**: filter (with resonance), reverb, delay, crush. The arrangement has no op for an
   insert. Once it does, the stream gets rows 1, 2, 4, 8, 9, 13 and 15, the most common lines in composed programs.
4. **The engine's missing effects** need djrust engine work, then a wasm rebuild. Resonance: the master chain's filter
   Q is a constant (`FILTER_Q_DB`), and the strip filter is fixed Butterworth, so `filter.res` needs a Q control in
   `Dj`. The others: delay, tricks, freeze, vocoder, moves, deck tempo. `fire_macro` / `engage` exist in the facade and
   may cover some tricks.
5. **Tempo curves.** btwd renders a program at its first tempo, and the engine follows the curve (its nets carry each
   section's tempo). Toward the render would mean the engine holding one tempo, which contradicts the program text.
   Rendering `btw_tempo::Curve` in btwd (item 1) is the fix that agrees with the language. Do not wire the engine's
   `deck tempo` call meanwhile: that was tried and made the engine stray further.
6. **The deployed module lags the language.** 19 corpus programs do not check on beatscript.app's wasm (`4444a54`), so the
   page cannot play them on the engine. Redeploying the module (from main) fixes that and ships the loop restart.
7. **The install step in the bar before a section** reaches 10-32 ms in real time (stats.slow, above). With today's
   buffer there are no drop-outs, but it is the first thing that will glitch on a slower device. Lower `installBudget`,
   or spread the next section's install over more of its bar of notice.
8. **Smaller, still engine-vs-render**: `evolve` generations 3 and 5 of `evolve-demo` (and `evolve-flat`) put their hits
   elsewhere (probably the `thin ... seed=` draw); `linked.btw` and one store program run a constant 128 frames (2.7 ms)
   off the render. The silent outro in `assert.btw` is on both sides.
9. **Until 1-3 land: on auto, play a program with control lines on the engine** (the same rule as a loop), or show
   the stream's own notes (btwd's `start` event lists them, and render.go could pass them on) beside the stream as
   "not in the stream". Today a composed program's first listen silently drops its filters and reverb.

## Caveats

- The engine render is offline, and it waits for each net's compile. A live page relies on the runtime's bar of
  notice instead, and a slow phone can land a net late. Output latency is not modelled.
- Per-deck stems are not compared. With the base sample-identical, the differences above come from strip-level and
  master-level controls, and the repros isolate each one.
- Both renders peak at about 0 dBFS (+0.0 dBTP) on the base groove. That is not a parity issue, but the master is hot.
