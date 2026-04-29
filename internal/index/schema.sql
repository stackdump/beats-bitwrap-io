CREATE TABLE IF NOT EXISTS tracks (
    cid          TEXT PRIMARY KEY,
    genre        TEXT NOT NULL DEFAULT '',
    name         TEXT NOT NULL DEFAULT '',
    seed         INTEGER,
    tempo        INTEGER,
    swing        INTEGER,
    humanize     INTEGER,
    root_note    INTEGER,
    scale_name   TEXT NOT NULL DEFAULT '',
    bars         INTEGER,
    structure    TEXT NOT NULL DEFAULT '',
    rendered_at  INTEGER NOT NULL,
    bytes        INTEGER NOT NULL DEFAULT 0,
    -- Provenance fields, populated at RecordRender from the envelope.
    -- source: '' (anonymous) or 'official' (operator-set, validated
    -- against X-Rebuild-Secret on PUT /o/{cid}).
    -- signer_type / signer_address: optional EIP-191 or Ed25519
    -- public-key identity. Validated server-side; the server only
    -- writes these columns if the signature verified.
    source         TEXT NOT NULL DEFAULT '',
    signer_type    TEXT NOT NULL DEFAULT '',
    signer_address TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS tracks_recent ON tracks(rendered_at DESC);
CREATE INDEX IF NOT EXISTS tracks_genre  ON tracks(genre, rendered_at DESC);

-- rebuild_queue: opt-in. Listeners click ⟳ on a feed card to mark
-- its CID for a fresh audio render by an off-host worker
-- (scripts/process-rebuild-queue.py). The /api/rebuild-* routes are
-- only mounted when the server is started with -rebuild-queue. Worker
-- polls /api/rebuild-queue, re-renders, PUTs the new .webm, then calls
-- /api/rebuild-clear to drop the row.
CREATE TABLE IF NOT EXISTS rebuild_queue (
    cid        TEXT PRIMARY KEY,
    marked_at  INTEGER NOT NULL,
    marked_by  TEXT NOT NULL DEFAULT '',
    claimed_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS rebuild_queue_marked ON rebuild_queue(marked_at);

-- track_analysis: per-CID audio quality measurements. One row per
-- CID, last-write-wins. Two producers write here:
--   1. The audio renderer, on every successful render — populates
--      `lufs`/`true_peak_db` from the ffmpeg loudnorm pass and sets
--      `source='loudnorm'`. Cheap, in-band, no extra workload.
--   2. scripts/analyze-audio.py, run off-host against a slice of the
--      catalogue — populates the spectral fields and either
--      sets `source='analyzer'` (overwriting the loudnorm row) or,
--      when keeping the loudnorm LUFS, sets `source='merged'`.
-- Schema mirrors public/schema/beats-audio-analysis.schema.json —
-- keep them in sync if you add a column.
CREATE TABLE IF NOT EXISTS track_analysis (
    cid              TEXT PRIMARY KEY,
    analyzer_version TEXT NOT NULL DEFAULT '',
    analyzed_at      INTEGER NOT NULL,
    source           TEXT NOT NULL DEFAULT '',
    duration_s       REAL,
    lufs             REAL,
    true_peak_db     REAL,
    peak             REAL,
    rms              REAL,
    crest_db         REAL,
    centroid_hz      REAL,
    rolloff85_hz     REAL,
    onset_rate       REAL,
    bpm              REAL,
    band_sub         REAL,
    band_low         REAL,
    band_lomid       REAL,
    band_himid       REAL,
    band_high        REAL,
    hpf_hz           REAL
);
CREATE INDEX IF NOT EXISTS track_analysis_lufs ON track_analysis(lufs);
