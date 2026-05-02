// Shared "Using with AI" modal. Shows a copy-able prompt the user
// can paste into Claude / ChatGPT / any other chat UI to have the
// model emit a valid BeatsShare share-v1 payload. The prompt is
// self-contained — it points the model at the public JSON-Schema and
// gives it the minimum envelope shape so it can compose new payloads
// without any handshaking with our backend.
//
// Invoked from the main help modal and the Stage help modal. Lives
// as its own top-level overlay on document.body so it works
// regardless of which help context opened it.

const AI_PROMPT = `You are composing a BeatsShare share-v1 payload for beats.bitwrap.io — a deterministic Petri-net music sequencer. Emit ONLY a JSON object matching the schema; no prose, no code fences, no commentary.

Schema (source of truth): https://beats.bitwrap.io/schema/beats-share.schema.json
JSON-LD context:         https://beats.bitwrap.io/schema/beats-share.context.jsonld

Required fields:
  "@context": "https://beats.bitwrap.io/schema/beats-share"
  "@type":    "BeatsShare"
  "v":        1
  "genre":    one of: ambient, blues, bossa, country, dnb, dubstep, edm, funk, garage, house, jazz, lofi, metal, reggae, speedcore, synthwave, techno, trance, trap
  "seed":     any integer — same (genre, seed) → byte-identical track

Optional overrides (omit defaults to keep the CID stable):
  "tempo":     20–300   "swing": 0–100   "humanize": 0–100
  "rootNote":  0–127    "scaleName": string   "bars": 0–4096
  "structure": "ab" | "drop" | "build" | "jam" | "minimal" | "standard" | "extended"
  "traits":    { trait keys from the chosen genre → {on: bool, pct?: 0–100} }
  "tracks":    { trackId → {mix?, instrument?, instrumentSet?[]} }
  "fx":        { master-vol?, reverb-wet?, delay-wet?, filter-cutoff?, ... }
  "feel":      { engaged: bool, sliders: { chill?, drive?, ambient?, euphoric? } }
  "autoDj":    { run?, rate?, regen?, stack?, showAutoDj?, pools? }
  "hits":      { hit1–hit4 → {bars?, pitch?, pair?} }
  "ui":        { playbackMode? "single"|"repeat"|"shuffle", showFx?, showMacros?, showOneShots? }
  "loop":      { startTick, endTick }
  "initialMutes": [trackId, …]
  "macrosDisabled": [macroId, …]

Minimum valid payload:
{
  "@context": "https://beats.bitwrap.io/schema/beats-share",
  "@type": "BeatsShare",
  "v": 1,
  "genre": "techno",
  "seed": 42
}

When I ask for a track, respond with only the JSON object. I will paste the JSON into the app's URL box to play it. My request follows:`;

function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function openAiPromptModal() {
    // Collapse any previously-open instance so re-opening doesn't stack.
    document.querySelector('.pn-ai-prompt-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'pn-ai-prompt-overlay';
    overlay.tabIndex = -1;
    overlay.innerHTML = `
        <div class="pn-ai-prompt-box">
            <button class="pn-ai-prompt-close" title="Close (Esc)">&times;</button>
            <h2>Using with AI</h2>
            <p class="pn-ai-prompt-lede">
                Copy this prompt and paste it into Claude, ChatGPT, or any
                chat model. Ask for a track (<i>"ambient at 72 BPM, minor
                key, seed 2024"</i>) and the model will reply with a
                share-v1 JSON blob. Paste that JSON into a new tab as
                <code>?z=</code> data (the app decodes it on load) or
                upload it via Share → <i>Server</i>.
            </p>
            <div class="pn-ai-prompt-actions">
                <button class="pn-ai-prompt-copy">Copy prompt</button>
                <span class="pn-ai-prompt-feedback" aria-live="polite"></span>
            </div>
            <textarea class="pn-ai-prompt-text" spellcheck="false" readonly>${escapeHtml(AI_PROMPT)}</textarea>
            <p class="pn-ai-prompt-foot">
                The schema at
                <a href="/schema/beats-share.schema.json" target="_blank" rel="noopener">/schema/beats-share.schema.json</a>
                is the contract — any producer that emits valid JSON gets
                the same deterministic playback.
            </p>
        </div>
    `;

    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay || e.target.closest('.pn-ai-prompt-close')) close();
    });
    overlay.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); close(); }
    });

    const copyBtn = overlay.querySelector('.pn-ai-prompt-copy');
    const feedback = overlay.querySelector('.pn-ai-prompt-feedback');
    const textarea = overlay.querySelector('.pn-ai-prompt-text');
    copyBtn.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(AI_PROMPT);
            feedback.textContent = 'Copied';
        } catch {
            // Clipboard permission denied / insecure context — fall back
            // to selecting the textarea so the user can Cmd/Ctrl+C.
            textarea.focus();
            textarea.select();
            feedback.textContent = 'Select + copy';
        }
        setTimeout(() => { feedback.textContent = ''; }, 1800);
    });

    document.body.appendChild(overlay);
    overlay.focus();
}
