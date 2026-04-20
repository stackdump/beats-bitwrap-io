BINARY := beats-bitwrap-io
ADDR   := :8089
VERSION := $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)

.PHONY: build run dev clean

build:
	go build -ldflags "-X main.version=$(VERSION)" -o $(BINARY) .

run: build
	./$(BINARY) -addr $(ADDR)

dev:
	go run -ldflags "-X main.version=$(VERSION)" . -addr $(ADDR) -public public

clean:
	rm -f $(BINARY)
