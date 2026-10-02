# Audio engine bench results

Raw JSON from `public/wave-engine/bench.html` (copy-results button), one file
per device run. Published bench (branch build):
https://cdn.stackdump.com/ipfs/bafyreie6dbb396ae7f07f199bbdf693df1042e/wave-engine/bench.html

×realtime, techno · seed 42 · standard · 20 s:

| device | A Tone default | B wave→Tone master | F wave lean | C wave alone | D wave @24k | E DSP only |
|---|---|---|---|---|---|---|
| valoper (desktop x86, headless Chrome, shared host, load ≈ 3) | 1.7 | 4.5 | 25 | 36–39 | 55–66 | 48–50 |
| Android 10 UA, 8 cores, 8 GB, Chrome 154 (`2026-10-02-android-8gb.json`) | 4.25 | 7.7 | 50 | 59 | 89 | 97 |

Notes:

- The 8 GB Android outran valoper about 2×. Absolute speed varies by device;
  the **ratios** are stable: lean wave ≈ 12–15× cheaper than the Tone default,
  and Tone's master chain ≈ 6–8× the whole wave engine.
- This Android is the high-end reference. P-1 still needs a budget device
  (2–4 GB, ~$150 class) and an old iPhone.
- Offline ×realtime excludes the live session's UI, worker and GC load;
  read 3× as the comfortable floor for live playback.
- Case A peaks at 3.72 (> 0 dBFS) on every device: clipping in Tone's mix.
