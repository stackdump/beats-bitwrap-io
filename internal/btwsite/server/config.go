// Package server is btw.bitwrap.io's HTTP service: static files, the check/fmt/share/open API, the
// programs store, wallet auth, the browser<->MCP sessions hub, the streaming render route, and the wiring of
// the compose, MCP, docs and card packages. See btwsite/DESIGN.md.
package server

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"

	"beats-bitwrap-io/internal/btwsite/api"
	"beats-bitwrap-io/internal/btwsite/btwd"
)

// Config is everything the server is told. ParseConfig fills it from flags and BTW_* environment
// variables; DefaultConfig documents the defaults. The fields after "test seams" are not flags.
type Config struct {
	Addr        string // -addr
	WebDir      string // -web
	ExamplesDir string // -examples
	DocsDir     string // -docs
	DataDir     string // -data
	BtwdBin     string // -btwd
	FFmpeg      string // -ffmpeg
	PublicURL   string // -public-url
	// LegacyHosts are earlier public hosts (comma-separated, e.g. "btw.bitwrap.io" after the move to beatscript.app):
	// a phone paired under one of them signs that host into its requests, and those signatures stay good.
	LegacyHosts string // -legacy-hosts

	Model    string // -model ("fake" = the recorded-fixture model)
	Thinking string // -thinking: Gemini thinking level MINIMAL|LOW|MEDIUM|HIGH ("" = LOW)

	ComposeUserHour int     // -compose-user-hour
	ComposeUserDay  int     // -compose-user-day
	ComposeIPDay    int     // -compose-ip-day
	DailySpendUSD   float64 // -daily-spend-usd
	PriceInPerM     float64 // -price-in-per-m
	PriceOutPerM    float64 // -price-out-per-m
	MaxPromptChars  int     // -max-prompt-chars
	MaxProgramBytes int     // -max-program-bytes
	MaxRepair       int     // -max-repair
	ComposeEnabled  bool    // -compose-enabled / BTW_COMPOSE_ENABLED=0|1: the kill switch's initial position

	RenderIPHour      int // -render-ip-hour
	RenderConcurrency int // -render-concurrency
	RenderMaxBars     int // -render-max-bars
	RenderMaxSeconds  int // -render-max-seconds: longest render in audio seconds (256 bars at 40 BPM would be 25 minutes)
	RenderCacheMB     int // -render-cache-mb: size cap of -data/render, LRU eviction
	PutIPHour         int // -put-ip-hour: PUT /api/programs per IP
	ShareHour         int // -share-hour: PUT /api/shares per signed-in account (an address is also held to -put-ip-hour)
	CheckIPMin        int // -check-ip-min: check/fmt/share/open per IP
	StoreMaxMB        int // -store-max-mb: size cap of -data/programs
	Version           string

	// From the environment only, never a flag (a flag shows up in `ps`):
	GeminiKey     string // GEMINI_API_KEY
	AdminToken    string // BTW_ADMIN_TOKEN
	SessionSecret string // BTW_SESSION_SECRET (else generated into -data)

	// ---- test seams (not flags) ----
	Checker       api.Checker          // replaces the btwd subprocess
	Renderer      btwd.Renderer        // replaces it for renders
	Authenticator api.Authenticator    // replaces the wallet auth service (tests only)
	Now           func() time.Time     // clock
	SSEPing       time.Duration        // keep-alive interval of the sessions SSE stream (default 20s)
	BtwdOptions   btwd.Options         // passed to btwd.New
	Logf          func(string, ...any) // diagnostics; default log.Printf
}

// DefaultConfig is what an empty command line gives.
func DefaultConfig() Config {
	return Config{
		Addr: ":18097", WebDir: "btwsite/web", ExamplesDir: "btwsite/examples", DocsDir: "btwsite/web/docs", DataDir: "./data",
		PublicURL: "https://btw.bitwrap.io", Model: "gemini-3.8-flash", FFmpeg: "ffmpeg",
		ComposeUserHour: 10, ComposeUserDay: 50, ComposeIPDay: 40, DailySpendUSD: 2.00, PriceInPerM: 1.50, PriceOutPerM: 7.50,
		MaxPromptChars: 800, MaxProgramBytes: 16384, MaxRepair: 3, ComposeEnabled: true,
		RenderIPHour: 30, RenderConcurrency: 2, RenderMaxBars: 256, RenderMaxSeconds: 600, RenderCacheMB: 512,
		PutIPHour: 60, ShareHour: 60, CheckIPMin: 120, StoreMaxMB: 256,
	}
}

// ParseConfig reads args (without the program name) and env. Each flag also has an env var BTW_<NAME>
// (dashes become underscores: -render-ip-hour is BTW_RENDER_IP_HOUR); the environment applies only to a flag
// that was not given on the command line.
func ParseConfig(args []string, getenv func(string) string, out io.Writer) (Config, error) {
	if getenv == nil {
		getenv = os.Getenv
	}
	if out == nil {
		out = io.Discard
	}
	c := DefaultConfig()
	fs := flag.NewFlagSet("btwsite", flag.ContinueOnError)
	fs.SetOutput(out)
	str := func(p *string, name, usage string) { fs.StringVar(p, name, *p, usage+" [env "+envName(name)+"]") }
	num := func(p *int, name, usage string) { fs.IntVar(p, name, *p, usage+" [env "+envName(name)+"]") }
	flt := func(p *float64, name, usage string) { fs.Float64Var(p, name, *p, usage+" [env "+envName(name)+"]") }

	str(&c.Addr, "addr", "listen address")
	str(&c.WebDir, "web", "directory of the static site")
	str(&c.ExamplesDir, "examples", "directory of the public example programs (*.btw + index.json)")
	str(&c.DocsDir, "docs", "directory of the docs served at /docs and /llms.txt")
	str(&c.DataDir, "data", "data directory: programs/, render/, log/, tokens.json, session.secret")
	str(&c.BtwdBin, "btwd", "path of the btwd executable (the Rust checker and renderer)")
	str(&c.FFmpeg, "ffmpeg", "ffmpeg executable for Ogg Opus renders (needs libopus)")
	str(&c.PublicURL, "public-url", "the site's public origin, for share links and cookies (https => Secure cookie)")
	str(&c.LegacyHosts, "legacy-hosts", "earlier public hosts, comma-separated: phones paired under them keep working")
	str(&c.Model, "model", "compose model name; \"fake\" selects the recorded fixture model")
	str(&c.Thinking, "thinking", "Gemini thinking level: MINIMAL, LOW, MEDIUM or HIGH (empty = LOW)")
	num(&c.ComposeUserHour, "compose-user-hour", "compose requests per signed-in user per hour")
	num(&c.ComposeUserDay, "compose-user-day", "compose requests per signed-in user per day")
	num(&c.ComposeIPDay, "compose-ip-day", "compose requests per IP per day")
	flt(&c.DailySpendUSD, "daily-spend-usd", "global model spend cap per day, USD")
	flt(&c.PriceInPerM, "price-in-per-m", "model price per million input tokens, USD")
	flt(&c.PriceOutPerM, "price-out-per-m", "model price per million output tokens, USD")
	num(&c.MaxPromptChars, "max-prompt-chars", "longest compose prompt")
	num(&c.MaxProgramBytes, "max-program-bytes", "largest program stored or composed")
	num(&c.MaxRepair, "max-repair", "compose repair rounds after the first attempt")
	fs.BoolVar(&c.ComposeEnabled, "compose-enabled", c.ComposeEnabled, "compose kill switch's initial position [env BTW_COMPOSE_ENABLED=0|1]")
	num(&c.RenderIPHour, "render-ip-hour", "uncached renders per IP per hour")
	num(&c.RenderConcurrency, "render-concurrency", "simultaneous btwd render processes")
	num(&c.RenderMaxBars, "render-max-bars", "longest render, in bars")
	num(&c.RenderMaxSeconds, "render-max-seconds", "longest render, in seconds of audio")
	num(&c.RenderCacheMB, "render-cache-mb", "size cap of the render cache, MB (LRU eviction)")
	num(&c.PutIPHour, "put-ip-hour", "program uploads (PUT /api/programs) per IP per hour")
	num(&c.ShareHour, "share-hour", "CID-only share writes (PUT /api/shares) per signed-in account per hour")
	num(&c.CheckIPMin, "check-ip-min", "check/fmt/share/open requests per IP per minute")
	num(&c.StoreMaxMB, "store-max-mb", "size cap of the programs store, MB")

	if err := fs.Parse(args); err != nil {
		return c, err
	}
	set := map[string]bool{}
	fs.Visit(func(f *flag.Flag) { set[f.Name] = true })
	var perr error
	fs.VisitAll(func(f *flag.Flag) {
		if set[f.Name] {
			return
		}
		v := strings.TrimSpace(getenv(envName(f.Name)))
		if v == "" {
			return
		}
		if f.Name == "compose-enabled" {
			b, err := parseBool01(v)
			if err != nil {
				perr = fmt.Errorf("%s: %v", envName(f.Name), err)
				return
			}
			c.ComposeEnabled = b
			return
		}
		if err := f.Value.Set(v); err != nil {
			perr = fmt.Errorf("%s=%q: %v", envName(f.Name), v, err)
		}
	})
	if perr != nil {
		return c, perr
	}
	c.GeminiKey = strings.TrimSpace(getenv("GEMINI_API_KEY"))
	c.AdminToken = strings.TrimSpace(getenv("BTW_ADMIN_TOKEN"))
	c.SessionSecret = strings.TrimSpace(getenv("BTW_SESSION_SECRET"))
	return c, c.validate()
}

func envName(flagName string) string {
	return "BTW_" + strings.ToUpper(strings.ReplaceAll(flagName, "-", "_"))
}

func parseBool01(v string) (bool, error) {
	switch strings.ToLower(v) {
	case "1", "true", "yes", "on":
		return true, nil
	case "0", "false", "no", "off":
		return false, nil
	}
	if _, err := strconv.ParseBool(v); err == nil {
		b, _ := strconv.ParseBool(v)
		return b, nil
	}
	return false, errors.New("want 0 or 1")
}

func (c *Config) validate() error {
	if c.DataDir == "" {
		return errors.New("-data must not be empty")
	}
	if c.RenderConcurrency < 1 {
		return errors.New("-render-concurrency must be at least 1")
	}
	if c.MaxProgramBytes < 256 {
		return errors.New("-max-program-bytes is too small")
	}
	if c.RenderMaxBars < 1 {
		return errors.New("-render-max-bars must be at least 1")
	}
	if c.RenderMaxSeconds < 10 {
		return errors.New("-render-max-seconds must be at least 10")
	}
	c.PublicURL = strings.TrimRight(c.PublicURL, "/")
	if c.PublicURL == "" {
		return errors.New("-public-url must not be empty")
	}
	return nil
}

// secureCookie: the cookie is Secure exactly when the public origin is https.
func (c *Config) secureCookie() bool { return strings.HasPrefix(c.PublicURL, "https://") }
