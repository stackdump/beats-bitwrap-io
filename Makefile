BINARY := beats-bitwrap-io
ADDR   := :8089
VERSION := $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)

.PHONY: build run dev clean docs test-audio

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
