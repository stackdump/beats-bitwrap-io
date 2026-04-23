BINARY := beats-bitwrap-io
ADDR   := :8089
VERSION := $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)

.PHONY: build run dev clean docs

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
