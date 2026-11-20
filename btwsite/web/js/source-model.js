// Which sound source plays a program: the in-browser engine or the server's stream. Pure (app.js pickSource).

/**
 * 'engine' | 'stream' | null.
 *   engine   the engine is loaded           stream  the program may go to the server (canStream)
 *   pref     the person's choice: 'engine' | 'stream' | anything else (auto)
 *   trigger  'eval' (an edit, Cmd+Enter) or 'load' (open, compose)
 *   loops    the program loops (its check's `loops`)
 *
 * Auto plays a loaded program on the stream (it starts sooner than a compile) and an edit on the engine (it lands on the
 * next bar). A program that LOOPS goes to the engine when the engine is there: the stream is a finite render of one pass,
 * so on the stream it would end, not start again (test/parity/loop.mjs).
 */
export function chooseSource({ engine, stream, pref, trigger, loops }) {
    if (pref === 'engine') return engine ? 'engine' : null;
    if (pref === 'stream') return stream ? 'stream' : null;
    if (trigger === 'load' && !(loops && engine)) return stream ? 'stream' : engine ? 'engine' : null;
    if (engine) return 'engine';
    return stream ? 'stream' : null;
}

/** What to say when a streamed render runs out: a looping program's stream is one pass of it. */
export function renderEndedMessage(loops) {
    return loops ? 'The render ended: the stream is one pass of a looping program. Play it on the engine to keep it looping.' : 'The render ended.';
}
