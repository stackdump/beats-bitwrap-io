// Benchmark modal — measure this device's audio-thread headroom for the
// default (Tone) engine vs the wave engine, any time, from the studio.
// Open from the Help modal ("Benchmark this device") or with ?bench=1.
// The bench code (wave-engine/bench-core.js) loads only when this opens.

const HISTORY_KEY = 'pn-bench-history';
const HISTORY_MAX = 12;

function loadHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; }
}
function saveHistory(list) {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX))); } catch {}
}

const LEVEL_COLOR = { ok: '#5fd37a', meh: '#e8b04b', bad: '#ff6b6b' };

export function showBenchModal(el) {
    el.querySelector('.pn-bench-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'pn-help-overlay pn-bench-overlay';
    overlay.tabIndex = -1;
    overlay.innerHTML = `
        <div class="pn-help-modal" style="max-width:680px;width:96vw">
            <button class="pn-help-close" title="Close (Esc)">&times;</button>
            <h2>Benchmark this device</h2>
            <p style="color:#aaa;margin:0 0 10px;font-size:13px">
                Renders a track through each audio engine as fast as this device can, in the same audio graph a live
                session uses. <b>×realtime</b> is headroom: ≥ 3× is comfortable, under 1.5× will crackle.
                Playback stops while it runs; keep the screen on (about a minute on a phone).
            </p>
            <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px">
                <button type="button" class="pn-bench-run" data-which="reference" title="techno · seed 42 · standard · 20 s — the same on every device, so results compare">Run reference track</button>
                <button type="button" class="pn-bench-run" data-which="current" title="The track loaded right now, first 20 s">Run current track</button>
                <label style="font-size:13px;color:#ccc"><input type="checkbox" class="pn-bench-quick"> quick (default vs wave only)</label>
            </div>
            <div class="pn-bench-status" style="min-height:1.4em;color:#ccc;font-size:13px"></div>
            <table class="pn-bench-table" style="width:100%;border-collapse:collapse;margin:8px 0;font-size:13px;font-variant-numeric:tabular-nums"></table>
            <div class="pn-bench-rec" style="font-size:13px;margin:6px 0 10px"></div>
            <div style="display:flex;gap:8px;margin-bottom:12px">
                <button type="button" class="pn-bench-copy" disabled title="Copy the full JSON report">Copy results</button>
            </div>
            <h3 style="margin:8px 0 4px">History on this device</h3>
            <div class="pn-bench-history" style="font-size:12px;color:#aaa"></div>
        </div>
    `;
    el.appendChild(overlay);
    overlay.focus();

    const $ = (sel) => overlay.querySelector(sel);
    const status = (s) => { $('.pn-bench-status').textContent = s; };
    let lastReport = null;
    let running = false;

    const renderHistory = () => {
        const list = loadHistory();
        $('.pn-bench-history').innerHTML = list.length ? `<table style="width:100%;border-collapse:collapse">
            <tr style="color:#888"><td>when</td><td>track</td><td style="text-align:right">default</td><td style="text-align:right">wave</td></tr>
            ${list.map(h => `<tr><td>${new Date(h.at).toLocaleString()}</td><td>${h.track}</td>
                <td style="text-align:right">${h.A ?? '–'}×</td><td style="text-align:right">${h.F ?? '–'}×</td></tr>`).join('')}
        </table>` : 'No runs yet.';
    };
    renderHistory();

    const header = () => {
        $('.pn-bench-table').innerHTML = `<tr style="color:#888;text-align:left">
            <th style="padding:4px">case</th><th style="padding:4px">plays as</th>
            <th style="padding:4px;text-align:right">×realtime</th><th style="padding:4px">verdict</th></tr>`;
    };

    const run = async (which) => {
        if (running) return;
        running = true;
        overlay.querySelectorAll('.pn-bench-run').forEach(b => { b.disabled = true; });
        $('.pn-bench-copy').disabled = true;
        $('.pn-bench-rec').textContent = '';
        header();
        try {
            if (el._playing) el._togglePlay();
            status('loading bench…');
            const core = await import('../../wave-engine/bench-core.js');
            let project, track;
            if (which === 'current' && el._lastProjectJSON) {
                project = el._lastProjectJSON;
                track = { current: el._lastProjectJSON.name || 'current track' };
            } else {
                project = core.referenceProject();
                track = { genre: core.REFERENCE.genre, seed: core.REFERENCE.seed, structure: core.REFERENCE.structure };
                if (which === 'current') status('no current track loaded — running the reference track');
            }
            const cases = $('.pn-bench-quick').checked ? ['A', 'F'] : core.CASE_ORDER;
            const report = await core.runBench({
                project, track, cases,
                onStart: (id, c) => status(`running ${id} · ${c.label}…`),
                onCase: (row) => {
                    const v = row.error ? { level: 'bad', text: 'error: ' + row.error } : core.verdict(row.xRealtime);
                    const tr = document.createElement('tr');
                    tr.innerHTML = `<td style="padding:4px">${row.name}</td>
                        <td style="padding:4px;color:#999">${core.CASES[row.case].engine}</td>
                        <td style="padding:4px;text-align:right">${row.error ? '' : row.xRealtime + '×'}</td>
                        <td style="padding:4px;color:${LEVEL_COLOR[v.level]}">${v.text}</td>`;
                    $('.pn-bench-table').appendChild(tr);
                },
            });
            lastReport = report;
            $('.pn-bench-rec').textContent = core.recommend(report);
            $('.pn-bench-copy').disabled = false;
            const x = (id) => report.results.find(r => r.case === id && !r.error)?.xRealtime;
            saveHistory([{ at: report.at, track: track.current || `${track.genre}·${track.seed}·${track.structure}`,
                A: x('A'), F: x('F'), C: x('C') }, ...loadHistory()]);
            renderHistory();
            status('done');
        } catch (err) {
            status('bench failed: ' + ((err && err.message) || err));
        } finally {
            running = false;
            overlay.querySelectorAll('.pn-bench-run').forEach(b => { b.disabled = false; });
        }
    };

    overlay.querySelectorAll('.pn-bench-run').forEach(b => b.addEventListener('click', () => run(b.dataset.which)));
    $('.pn-bench-copy').addEventListener('click', async () => {
        if (!lastReport) return;
        const text = JSON.stringify(lastReport, null, 2);
        try { await navigator.clipboard.writeText(text); status('copied'); }
        catch {
            const ta = document.createElement('textarea');
            ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px';
            document.body.appendChild(ta); ta.select();
            try { document.execCommand('copy'); status('copied'); } catch { status('copy failed'); }
            ta.remove();
        }
    });
    const close = () => { if (!running) overlay.remove(); };
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay || e.target.closest('.pn-help-close')) close();
    });
    overlay.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    // Test hook: the report of the last completed run.
    el._benchLastReport = () => lastReport;
}
