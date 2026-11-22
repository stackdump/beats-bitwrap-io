# internal/btwsite/docs (data only)

What is left of the retired Go btwsite docs package: the files btwserve (djrust-vevr-se `crates/btwserve`, `src/docs.rs`)
reads at runtime through `-docs-src internal/btwsite/docs`:

- `api.md`: the hand-written API reference, served at `/docs/api.md` and `/docs/api` (its `https://btw.bitwrap.io`
  is replaced by the server's `-public-url`).
- `assets/docs.css`, `assets/docs.js`: the HTML docs' stylesheet and script, `/docs/assets/*`.

Do not move or rename them without changing btwserve's `-docs-src` in the `btw-rust` `~/services` CMD on pflow.dev
(and in djrust-vevr-se `crates/btwserve/deploy/cutover.sh` RS_CMD) in the same change.
