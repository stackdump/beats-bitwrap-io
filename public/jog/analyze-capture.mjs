// node public/jog/analyze-capture.mjs jog-capture-….json
// Re-run the learner over a capture downloaded from calibrate.html and print
// the assumed-vs-measured table. Exit 1 if anything differs from the guess.
import fs from 'node:fs';
import { INPULSE_200_MK3 } from './inpulse-200-mk3.js';
import { STEPS, buildOverride, diffProfile } from './learn.js';

const session = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const results = {};
for (const step of STEPS) {
    const cap = session.steps?.[step.id];
    if (!cap) continue;
    const byPort = new Map();
    for (const m of cap) byPort.set(m.port, (byPort.get(m.port) || 0) + 1);
    const busiest = [...byPort.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    results[step.id] = step.analyze(cap.filter((m) => m.port === busiest), results);
    console.log(`\n## ${step.title} — ${cap.length} messages`);
    console.log(JSON.stringify(results[step.id]));
    for (const w of step.warn(results[step.id], results).filter(Boolean)) console.log('  ! ' + w);
}
const port = session.ports?.find((p) => p.dir === 'in')?.name;
const override = buildOverride(results, port);
const rows = diffProfile(INPULSE_200_MK3, override);
console.log('\nports:', (session.ports || []).map((p) => `${p.dir}:${p.name}`).join(', ') || '(none recorded)');
console.table(rows);
console.log('override:', JSON.stringify(override));
process.exit(rows.some((r) => !r.same) ? 1 : 0);
