// Command btwsite is the btw.bitwrap.io server: one binary, flags and BTW_* environment variables
// (see internal/btwsite/server.ParseConfig), the Rust btwd beside it. btwsite/DESIGN.md has the whole design.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"beats-bitwrap-io/internal/btwsite/server"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	err := run(ctx, os.Args[1:], os.Getenv, os.Stderr, nil)
	switch {
	case err == nil, errors.Is(err, flag.ErrHelp):
	case errors.Is(err, errUsage):
		fmt.Fprintln(os.Stderr, "btwsite:", err)
		os.Exit(2)
	default:
		log.Fatalf("btwsite: %v", err)
	}
}

var errUsage = errors.New("usage")

// run serves until ctx ends, then shuts down gracefully. ready (optional) is told the bound address.
func run(ctx context.Context, args []string, getenv func(string) string, stderr io.Writer, ready func(net.Addr)) error {
	cfg, err := server.ParseConfig(args, getenv, stderr)
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return err
		}
		return fmt.Errorf("%w: %v", errUsage, err)
	}
	srv, err := server.New(cfg)
	if err != nil {
		return err
	}
	for _, w := range srv.Warnings() {
		log.Printf("btwsite: warning: %s", w)
	}
	ln, err := net.Listen("tcp", cfg.Addr)
	if err != nil {
		srv.Close()
		return err
	}
	hs := &http.Server{
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		// No ReadTimeout and no WriteTimeout, on purpose: net/http's read deadline stays on the connection
		// while a handler runs and cancels the request context when it passes, which would cut an SSE stream
		// or a render stream at that mark. Bodies are small and capped (MaxBytesReader) and nginx buffers
		// them before they get here; streams set a write deadline per chunk instead.
		IdleTimeout:    120 * time.Second,
		MaxHeaderBytes: 32 << 10,
	}
	errc := make(chan error, 1)
	go func() { errc <- hs.Serve(ln) }()
	log.Printf("btwsite: listening on %s (public %s, data %s, web %s)", ln.Addr(), cfg.PublicURL, cfg.DataDir, cfg.WebDir)
	if ready != nil {
		ready(ln.Addr())
	}

	select {
	case err := <-errc:
		srv.Close()
		return err
	case <-ctx.Done():
	}
	log.Printf("btwsite: shutting down")
	srv.Close() // ends the SSE and render streams, so Shutdown does not wait on them
	sctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := hs.Shutdown(sctx); err != nil {
		log.Printf("btwsite: shutdown: %v", err)
		_ = hs.Close()
	}
	return nil
}
