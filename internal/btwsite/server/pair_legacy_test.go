package server

import (
	"testing"
)

// After the site moves (public URL https://new.test), a phone that signs the old host keeps working while the old
// host is listed in LegacyHosts, and is refused when it is not.
func TestPairLegacyHost(t *testing.T) {
	for _, tc := range []struct {
		legacy string
		want   int
	}{{"btw.test", 200}, {"", 401}} {
		e := newEnv(t, func(c *Config) { c.PublicURL = "https://new.test"; c.LegacyHosts = tc.legacy })
		u := e.newUser()
		p := newPhone(21)
		var o offer
		if st := decode(t, e.post("/api/pair", nil, cookie(u.cookie), hdr("Origin", "https://new.test")), &o); st != 200 {
			t.Fatalf("offer: %d", st)
		}
		// the phone signs "btw.test" (claimBody's host): the old name
		var hello map[string]any
		st := decode(t, e.claim(p, o), &hello)
		if st != tc.want {
			t.Fatalf("legacy %q: claim %d, want %d (%v)", tc.legacy, st, tc.want, hello)
		}
		if st != 200 {
			continue
		}
		p.device = hello["device_id"].(string)
		// signed requests naming the old host are good too
		if code := decode(t, e.signed(p, "GET", "/api/device", nil), nil); code != 200 {
			t.Fatalf("signed request under the legacy host: %d", code)
		}
	}
}
