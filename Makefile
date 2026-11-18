BINARY := beats-bitwrap-io
ADDR   := :8089
VERSION := $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)

.PHONY: build run dev dev-lan clean docs test test-audio test-e2e test-cohesion-parity test-model-parity \
        test-wave test-wave-browser test-scope-browser wave-render wave-bench \
        djrust-wasm djrust-pin djrust-publish check-djrust-pin djrust-verify-cdn test-djrust test-djrust-browser \
        test-djrust-golden test-djrust-neutral test-djrust-cpu djrust-ref cid-freeze \
        test-djrust-node test-scope-kernels test-insert-render test-wave-tick-feed test-crop \
        test-djwasm-030 test-djwasm-030-browser test-djrust-newglue \
        probe-djrust-gaps test-djrust-page-macros test-djrust-page-instrument test-djrust-render-freeze \
        seed-collection-extended bazel-build bazel-test bazel-gazelle

build:
	go build -ldflags "-X main.version=$(VERSION)" -o $(BINARY) .
	@mkdir -p btwsite/bin && go build -o btwsite/bin/btwsite ./cmd/btwsite

run: build
	./$(BINARY) -addr $(ADDR)

dev:
	go run -ldflags "-X main.version=$(VERSION)" . -addr $(ADDR) -public public

# The studio over https on the LAN: an AudioWorklet (the djrust engine) needs a secure context and a
# LAN address over plain http is not one. scripts/dev-cert.sh makes a local CA and a server
# certificate; trust the CA once per device.
#   make dev-lan LAN_IP=192.168.1.243 [LAN_PORT=18443]
LAN_PORT ?= 18443
DEV_CERT_DIR ?= $(HOME)/.config/beats-dev-cert
dev-lan:
	@test -n "$(LAN_IP)" || { echo "LAN_IP=<this machine's LAN address> is needed"; exit 2; }
	@BEATS_DEV_CERT_DIR=$(DEV_CERT_DIR) scripts/dev-cert.sh $(LAN_IP)
	@echo "open https://$(LAN_IP):$(LAN_PORT)/"
	go run -ldflags "-X main.version=$(VERSION)" . -addr $(LAN_IP):$(LAN_PORT) -public public \
	  -tls-cert $(DEV_CERT_DIR)/server.pem -tls-key $(DEV_CERT_DIR)/server-key.pem

# --- Bazel (Bzlmod, hermetic — opt-in alongside `go build`) ---
# `make build` deliberately stays on `go build`: it emits ./$(BINARY) at the
# repo root, which test-audio / seed-collection-extended invoke directly.
# These targets mirror what CI runs (.github/workflows/ci.yml) for local
# parity. Every dependency resolves from the module proxy, so no sibling
# checkout is needed.
bazel-build:
	bazel build //...

bazel-test:
	bazel test //... --test_output=errors

# Regenerate BUILD.bazel files after adding/moving .go files or imports.
# Preview without writing: `bazel run //:gazelle -- -mode=diff`.
bazel-gazelle:
	bazel run //:gazelle

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

# Cohesion v2 — Go↔JS motif parity check. Asserts that
# public/lib/generator/theme.js::buildTrackTheme('techno', 42) produces the
# same MotifCell as internal/generator/theme.go::BuildTrackTheme. If this
# drifts, shared `cohesion: "v2"` envelopes play different motifs on
# Go-served audio (authoring) vs JS-served audio (prod static-host).
# Both halves of the contract:
#   - Go side: `go test ./internal/generator/ -run TestPinnedMotifVectorTechnoSeed42`
#   - JS side: this target (requires `node` >= 14 with ESM support).
test-cohesion-parity:
	@go test ./internal/generator/ -run TestPinnedMotifVectorTechnoSeed42 -count=1
	@node scripts/test-cohesion-parity.mjs

# Live Go↔JS model-CID parity — runs BOTH live producers (the Go binary
# in tools/parity and public/lib/pflow.js) on the same fixture and diffs
# canonical JSON + CID byte-for-byte. Bazel equivalent:
# `bazel test //tools/parity:model_cid_parity_test`.
test-model-parity:
	@go build -o /tmp/beats-model-cid ./tools/parity
	@GO_MODEL_CID=/tmp/beats-model-cid node tools/parity/model-cid-parity.mjs

# Full pre-commit gate: Go unit tests + both Go↔JS parity checks.
test:
	go test ./...
	@$(MAKE) --no-print-directory test-cohesion-parity
	@$(MAKE) --no-print-directory test-model-parity
	@$(MAKE) --no-print-directory test-wave
	@$(MAKE) --no-print-directory check-djrust-pin
	@$(MAKE) --no-print-directory cid-freeze
	@$(MAKE) --no-print-directory test-djrust-golden
	@$(MAKE) --no-print-directory test-djrust-node

# Headless macro-audio verification on the djrust engine. Boots a local
# server and runs scripts/test-macro-audio.py against it across N parallel
# browsers: each fires one net macro through the page (el._fireMacro) and
# captures the audio host's master losslessly through a capture AudioWorklet
# (lib/test-hooks.js), then asserts cut, breakdown, drop and half-time take
# effect and recover, and that the engine ran each exactly once.
# Requires Python with playwright + numpy (`python3 -m venv V && V/bin/pip
# install playwright numpy`; PYTHON=V/bin/python). The system google-chrome
# is used when Playwright's own Chromium is not installed.
# The port must be free: 18091 is cdn-stackdump-com's on valoper and pflow.dev, and a test server
# that cannot bind would leave the browsers talking to whatever holds the port (the recipe refuses).
PYTHON ?= python3
TEST_AUDIO_PORT ?= 18097
TEST_AUDIO_DATA := /tmp/beats-test-audio-data-$(TEST_AUDIO_PORT)
TEST_AUDIO_WORKERS ?= 4
test-audio: build
	@rm -rf $(TEST_AUDIO_DATA) && mkdir -p $(TEST_AUDIO_DATA)
	@if curl -s -o /dev/null http://localhost:$(TEST_AUDIO_PORT)/ 2>/dev/null; then \
	    echo "test-audio: something already answers on :$(TEST_AUDIO_PORT); pick a free TEST_AUDIO_PORT"; exit 1; fi
	@echo "starting test server on :$(TEST_AUDIO_PORT)"
	@./$(BINARY) -addr :$(TEST_AUDIO_PORT) -data $(TEST_AUDIO_DATA) -public public > /tmp/beats-test-audio-$(TEST_AUDIO_PORT).log 2>&1 & echo $$! > /tmp/beats-test-audio-$(TEST_AUDIO_PORT).pid
	@for i in 1 2 3 4 5 6 7 8 9 10; do \
	    curl -fsS -o /dev/null http://localhost:$(TEST_AUDIO_PORT)/ && break; sleep 0.5; \
	done
	@kill -0 $$(cat /tmp/beats-test-audio-$(TEST_AUDIO_PORT).pid) 2>/dev/null || { \
	    echo "test-audio: the test server did not start on :$(TEST_AUDIO_PORT) (port in use?)"; \
	    tail -3 /tmp/beats-test-audio-$(TEST_AUDIO_PORT).log; exit 1; }
	@trap 'kill $$(cat /tmp/beats-test-audio-$(TEST_AUDIO_PORT).pid) 2>/dev/null; rm -f /tmp/beats-test-audio-$(TEST_AUDIO_PORT).pid' EXIT; \
	  $(PYTHON) scripts/test-macro-audio.py --host http://localhost:$(TEST_AUDIO_PORT) --workers $(TEST_AUDIO_WORKERS) $(TEST_AUDIO_ARGS)

# Full UI e2e — drives the controls (transport, panels, master volume,
# keyboard shortcuts, mixer, Feel, generate/shuffle/genre, share, mocked
# Web MIDI) and checks the Tone-era features are off, through the real DOM
# in headless Chrome via raw CDP. No Python deps — node >= 20 +
# google-chrome. Boots its own server on :18096 (TEST_E2E_PORT); Chrome's
# debugging port is TEST_E2E_CDP_PORT, so a run can sit beside another suite.
TEST_E2E_PORT ?= 18096
TEST_E2E_CDP_PORT ?= 9340
TEST_E2E_DATA := /tmp/beats-test-e2e-data
test-e2e: build
	@rm -rf $(TEST_E2E_DATA) && mkdir -p $(TEST_E2E_DATA)
	@echo "starting e2e server on :$(TEST_E2E_PORT)"
	@./$(BINARY) -authoring -addr :$(TEST_E2E_PORT) -data $(TEST_E2E_DATA) -public public > /tmp/beats-test-e2e.log 2>&1 & echo $$! > /tmp/beats-test-e2e.pid
	@for i in 1 2 3 4 5 6 7 8 9 10; do \
	    curl -fsS -o /dev/null http://localhost:$(TEST_E2E_PORT)/ && break; sleep 0.5; \
	done
	@trap 'kill $$(cat /tmp/beats-test-e2e.pid) 2>/dev/null; rm -f /tmp/beats-test-e2e.pid' EXIT; \
	  CDP_PORT=$(TEST_E2E_CDP_PORT) node scripts/test-e2e-controls.mjs http://localhost:$(TEST_E2E_PORT) $(TEST_E2E_ARGS)

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

# --- Wave engine (?engine=wave) — public/wave-engine/ ---
# Determinism, P-invariants, ring spectrum vs DFT of place weights, closed
# form vs IIR gate, executor parity with the worker, nesting, allocation.
test-wave:
	@node scripts/test-wave-engine.mjs
	@node scripts/test-sw.mjs

# Real browser: boots the server from public/, drives headless Chrome over
# CDP, checks the worklet plays and the default engine is unchanged.
test-wave-browser: build
	@./$(BINARY) -addr :18093 -public public -data /tmp/wave-browser-data >/tmp/wave-browser-server.log 2>&1 & \
	  pid=$$!; sleep 2; WAVE_DATA_DIR=/tmp/wave-browser-data node scripts/test-wave-browser.mjs http://localhost:18093; rc=$$?; kill $$pid; exit $$rc

# Scope tab (lib/ui/scope.js): headless Chrome plays techno/42 in both
# engines and at phone width, opens Scope, checks every view draws, the
# model kernel table renders, measured + residual work and the loop stops
# when the tab closes. SCOPE_SHOTS=<dir> saves a PNG per view.
test-scope-browser: build
	@./$(BINARY) -addr :18094 -public public -data /tmp/scope-browser-data >/tmp/scope-browser-server.log 2>&1 & \
	  pid=$$!; sleep 2; node scripts/test-scope-browser.mjs http://localhost:18094 $(SCOPE_SHOTS); rc=$$?; kill $$pid; exit $$rc

# make wave-render GENRE=techno SEED=42 STRUCTURE=standard SECONDS=30
GENRE ?= techno
SEED ?= 42
STRUCTURE ?=
SECONDS ?= 30
wave-render:
	node scripts/wave-render.mjs --genre $(GENRE) --seed $(SEED) $(if $(STRUCTURE),--structure $(STRUCTURE)) --seconds $(SECONDS)

wave-bench:
	node scripts/wave-bench.mjs

# --- djrust engine (?engine=djrust) — public/djrust/ -------------------------------------
# The Rust engine as WebAssembly in the same worklet slot as the JS wave engine. The module is the
# `djwasm` npm package (github.com/stackdump/djrust, cabi/, MIT), pinned by exact version + SRI
# hash in public/djrust/pin.js and loaded from `source`: "bundled" (the committed
# public/djrust/djwasm.wasm, now) or "cdn" (jsDelivr). The deploy never builds Rust. loader.js /
# worklet.js are that package's glue, vendored byte for byte. See docs/MIGRATION-djrust-wasm.md.
#   djrust-wasm        build ../djrust ($$DJRUST_DIR) into public/djrust/djwasm.wasm (committed;
#                      a non-pinned build fails check-djrust-pin while source is bundled)
#   djrust-pin         same, and re-pin pin.js + the glue to that build
#   djrust-publish     publish the pinned version to npm (needs npm login), then verify jsDelivr
#   check-djrust-pin   offline: vendored glue = the pin (part of make test)
#   djrust-verify-cdn  online: jsDelivr serves the pinned bytes
DJRUST_DIR ?= ../djrust
djrust-wasm:
	@DJRUST_DIR=$(DJRUST_DIR) ./scripts/build-djrust-wasm.sh

djrust-pin:
	@DJRUST_DIR=$(DJRUST_DIR) ./scripts/build-djrust-wasm.sh --pin

# Flip where the page loads djwasm from (pin.js `source`): bundled = the committed
# public/djrust/djwasm.wasm, cdn = jsDelivr at the pinned version (run djrust-verify-cdn first).
djrust-use-bundled:
	@node scripts/djrust-pin.mjs use bundled
djrust-use-cdn: djrust-verify-cdn
	@node scripts/djrust-pin.mjs use cdn
.PHONY: djrust-use-bundled djrust-use-cdn

djrust-publish: djrust-wasm
	@$(DJRUST_DIR)/cabi/publish.sh
	@node scripts/djrust-pin.mjs verify

check-djrust-pin:
	@node scripts/djrust-pin.mjs check

djrust-verify-cdn:
	@node scripts/djrust-pin.mjs verify

# Live parity against this repo's own JS: generator bytes + CIDs, audio, ticks, markings, the worklet
# without TextEncoder. Node only.
test-djrust:
	@node scripts/test-djrust-wasm.mjs

# Real browser: headless Chrome plays techno/42 through ?engine=djrust, and the fallbacks, and the
# tri-render (each live script: Node direct = Node worklet = OfflineAudioContext = live AudioContext).
# Ports are overridable so parallel runs do not collide: DJRUST_BROWSER_PORT (server), CDP_PORT (Chrome).
DJRUST_BROWSER_PORT ?= 18095
CDP_PORT ?= 9342
test-djrust-browser: build
	@./$(BINARY) -addr :$(DJRUST_BROWSER_PORT) -public public -data /tmp/djrust-browser-data-$(DJRUST_BROWSER_PORT) >/tmp/djrust-browser-server-$(DJRUST_BROWSER_PORT).log 2>&1 & \
	  pid=$$!; sleep 2; CDP_PORT=$(CDP_PORT) node scripts/test-djrust-browser.mjs http://localhost:$(DJRUST_BROWSER_PORT); rc=$$?; kill $$pid; exit $$rc

# --- djwasm 0.3.0 page wiring (plan step 3) ---------------------------------------------------
#   probe-djrust-gaps          the gap scoreboard in headless Chrome (boots its own server; ports
#                              overridable); gate: cut and solo-drums fired through the page are audible
#                              (rms ratio < 1.0)
#   test-djrust-page-macros    scripts/test-djrust-page-macros.mjs (Node only, no server: page-side
#                              macro routing, engine gaps, seek, groove); part of test-djrust-node;
#                              PAGE_MACROS_ARGS are passed through
#   test-djrust-render-freeze  scripts/test-djrust-render-freeze.mjs (Node: the feed corpus through the
#                              real offline-render path = the golden; the render-farm freeze, ~80 s);
#                              RENDER_FREEZE_ARGS are passed through
PROBE_PORT ?= 18136
PROBE_CDP_PORT ?= 9343
probe-djrust-gaps: build
	@./$(BINARY) -addr :$(PROBE_PORT) -public public -data /tmp/djrust-probe-data-$(PROBE_PORT) >/tmp/djrust-probe-server-$(PROBE_PORT).log 2>&1 & \
	  pid=$$!; sleep 2; CDP_PORT=$(PROBE_CDP_PORT) node --no-warnings scripts/probe-djrust-gaps.mjs http://localhost:$(PROBE_PORT); rc=$$?; kill $$pid; exit $$rc

test-djrust-page-macros:
	@node --no-warnings scripts/test-djrust-page-macros.mjs $(PAGE_MACROS_ARGS)

#   test-djrust-page-instrument  scripts/test-djrust-page-instrument.mjs (Node only: the live instrument
#                              change, R-5: engine gaps, mixer / Shuffle routing, the worker's project,
#                              and page -> worklet -> djwasm on a module with INSTRUMENT; on one without
#                              it only the no-op half runs); part of test-djrust-node
test-djrust-page-instrument:
	@node --no-warnings scripts/test-djrust-page-instrument.mjs

test-djrust-render-freeze:
	@node --no-warnings scripts/test-djrust-render-freeze.mjs --skip-missing $(RENDER_FREEZE_ARGS)

# --- djrust gates (docs/MIGRATION-djrust-wasm.md §12 plan, step 0) ---------------------------
# The module under test is $$DJRUST_WASM (a .wasm file or a djrust cabi/pkg dir), else the local
# public/djrust/djwasm.wasm. Every gate skips with a notice when there is no module.
#   test-djrust-golden   the ABI-1 call sequence must reproduce scripts/djrust-golden.json (djwasm
#                        0.2.0) on audio, ticks, report, marking and muted (part of make test)
#   test-djrust-neutral  the same corpus with every new control sent at its neutral value
#   test-djrust-cpu      per-quantum cost and memory against djwasm 0.2.0, measured side by side
#                        (the 0.2.0 reference: make djrust-ref, .djrust-ref/, git-ignored, never served)
#   djrust-ref           fetch djwasm@0.2.0 from jsDelivr into .djrust-ref/djwasm@0.2.0/, hash-checked
#   test-djrust-render-freeze  (above) the feed corpus through the page's offline-render path = the golden
#   cid-freeze           CID-deciding files unchanged; examples + feed-corpus CIDs recompute (part of make test)
test-djrust-golden:
	@node --no-warnings scripts/djrust-golden.mjs check --skip-missing

test-djrust-neutral:
	@node --no-warnings scripts/djrust-neutral.mjs --skip-missing

test-djrust-cpu:
	@node --no-warnings scripts/djrust-cpu.mjs --check --skip-missing

djrust-ref:
	@node scripts/djrust-ref.mjs fetch

cid-freeze:
	@./scripts/cid-freeze.sh

# --- step-1 Node checks (no server, no browser; skip with a notice when there is no module) ---
#   test-scope-kernels   each Scope kernel the module Worker renders has the f32 sha of a Node loader render
#   test-insert-render   insert render (renderNotesOffline's project): two worklet renders give one WAV sha,
#                        equal to a Node loader render
#   test-wave-tick-feed  wave-tick feeds Auto-DJ / repeating one-shots once per tick; worker mutes yield
#                        to the engine's (no wasm needed)
#   test-crop            crop through the real worker + handleWsMessage + djwasm, swapped at the bar
test-djrust-node: test-scope-kernels test-insert-render test-wave-tick-feed test-crop test-djrust-page-macros \
                  test-djrust-page-instrument

test-scope-kernels:
	@node --no-warnings scripts/test-scope-kernels.mjs --skip-missing

test-insert-render:
	@node --no-warnings scripts/test-insert-render.mjs --skip-missing

test-wave-tick-feed:
	@node --no-warnings scripts/test-wave-tick-feed.mjs

test-crop:
	@node --no-warnings scripts/test-crop.mjs --skip-missing

# --- djwasm 0.3.0 candidate checks: DJRUST_WASM must be a djrust cabi/pkg directory ---
#   test-djwasm-030          keys table, new glue on 0.2.0 = golden, net macros direct = worklet,
#                            control dispatch, seek, groove, mechanism parity with beats' worker
#   test-djwasm-030-browser  the 0.3.0 scripts rendered four ways (Node direct / worklet / Offline / live)
#   test-djrust-newglue      scripts/test-djrust-wasm.mjs with the package's loader.js/worklet.js
test-djwasm-030:
	@node --no-warnings scripts/test-djwasm-030.mjs

test-djwasm-030-browser:
	@node --no-warnings scripts/test-djwasm-030-browser.mjs --port $(DJRUST_BROWSER_PORT) --cdp $(CDP_PORT)

test-djrust-newglue:
	@DJRUST_GLUE=$(DJRUST_WASM) node --import ./scripts/djrust-glue-hook.mjs scripts/test-djrust-wasm.mjs

# --- btw.bitwrap.io (btwsite/DESIGN.md) ---
#   btwsite-build   the server binary -> btwsite/bin/btwsite (gitignored)
#   btwsite-test    go vet + the btwsite packages under -race (BTWD_BIN=<btwd> adds the real-binary tests)
#   btwsite-run     serve on :18097 (fake model unless BTW_MODEL / GEMINI_API_KEY say otherwise); BTWD = the btwd executable
BTWD ?= $(CURDIR)/btwsite/bin/btwd
btwsite-build:
	@mkdir -p btwsite/bin
	go build -o btwsite/bin/btwsite ./cmd/btwsite

btwsite-test:
	go vet ./cmd/btwsite/ ./internal/btwsite/...
	go test -race -count=1 ./cmd/btwsite/ ./internal/btwsite/...

btwsite-run: btwsite-build
	BTW_MODEL=$${BTW_MODEL:-fake} btwsite/bin/btwsite -web btwsite/web -examples btwsite/examples -docs btwsite/web/docs -data $${BTW_DATA:-./data/btwsite} -btwd $(BTWD) -public-url $${BTW_PUBLIC_URL:-http://localhost:18097}

.PHONY: btwsite-build btwsite-test btwsite-run

