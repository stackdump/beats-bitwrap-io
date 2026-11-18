package limits

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"beats-bitwrap-io/internal/btwsite/api"
)

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func newClock(s string) *clock {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return &clock{t: t}
}
func (c *clock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) Add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

func mustNew(t *testing.T, cfg Config, c *clock) *Limiter {
	t.Helper()
	l, err := New(cfg, c.Now)
	if err != nil {
		t.Fatal(err)
	}
	l.SetGetenv(func(string) string { return "" })
	t.Cleanup(func() { l.Close() })
	return l
}

func asAPI(t *testing.T, err error) *api.Error {
	t.Helper()
	var e *api.Error
	if !errors.As(err, &e) {
		t.Fatalf("want *api.Error, got %T %v", err, err)
	}
	return e
}

func TestUserHourAndDayWindows(t *testing.T) {
	c := newClock("2026-11-17T10:00:00Z")
	l := mustNew(t, Config{UserHour: 3, UserDay: 5, IPDay: 100}, c)
	for i := 0; i < 3; i++ {
		if err := l.Admit("u1", "203.0.113.1"); err != nil {
			t.Fatalf("admit %d: %v", i, err)
		}
		c.Add(time.Minute)
	}
	// 3 in the last hour: the 4th is refused, and Retry-After is when the first one leaves the window.
	err := l.Admit("u1", "203.0.113.1")
	e := asAPI(t, err)
	if e.Status != 429 || e.Code != api.CodeRateLimited {
		t.Fatalf("got %+v", e)
	}
	// first admission was at 10:00, now 10:03: it leaves at 11:00 -> 57 minutes.
	if e.RetryAfter != 57*60 {
		t.Fatalf("retry_after = %d, want %d", e.RetryAfter, 57*60)
	}
	// another user is unaffected
	if err := l.Admit("u2", "203.0.113.2"); err != nil {
		t.Fatal(err)
	}
	// advance past the hour: admitted again
	c.Add(58 * time.Minute)
	if err := l.Admit("u1", "203.0.113.1"); err != nil {
		t.Fatalf("after the window: %v", err)
	}
	// the day limit (5): 4 admitted so far for u1 within the day; one more is the 5th, the 6th is refused.
	c.Add(30 * time.Minute)
	if err := l.Admit("u1", "203.0.113.1"); err != nil {
		t.Fatalf("5th: %v", err)
	}
	c.Add(2 * time.Hour) // the hour window is empty, the day window is not
	e = asAPI(t, l.Admit("u1", "203.0.113.1"))
	if e.Code != api.CodeRateLimited || e.RetryAfter < 60 {
		t.Fatalf("day limit: %+v", e)
	}
	if !strings.Contains(e.Message, "daily") {
		t.Fatalf("message should say daily: %q", e.Message)
	}
	// the first admission was at 10:00 on the 17th: it leaves the 24h window at 10:00 on the 18th.
	if want := 24*3600 - int(c.Now().Sub(time.Date(2026, 11, 17, 10, 0, 0, 0, time.UTC))/time.Second); e.RetryAfter != want {
		t.Fatalf("retry_after = %d, want %d", e.RetryAfter, want)
	}
	c.Add(time.Duration(e.RetryAfter) * time.Second)
	if err := l.Admit("u1", "203.0.113.1"); err != nil {
		t.Fatalf("after Retry-After the request must pass: %v", err)
	}
}

func TestRefusedRequestCostsNoQuota(t *testing.T) {
	c := newClock("2026-11-17T10:00:00Z")
	l := mustNew(t, Config{UserHour: 100, UserDay: 100, IPDay: 2}, c)
	// the IP window refuses the third; the user's windows must not have been charged for it
	for i := 0; i < 2; i++ {
		if err := l.Admit("u1", "198.51.100.7"); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 10; i++ {
		_ = l.Admit("u1", "198.51.100.7")
	}
	l.mu.Lock()
	n := len(l.users["u1"])
	l.mu.Unlock()
	if n != 2 {
		t.Fatalf("user admissions = %d, want 2", n)
	}
}

func TestIPDayWindowAcrossUsersAndIPv6(t *testing.T) {
	c := newClock("2026-11-17T10:00:00Z")
	l := mustNew(t, Config{UserHour: 100, UserDay: 100, IPDay: 3}, c)
	for _, u := range []string{"a", "b", "c"} {
		if err := l.Admit(u, "203.0.113.9"); err != nil {
			t.Fatal(err)
		}
	}
	e := asAPI(t, l.Admit("d", "203.0.113.9"))
	if e.Status != 429 {
		t.Fatalf("%+v", e)
	}
	// a different address is fine
	if err := l.Admit("d", "203.0.113.10"); err != nil {
		t.Fatal(err)
	}
	// IPv6: every address in a /64 is one bucket
	for i, ip := range []string{"2001:db8:1:2::1", "2001:db8:1:2::2", "2001:db8:1:2:ffff::3"} {
		if err := l.Admit("v6user"+string(rune('a'+i)), ip); err != nil {
			t.Fatalf("%s: %v", ip, err)
		}
	}
	asAPI(t, l.Admit("v6userd", "2001:db8:1:2:abcd::4"))
	// an unknown address is not limited as a bucket of its own
	for i := 0; i < 5; i++ {
		if err := l.Admit("noip", ""); err != nil {
			t.Fatal(err)
		}
	}
}

func TestNegativeMeansUnlimited(t *testing.T) {
	c := newClock("2026-11-17T10:00:00Z")
	l := mustNew(t, Config{UserHour: -1, UserDay: -1, IPDay: -1, DailySpendUSD: -1}, c)
	for i := 0; i < 500; i++ {
		if err := l.Admit("u", "203.0.113.1"); err != nil {
			t.Fatal(err)
		}
	}
	r, err := l.Reserve(1e6)
	if err != nil {
		t.Fatal(err)
	}
	r.Release()
}

func TestSpendReserveSettleCapAndPersistence(t *testing.T) {
	dir := t.TempDir()
	c := newClock("2026-11-17T23:50:00Z")
	cfg := Config{DailySpendUSD: 1.00, PriceInPerM: 2, PriceOutPerM: 10, DataDir: dir}
	l := mustNew(t, cfg, c)

	if got := l.Cost(1_000_000, 100_000); got != 3.0 {
		t.Fatalf("cost = %v", got)
	}
	r1, err := l.Reserve(0.6)
	if err != nil {
		t.Fatal(err)
	}
	// a second reservation that would overshoot is refused while the first is in flight
	_, err = l.Reserve(0.5)
	e := asAPI(t, err)
	if e.Status != 503 || e.Code != api.CodeSpendCap {
		t.Fatalf("%+v", e)
	}
	if e.RetryAfter != 10*60 {
		t.Fatalf("retry_after = %d, want seconds to UTC midnight (600)", e.RetryAfter)
	}
	r1.Settle(0.30, 1000, 2000) // it only cost 0.30
	r1.Settle(9, 9, 9)          // settling twice changes nothing
	if got := l.Spent(); got < 0.2999 || got > 0.3001 {
		t.Fatalf("spent = %v", got)
	}
	r2, err := l.Reserve(0.5)
	if err != nil {
		t.Fatal(err)
	}
	r2.Settle(0.5, 10, 20)
	_, err = l.Reserve(0.3) // 0.8 + 0.3 > 1.0
	asAPI(t, err)

	// restart: a new Limiter over the same directory picks the spend up
	l.Close()
	l2 := mustNew(t, cfg, c)
	if got := l2.Spent(); got < 0.7999 || got > 0.8001 {
		t.Fatalf("spent after restart = %v", got)
	}
	_, err = l2.Reserve(0.3)
	asAPI(t, err)
	if _, err := os.Stat(filepath.Join(dir, "spend", "2026-11-17.json")); err != nil {
		t.Fatal(err)
	}

	// UTC midnight: the counter starts again, in a new file
	c.Add(11 * time.Minute)
	r3, err := l2.Reserve(0.3)
	if err != nil {
		t.Fatalf("after midnight: %v", err)
	}
	r3.Settle(0.01, 1, 1)
	if got := l2.Spent(); got < 0.0099 || got > 0.0101 {
		t.Fatalf("spent on the new day = %v", got)
	}
	if _, err := os.Stat(filepath.Join(dir, "spend", "2026-11-18.json")); err != nil {
		t.Fatal(err)
	}
	// yesterday's file is untouched
	var old DayRecord
	b, _ := os.ReadFile(filepath.Join(dir, "spend", "2026-11-17.json"))
	if err := json.Unmarshal(b, &old); err != nil || old.USD < 0.7999 {
		t.Fatalf("old day: %v %+v", err, old)
	}
	// no temp files are left behind by the atomic writes
	ents, _ := os.ReadDir(filepath.Join(dir, "spend"))
	for _, en := range ents {
		if strings.Contains(en.Name(), ".tmp-") {
			t.Fatalf("temp file left: %s", en.Name())
		}
	}
}

func TestReservationsCannotOvershootUnderConcurrency(t *testing.T) {
	c := newClock("2026-11-17T10:00:00Z")
	l := mustNew(t, Config{DailySpendUSD: 1.0}, c)
	var wg sync.WaitGroup
	var mu sync.Mutex
	granted := 0
	for i := 0; i < 64; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := l.Reserve(0.3); err == nil {
				mu.Lock()
				granted++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if granted != 3 {
		t.Fatalf("granted %d reservations of 0.3 against a cap of 1.0, want 3", granted)
	}
	if st := l.Stats(); st.ReservedUSD < 0.8999 || st.ReservedUSD > 0.9001 {
		t.Fatalf("reserved = %v", st.ReservedUSD)
	}
}

func TestCorruptSpendFileFailsClosed(t *testing.T) {
	dir := t.TempDir()
	c := newClock("2026-11-17T10:00:00Z")
	if err := os.MkdirAll(filepath.Join(dir, "spend"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "spend", "2026-11-17.json"), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := New(Config{DataDir: dir}, c.Now); err == nil || !strings.Contains(err.Error(), "unreadable") {
		t.Fatalf("a corrupt spend file must stop startup, got %v", err)
	}
}

func TestKillSwitchEnvFileAndSetEnabled(t *testing.T) {
	dir := t.TempDir()
	c := newClock("2026-11-17T10:00:00Z")
	l := mustNew(t, Config{DataDir: dir}, c)
	if k := l.Kill(); k.Disabled {
		t.Fatalf("%+v", k)
	}
	// the flag file, written by hand, is seen on the next request
	if err := os.WriteFile(filepath.Join(dir, FlagFile), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if k := l.Kill(); !k.Disabled || !k.File || k.Env {
		t.Fatalf("%+v", k)
	}
	if err := l.SetEnabled(true); err != nil {
		t.Fatal(err)
	}
	if k := l.Kill(); k.Disabled {
		t.Fatalf("%+v", k)
	}
	if err := l.SetEnabled(true); err != nil { // removing what is not there is fine
		t.Fatal(err)
	}
	if err := l.SetEnabled(false); err != nil {
		t.Fatal(err)
	}
	if k := l.Kill(); !k.Disabled || !k.File {
		t.Fatalf("%+v", k)
	}
	// survives a restart (it is a file)
	l2 := mustNew(t, Config{DataDir: dir}, c)
	if !l2.Kill().Disabled {
		t.Fatal("kill switch must survive a restart")
	}
	_ = l2.SetEnabled(true)
	// the environment
	for _, v := range []string{"0", "false", "OFF", " no "} {
		v := v
		l2.SetGetenv(func(k string) string {
			if k == EnvEnabled {
				return v
			}
			return ""
		})
		if k := l2.Kill(); !k.Disabled || !k.Env || k.File {
			t.Fatalf("%q: %+v", v, k)
		}
	}
	l2.SetGetenv(func(k string) string {
		if k == EnvEnabled {
			return "1"
		}
		return ""
	})
	if l2.Kill().Disabled {
		t.Fatal("BTW_COMPOSE_ENABLED=1 is not a kill")
	}
}

func TestKillSwitchInMemoryWithoutDataDir(t *testing.T) {
	c := newClock("2026-11-17T10:00:00Z")
	l := mustNew(t, Config{}, c)
	if err := l.SetEnabled(false); err != nil {
		t.Fatal(err)
	}
	if !l.Kill().Disabled {
		t.Fatal("not disabled")
	}
	_ = l.SetEnabled(true)
	if l.Kill().Disabled {
		t.Fatal("still disabled")
	}
}

func TestIPHashIsSaltedStableAndNeverTheIP(t *testing.T) {
	dir := t.TempDir()
	c := newClock("2026-11-17T10:00:00Z")
	l := mustNew(t, Config{DataDir: dir}, c)
	h := l.HashIP("203.0.113.77")
	if len(h) != 64 {
		t.Fatalf("hash = %q", h)
	}
	plain := sha256.Sum256([]byte("203.0.113.77"))
	if h == hex.EncodeToString(plain[:]) {
		t.Fatal("the hash must be salted")
	}
	if h != l.HashIP("203.0.113.77") || h == l.HashIP("203.0.113.78") {
		t.Fatal("hash not stable / not distinguishing")
	}
	// the same salt after a restart, so log lines stay comparable
	l2 := mustNew(t, Config{DataDir: dir}, c)
	if l2.HashIP("203.0.113.77") != h {
		t.Fatal("salt not persisted")
	}
	// another data dir, another salt
	l3 := mustNew(t, Config{DataDir: t.TempDir()}, c)
	if l3.HashIP("203.0.113.77") == h {
		t.Fatal("salts collide")
	}
	if l.HashIP("") != "" {
		t.Fatal("empty ip hashes to empty")
	}
	st, err := os.Stat(filepath.Join(dir, "ip-salt"))
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("salt file: %v %v", err, st)
	}
}

func TestPromptHash(t *testing.T) {
	long := strings.Repeat("dark techno é\n", 20)
	sum, head := PromptHash(long)
	if len(sum) != 64 {
		t.Fatal(sum)
	}
	if n := len([]rune(head)); n != 80 {
		t.Fatalf("head = %d runes", n)
	}
	if strings.ContainsAny(head, "\n\t\x00") {
		t.Fatalf("control chars in %q", head)
	}
	_, short := PromptHash("a\x00b")
	if short != "ab" {
		t.Fatalf("%q", short)
	}
}

func TestRecordWritesJSONLAndCountsOutcomes(t *testing.T) {
	dir := t.TempDir()
	c := newClock("2026-11-17T23:59:30Z")
	l := mustNew(t, Config{DataDir: dir}, c)
	sum, head := PromptHash("dark techno 128 with an acid line")
	l.Record(Entry{User: "eip155:0xabc", IPHash: l.HashIP("203.0.113.5"), PromptChars: 33, PromptSHA: sum, PromptHead: head,
		Model: "gemini-3.8-flash", TokensIn: 100, TokensOut: 200, CostUSD: 0.0017, Attempts: 2, Outcome: "ok", CID: "zTEST", MS: 1234})
	c.Add(time.Minute) // next UTC day: a new file
	l.Record(Entry{User: "ed25519:ff", Outcome: "rate_limited", Attempts: 0})
	l.Record(Entry{User: "ed25519:ff", Outcome: "rate_limited"})
	l.Close()

	f1 := filepath.Join(dir, "log", "compose-20261117.jsonl")
	f2 := filepath.Join(dir, "log", "compose-20261118.jsonl")
	b1, err := os.ReadFile(f1)
	if err != nil {
		t.Fatal(err)
	}
	var e Entry
	if err := json.Unmarshal([]byte(strings.TrimSpace(string(b1))), &e); err != nil {
		t.Fatal(err, string(b1))
	}
	if e.User != "eip155:0xabc" || e.Outcome != "ok" || e.TokensOut != 200 || e.CID != "zTEST" || e.PromptHead != head || e.TS == "" {
		t.Fatalf("%+v", e)
	}
	if strings.Contains(string(b1), "203.0.113.5") {
		t.Fatal("the raw IP is in the log")
	}
	sc := bufio.NewScanner(mustOpen(t, f2))
	n := 0
	for sc.Scan() {
		n++
	}
	if n != 2 {
		t.Fatalf("second day lines = %d", n)
	}
	st, _ := os.Stat(f1)
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("log mode %v", st.Mode())
	}

	// outcomes are counted per day, persisted, and read back after a restart
	l2 := mustNew(t, Config{DataDir: dir}, c)
	s := l2.Stats()
	if s.Date != "2026-11-18" || s.Requests != 2 || s.Outcomes["rate_limited"] != 2 {
		t.Fatalf("%+v", s)
	}
}

func mustOpen(t *testing.T, p string) *os.File {
	t.Helper()
	f, err := os.Open(p)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.Close() })
	return f
}

func TestSweepForgetsIdleKeys(t *testing.T) {
	c := newClock("2026-11-17T10:00:00Z")
	l := mustNew(t, Config{}, c)
	for i := 0; i < 20; i++ {
		_ = l.Admit("u"+string(rune('a'+i)), "203.0.113."+string(rune('1'+i%9)))
	}
	c.Add(25 * time.Hour)
	s := l.Stats()
	if s.UsersTracked != 0 || s.IPsTracked != 0 {
		t.Fatalf("%+v", s)
	}
}

func TestNoDataDirIsInMemory(t *testing.T) {
	c := newClock("2026-11-17T10:00:00Z")
	l := mustNew(t, Config{DailySpendUSD: 1}, c)
	r, err := l.Reserve(0.5)
	if err != nil {
		t.Fatal(err)
	}
	r.Settle(0.5, 1, 1)
	l.Record(Entry{Outcome: "ok"})
	if s := l.Stats(); s.SpentUSD != 0.5 || s.Requests != 1 {
		t.Fatalf("%+v", s)
	}
}
