// Command btwsite is the btw.bitwrap.io server: one binary, flags and BTW_* environment variables
// (see internal/btwsite/server.ParseConfig), the Rust btwd beside it. btwsite/DESIGN.md has the whole design.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
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
	cfg, err := server.ParseConfig(os.Args[1:], os.Getenv, os.Stderr)
	if errors.Is(err, flag.ErrHelp) {
		os.Exit(0)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "btwsite:", err)
		os.Exit(2)
	}
	srv, err := server.New(cfg)
	if err != nil {
		log.Fatalf("btwsite: %v", err)
	}
	for _, w := range srv.Warnings() {
		log.Printf("btwsite: warning: %s", w)
	}
	ln, err := net.Listen("tcp", cfg.Addr)
	if err != nil {
		log.Fatalf("btwsite: %v", err)
	}
	hs := &http.Server{
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second, // bodies are small; streams set their own write deadlines
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    32 << 10,
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	errc := make(chan error, 1)
	go func() { errc <- hs.Serve(ln) }()
	log.Printf("btwsite: listening on %s (public %s, data %s, web %s)", ln.Addr(), cfg.PublicURL, cfg.DataDir, cfg.WebDir)

	select {
	case err := <-errc:
		log.Fatalf("btwsite: %v", err)
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
}
