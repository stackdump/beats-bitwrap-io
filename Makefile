BINARY := beats-bitwrap-io
ADDR   := :8089

.PHONY: build run dev clean

build:
	go build -o $(BINARY) .

run: build
	./$(BINARY) -addr $(ADDR)

dev:
	go run . -addr $(ADDR) -public public

clean:
	rm -f $(BINARY)
