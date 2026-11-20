package mcpsrv_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"beats-bitwrap-io/internal/btwsite/api"
	"beats-bitwrap-io/internal/btwsite/mcpsrv"
)

// manyUsers is an authenticator in which any "btw_uN" token is its own user: identities are free (any
// key signs in and mints tokens), so that is what an attacker with one machine has.
type manyUsers struct{}

func (manyUsers) UserFrom(r *http.Request) (*api.User, error) { return nil, nil }
func (manyUsers) UserFromToken(tok string) *api.User {
	if len(tok) > 5 && tok[:5] == "btw_u" {
		return &api.User{ID: "ed25519:" + tok, Kind: "ed25519", Address: tok, Via: "token"}
	}
	return nil
}

// A per-user allowance alone is no limit on one machine that can make users at will: the checker (a btwd
// process per call) and the programs store must also be bounded per address. Signed-in callers get an
// allowance of their own and, over all of them from one address, a few times that.
func TestSignedInLimitsAreAlsoBoundedPerAddress(t *testing.T) {
	now := time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)
	b := newBackend()
	h := mcpsrv.Handler(b, manyUsers{}, siteURL, mcpsrv.WithCheckPerMin(3), mcpsrv.WithRenderPerHour(2), mcpsrv.WithNow(func() time.Time { return now }))
	mux := http.NewServeMux()
	mux.Handle("/mcp", h)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	e := &env{t: t, b: b, srv: srv}
	from := map[string]string{"X-Real-IP": "203.0.113.9"}
	call := func(token, tool string, args map[string]any) result {
		m := e.rpc(token, "tools/call", map[string]any{"name": tool, "arguments": args}, from)
		return decodeResult(t, m)
	}

	ok := 0
	for i := 0; i < 40; i++ {
		if r := call(fmt.Sprintf("btw_u%d", i), "check", map[string]any{"text": goodProgram}); !r.IsError {
			ok++
		} else if c := r.errBody(t)["code"]; c != "rate_limited" {
			t.Fatalf("user %d: %s", i, r.Text)
		}
	}
	if ok > 4*3 {
		t.Fatalf("%d checks from one address in a minute; each user may make 3, and one address 12", ok)
	}
	if ok < 4*3 {
		t.Fatalf("only %d checks passed; the per-address ceiling is too tight for honest users", ok)
	}
	// another address is another allowance; the same user from it is limited by their own
	if r := e.rpc("btw_u0", "tools/call", map[string]any{"name": "check", "arguments": map[string]any{"text": goodProgram}}, map[string]string{"X-Real-IP": "203.0.113.10"}); decodeResult(t, r).IsError {
		t.Error("a user with budget left was refused on a quiet address")
	}

	// the programs store: 2 an hour each, 8 from one address
	okR := 0
	for i := 0; i < 40; i++ {
		prog := fmt.Sprintf("tempo %d\ndeck A: kick x\n", 60+i)
		if r := call(fmt.Sprintf("btw_u%d", 100+i), "render", map[string]any{"text": prog}); !r.IsError {
			okR++
		}
	}
	if okR > 4*2 {
		t.Fatalf("%d programs stored through render from one address in an hour; limit 8", okR)
	}
}

func decodeResult(t *testing.T, m rpcMsg) result {
	t.Helper()
	if m.Error != nil {
		t.Fatalf("protocol error %d %s", m.Error.Code, m.Error.Message)
	}
	var res struct {
		IsError bool `json:"isError"`
		Content []struct {
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(m.Result, &res); err != nil {
		t.Fatal(err)
	}
	var s string
	for _, c := range res.Content {
		s += c.Text
	}
	return result{res.IsError, s}
}

// An error that is not the site's own typed error is the server's business: a store or subprocess failure's
// words (a data path, a syscall) are not for the caller of a tool, anonymous ones included.
func TestUntypedBackendErrorsAreNotEchoed(t *testing.T) {
	e := newEnv(t)
	e.b.pushErr = errors.New("open /srv/btw/data/programs/.tmp-123: permission denied")
	r := e.call("btw_alice", "eval", map[string]any{"text": goodProgram})
	em := r.errBody(t)
	if em["code"] != "internal" || strings.Contains(r.Text, "/srv/btw") || strings.Contains(r.Text, "permission") {
		t.Fatalf("the caller was told: %s", r.Text)
	}
}
