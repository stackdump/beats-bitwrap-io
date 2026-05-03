BINARY := beats-bitwrap-io
ADDR   := :8089
VERSION := $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)

.PHONY: build run dev clean docs test-audio seed-collection-extended

build:
	go build -ldflags "-X main.version=$(VERSION)" -o $(BINARY) .

run: build
	./$(BINARY) -addr $(ADDR)

dev:
	go run -ldflags "-X main.version=$(VERSION)" . -addr $(ADDR) -public public

# Render the categorical-map SVG to PNG and mirror both into public/docs
# so GitHub preview, the README embed, and the in-app "control category"
# link all stay in sync. Also renders the 1200x630 OG card used as the
# social-preview image. Requires rsvg-convert (brew install librsvg).
docs: docs/control-category.png docs/control-category-og.png \
      public/docs/control-category.svg public/docs/control-category.png \
      public/docs/control-category-og.png

docs/control-category.png: docs/control-category.svg
	@command -v rsvg-convert >/dev/null || { echo "rsvg-convert not found (brew install librsvg)"; exit 1; }
	rsvg-convert -w 2000 $< -o $@

docs/control-category-og.png: docs/control-category-og.svg
	@command -v rsvg-convert >/dev/null || { echo "rsvg-convert not found (brew install librsvg)"; exit 1; }
	rsvg-convert -w 1200 -h 630 $< -o $@

public/docs/control-category.svg: docs/control-category.svg
	@mkdir -p public/docs
	cp $< $@

public/docs/control-category.png: docs/control-category.png
	@mkdir -p public/docs
	cp $< $@

public/docs/control-category-og.png: docs/control-category-og.png
	@mkdir -p public/docs
	cp $< $@

clean:
	rm -f $(BINARY)

# Headless macro-audio verification. Boots a local server (no audio
# render needed — capture happens inside the test browser tabs) and
# runs scripts/test-macro-audio.py against it across N parallel
# Chromium tabs. Requires `pip install playwright numpy scipy` and
# `playwright install chromium`.
TEST_AUDIO_PORT := 18091
TEST_AUDIO_DATA := /tmp/beats-test-audio-data
TEST_AUDIO_WORKERS ?= 4
test-audio: build
	@rm -rf $(TEST_AUDIO_DATA) && mkdir -p $(TEST_AUDIO_DATA)
	@echo "starting test server on :$(TEST_AUDIO_PORT)"
	@./$(BINARY) -authoring -addr :$(TEST_AUDIO_PORT) -data $(TEST_AUDIO_DATA) -public public > /tmp/beats-test-audio.log 2>&1 & echo $$! > /tmp/beats-test-audio.pid
	@for i in 1 2 3 4 5 6 7 8 9 10; do \
	    curl -fsS -o /dev/null http://localhost:$(TEST_AUDIO_PORT)/ && break; sleep 0.5; \
	done
	@trap 'kill $$(cat /tmp/beats-test-audio.pid) 2>/dev/null; rm -f /tmp/beats-test-audio.pid' EXIT; \
	  ./scripts/test-macro-audio.py --host http://localhost:$(TEST_AUDIO_PORT) --workers $(TEST_AUDIO_WORKERS) $(TEST_AUDIO_ARGS)

# Rebuild + resubmit the official collection with structure=extended.
# Boots a local authoring server with chromedp realtime render, runs
# seed-feed across every genre with --official + --structure extended,
# then tears the server down. Per-genre seeds + arrangeSeed=seed make
# the envelopes deterministic — re-runs hit existing CIDs and the
# rebuild-secret bypasses first-write-wins on the audio PUT.
#
# Required env: BEATS_REBUILD_SECRET (cat ~/.../data/.rebuild-secret).
# Tunables: SEED_PER_GENRE (default 3), SEED_WORKERS (default 4),
# SEED_UPLOAD_HOST (default https://beats.bitwrap.io).
SEED_PORT        := 18090
SEED_DATA        := /tmp/beats-seed-data
SEED_PER_GENRE   ?= 3
SEED_WORKERS     ?= 8
SEED_UPLOAD_HOST ?= https://beats.bitwrap.io
seed-collection-extended: build
	@if [ -z "$$BEATS_REBUILD_SECRET" ]; then \
	    echo "BEATS_REBUILD_SECRET unset (cat ~/Workspace/beats-bitwrap-io/data/.rebuild-secret on pflow.dev)"; \
	    exit 2; \
	fi
	@mkdir -p $(SEED_DATA)
	@if [ ! -s "$(SEED_DATA)/.operator-key" ]; then \
	    echo "missing $(SEED_DATA)/.operator-key — copy prod's so envelopes are signed by the canonical operator pubkey:"; \
	    echo "  scp pflow.dev:~/Workspace/beats-bitwrap-io/data/.operator-key $(SEED_DATA)/.operator-key && chmod 600 $(SEED_DATA)/.operator-key"; \
	    exit 2; \
	fi
	@printf '%s' "$$BEATS_REBUILD_SECRET" > $(SEED_DATA)/.rebuild-secret && chmod 600 $(SEED_DATA)/.rebuild-secret
	@rm -rf $(SEED_DATA)/o $(SEED_DATA)/audio $(SEED_DATA)/index.db
	@if lsof -nP -iTCP:$(SEED_PORT) -sTCP:LISTEN >/dev/null 2>&1; then \
	    echo "killing stale process on :$(SEED_PORT)"; \
	    pkill -f "$(BINARY).*-addr :$(SEED_PORT)" || true; sleep 2; \
	fi
	@echo "starting authoring+render server on :$(SEED_PORT)"
	@./$(BINARY) -authoring -audio-render -audio-auto-enqueue=false \
	    -audio-concurrent $(SEED_WORKERS) -audio-max-duration 6m \
	    -audio-render-timeout 15m -addr :$(SEED_PORT) -data $(SEED_DATA) \
	    -public public > /tmp/beats-seed.log 2>&1 & echo $$! > /tmp/beats-seed.pid
	@ok=0; for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do \
	    if curl -fsS -o /dev/null http://localhost:$(SEED_PORT)/; then ok=1; break; fi; sleep 0.5; \
	done; \
	if [ "$$ok" != "1" ]; then echo "server failed to start; tail of /tmp/beats-seed.log:"; tail -20 /tmp/beats-seed.log; exit 3; fi
	@trap 'kill $$(cat /tmp/beats-seed.pid) 2>/dev/null; rm -f /tmp/beats-seed.pid' EXIT; \
	  ./scripts/seed-feed.py \
	      --local-host http://localhost:$(SEED_PORT) \
	      --upload-host $(SEED_UPLOAD_HOST) \
	      --per-genre $(SEED_PER_GENRE) \
	      --workers $(SEED_WORKERS) \
	      --official --structure extended \
	      --rebuild-secret "$$BEATS_REBUILD_SECRET" $(SEED_ARGS)
