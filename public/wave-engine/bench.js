// bench.js — standalone page for bench-core.js (see bench.html).
// Query params: ?genre=&structure=&seconds=&cases=A,B,F,C,D,E&auto=1

import { composeProject } from './offline.js';
import { runBench, verdict, recommend, CASE_ORDER, REFERENCE, submitReport, resultsUrl } from './bench-core.js';

const $ = (id) => document.getElementById(id);
const q = new URLSearchParams(location.search);
const GENRES = ['techno', 'house', 'edm', 'trance', 'dnb', 'dubstep', 'jazz', 'ambient', 'lofi', 'synthwave',
    'funk', 'bossa', 'blues', 'country', 'reggae', 'trap', 'garage', 'metal', 'speedcore'];
for (const g of GENRES) $('genre').add(new Option(g, g));
$('genre').value = q.get('genre') || REFERENCE.genre;
if (q.has('structure')) $('structure').value = q.get('structure');
$('seconds').value = q.get('seconds') || REFERENCE.seconds;
const status = (s) => { $('status').textContent = s; };

async function run() {
    $('run').disabled = true; $('copy').disabled = true;
    const tbody = $('out').querySelector('tbody');
    tbody.innerHTML = '';
    const genre = $('genre').value, structure = $('structure').value, seconds = Number($('seconds').value) || 20;
    status(`composing ${genre}/${structure || 'loop'}…`);
    const project = composeProject(genre, REFERENCE.seed, structure);
    const report = await runBench({
        project, seconds, track: { genre, seed: REFERENCE.seed, structure: structure || 'loop' },
        cases: (q.get('cases') || CASE_ORDER.join(',')).split(','),
        onStart: (id, c) => status(`running ${id} · ${c.label}…`),
        onCase: (row) => {
            const v = row.error ? { level: 'bad', text: 'error: ' + row.error }
                : row.peak === 0 ? { level: 'bad', text: 'silent?' } : verdict(row.xRealtime);
            const tr = document.createElement('tr');
            tr.innerHTML = `<td>${row.name}</td><td class="num">${row.error ? '' : (row.renderMs / 1000).toFixed(1) + ' s'}</td>`
                + `<td class="num">${row.error ? '' : row.xRealtime + '×'}</td><td><span class="${v.level}">${v.text}</span></td>`;
            tbody.appendChild(tr);
        },
    });
    $('dev').textContent = JSON.stringify(report, null, 2);
    window.__benchReport = report;
    status(recommend(report) || 'done');
    $('run').disabled = false; $('copy').disabled = false;
    $('submitbox').style.display = ''; $('submit').disabled = false;
}

$('resultslink').href = resultsUrl();
$('submit').onclick = async () => {
    if (!window.__benchReport) return;
    $('submit').disabled = true;
    try {
        const r = await submitReport(window.__benchReport, $('label').value);
        status(`submitted (#${r.id}) — thank you`);
    } catch (err) {
        status('submit failed: ' + err.message);
        $('submit').disabled = false;
    }
};

$('run').onclick = run;
$('copy').onclick = async () => {
    try { await navigator.clipboard.writeText($('dev').textContent); status('copied'); }
    catch { status('select the JSON below and copy it'); }
};
if (q.get('auto') === '1') run();
