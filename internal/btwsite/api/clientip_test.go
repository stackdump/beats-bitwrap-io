package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func req(remote string, hdr map[string]string) *http.Request {
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = remote
	for k, v := range hdr {
		r.Header.Set(k, v)
	}
	return r
}

func TestClientIP(t *testing.T) {
	for _, c := range []struct {
		name   string
		remote string
		hdr    map[string]string
		want   string
	}{
		{"direct client, no headers", "203.0.113.9:5555", nil, "203.0.113.9"},
		{"direct client cannot spoof X-Real-IP", "203.0.113.9:5555", map[string]string{"X-Real-IP": "198.51.100.1"}, "203.0.113.9"},
		{"direct client cannot spoof X-Forwarded-For", "203.0.113.9:5555", map[string]string{"X-Forwarded-For": "198.51.100.1"}, "203.0.113.9"},
		{"private-range peer is not the proxy either", "10.0.0.5:1", map[string]string{"X-Real-IP": "198.51.100.1"}, "10.0.0.5"},
		{"loopback proxy: X-Real-IP", "127.0.0.1:5555", map[string]string{"X-Real-IP": "198.51.100.1"}, "198.51.100.1"},
		{"loopback proxy: X-Real-IP beats XFF", "127.0.0.1:5555", map[string]string{"X-Real-IP": "198.51.100.1", "X-Forwarded-For": "1.1.1.1, 2.2.2.2"}, "198.51.100.1"},
		{"loopback proxy: last XFF entry when no X-Real-IP", "127.0.0.1:5555", map[string]string{"X-Forwarded-For": "6.6.6.6, 198.51.100.2"}, "198.51.100.2"},
		{"loopback proxy: client-sent XFF prefix is not trusted", "127.0.0.1:5555", map[string]string{"X-Forwarded-For": "6.6.6.6,   198.51.100.3  "}, "198.51.100.3"},
		{"loopback proxy: junk X-Real-IP falls back to XFF", "127.0.0.1:5555", map[string]string{"X-Real-IP": "not-an-ip", "X-Forwarded-For": "198.51.100.4"}, "198.51.100.4"},
		{"loopback with no headers is the loopback", "127.0.0.1:5555", nil, "127.0.0.1"},
		{"IPv6 loopback proxy", "[::1]:5555", map[string]string{"X-Real-IP": "2001:db8::7"}, "2001:db8::7"},
		{"IPv4-mapped loopback", "[::ffff:127.0.0.1]:5555", map[string]string{"X-Real-IP": "198.51.100.5"}, "198.51.100.5"},
		{"IPv6 direct client", "[2001:db8::9]:5555", map[string]string{"X-Real-IP": "198.51.100.1"}, "2001:db8::9"},
		{"mapped X-Real-IP is unmapped", "127.0.0.1:1", map[string]string{"X-Real-IP": "::ffff:198.51.100.6"}, "198.51.100.6"},
		{"no port", "203.0.113.9", nil, "203.0.113.9"},
	} {
		if got := ClientIP(req(c.remote, c.hdr)); got != c.want {
			t.Errorf("%s: ClientIP = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestResolveClientIPMiddleware(t *testing.T) {
	var seen, seenHeader string
	h := ResolveClientIP(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.RemoteAddr
		seenHeader = r.Header.Get("X-Real-IP") + "|" + r.Header.Get("X-Forwarded-For")
		if got := ClientIP(r); got != "198.51.100.1" {
			t.Errorf("not idempotent: %q", got)
		}
	}))
	r := req("127.0.0.1:5555", map[string]string{"X-Real-IP": "198.51.100.1", "X-Forwarded-For": "9.9.9.9"})
	h.ServeHTTP(httptest.NewRecorder(), r)
	if seen != "198.51.100.1:0" || seenHeader != "|" {
		t.Fatalf("handler saw %q and headers %q", seen, seenHeader)
	}
	if r.RemoteAddr != "127.0.0.1:5555" || r.Header.Get("X-Real-IP") == "" {
		t.Fatal("the caller's request must not be modified")
	}
	// a spoofing direct client gets its own address
	h2 := ResolveClientIP(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { seen = r.RemoteAddr }))
	h2.ServeHTTP(httptest.NewRecorder(), req("203.0.113.9:1", map[string]string{"X-Real-IP": "198.51.100.1"}))
	if seen != "203.0.113.9:0" {
		t.Fatalf("spoof reached the handler: %q", seen)
	}
}

func TestIPKey(t *testing.T) {
	if IPKey("203.0.113.9") != "203.0.113.9" {
		t.Fatal("v4 is itself")
	}
	if a, b := IPKey("2001:db8:1:2::1"), IPKey("2001:db8:1:2:ffff::9"); a != b {
		t.Fatalf("one /64 is one bucket: %s %s", a, b)
	}
	if IPKey("2001:db8:1:2::1") == IPKey("2001:db8:1:3::1") {
		t.Fatal("different /64s are different buckets")
	}
	if IPKey("::ffff:203.0.113.9") != "203.0.113.9" {
		t.Fatal("mapped v4 is v4")
	}
	if IPKey("garbage") != "garbage" {
		t.Fatal("unparseable passes through")
	}
}
