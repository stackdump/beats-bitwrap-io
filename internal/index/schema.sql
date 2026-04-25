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
