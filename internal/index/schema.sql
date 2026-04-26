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
    bytes        INTEGER NOT NULL DEFAULT 0
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
