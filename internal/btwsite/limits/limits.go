// Package limits is what stands between the compose endpoint and a surprise bill: per-user hourly
// and daily windows, a per-IP daily window, a global daily spend cap in USD (persisted, reset at UTC
// midnight), a kill switch (environment, flag file, admin endpoint) and the JSONL log of what was asked.
//
// Everything that touches time goes through the injected clock, so tests walk windows and days without
// sleeping. Nothing here ever sees the model API key.
//
// Zero Config values mean the defaults below; a negative value means "no limit" for that knob.
package limits

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"beats-bitwrap-io/internal/btwsite/api"
)

// Config is DESIGN.md "Package entry points". DataDir "" keeps everything in memory (no persistence, no log).
type Config struct {
	UserHour, UserDay, IPDay int
	DailySpendUSD            float64 // the day's cap; reservations count against it
	PriceInPerM              float64 // USD per million input tokens
	PriceOutPerM             float64 // USD per million output tokens (candidates + thinking)
	DataDir                  string  // spend/, log/, compose.off, ip-salt live here
}

// Defaults (also the flag defaults in DESIGN.md).
const (
	DefaultUserHour     = 10
	DefaultUserDay      = 50
	DefaultIPDay        = 40
	DefaultDailySpend   = 2.00
	DefaultPriceInPerM  = 1.50 // Google's list price for gemini-3.8-flash after 2026-12-31 (conservative before)
	DefaultPriceOutPerM = 7.50
)

// WithDefaults fills the zero values.
func (c Config) WithDefaults() Config {
	if c.UserHour == 0 {
		c.UserHour = DefaultUserHour
	}
	if c.UserDay == 0 {
		c.UserDay = DefaultUserDay
	}
	if c.IPDay == 0 {
		c.IPDay = DefaultIPDay
	}
	if c.DailySpendUSD == 0 {
		c.DailySpendUSD = DefaultDailySpend
	}
	if c.PriceInPerM == 0 {
		c.PriceInPerM = DefaultPriceInPerM
	}
	if c.PriceOutPerM == 0 {
		c.PriceOutPerM = DefaultPriceOutPerM
	}
	return c
}

// EnvEnabled is the environment kill switch: BTW_COMPOSE_ENABLED=0 (or false/off/no) turns compose off.
const EnvEnabled = "BTW_COMPOSE_ENABLED"

// FlagFile is the name, inside DataDir, of the kill-switch flag file. Its existence means "off".
const FlagFile = "compose.off"

// Limiter holds the windows, the day's spend and the log. Safe for concurrent use.
type Limiter struct {
	cfg    Config
	now    func() time.Time
	getenv func(string) string

	mu         sync.Mutex
	users      map[string][]time.Time // admission times, ascending, pruned to 24h
	ips        map[string][]time.Time
	calls      int
	day        string
	rec        DayRecord
	reserved   float64
	spendBroke string // non-empty: the day's spend file could not be trusted; fail closed
	persistErr string
	memOff     bool // kill switch when there is no DataDir
	salt       []byte
	logF       *os.File
	logDay     string
}

// New makes a Limiter. now nil = time.Now.
func New(cfg Config, now func() time.Time) (*Limiter, error) {
	if now == nil {
		now = time.Now
	}
	l := &Limiter{
		cfg: cfg.WithDefaults(), now: now, getenv: os.Getenv,
		users: map[string][]time.Time{}, ips: map[string][]time.Time{},
	}
	if l.cfg.DataDir != "" {
		for _, d := range []string{"", "spend", "log"} {
			if err := os.MkdirAll(filepath.Join(l.cfg.DataDir, d), 0o700); err != nil {
				return nil, fmt.Errorf("limits: %w", err)
			}
		}
	}
	salt, err := loadSalt(l.cfg.DataDir)
	if err != nil {
		return nil, err
	}
	l.salt = salt
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.rollLocked(true); err != nil {
		return nil, err
	}
	return l, nil
}

// SetGetenv replaces the environment lookup (tests).
func (l *Limiter) SetGetenv(f func(string) string) {
	l.mu.Lock()
	l.getenv = f
	l.mu.Unlock()
}

// Config is the effective configuration (defaults filled).
func (l *Limiter) Config() Config { return l.cfg }

// Cost is the USD price of a call with the given token counts (output = candidates + thinking).
func (l *Limiter) Cost(tokensIn, tokensOut int) float64 {
	return float64(tokensIn)*l.cfg.PriceInPerM/1e6 + float64(tokensOut)*l.cfg.PriceOutPerM/1e6
}

func loadSalt(dir string) ([]byte, error) {
	if dir != "" {
		if b, err := os.ReadFile(filepath.Join(dir, "ip-salt")); err == nil {
			if s, err := hex.DecodeString(strings.TrimSpace(string(b))); err == nil && len(s) >= 16 {
				return s, nil
			}
		}
	}
	s := make([]byte, 32)
	if _, err := rand.Read(s); err != nil {
		return nil, fmt.Errorf("limits: salt: %w", err)
	}
	if dir != "" {
		if err := writeAtomic(filepath.Join(dir, "ip-salt"), []byte(hex.EncodeToString(s)+"\n"), 0o600); err != nil {
			return nil, fmt.Errorf("limits: salt: %w", err)
		}
	}
	return s, nil
}

// HashIP is the salted SHA-256 of the address (the /64 for IPv6) that goes in the log: never the address.
func (l *Limiter) HashIP(ip string) string {
	if ip == "" {
		return ""
	}
	h := sha256.New()
	h.Write(l.salt)
	h.Write([]byte{0})
	h.Write([]byte(api.IPKey(ip)))
	return hex.EncodeToString(h.Sum(nil))
}

// ---------- kill switch ----------

// KillState says whether compose is switched off and by what.
type KillState struct {
	Disabled bool
	Env      bool // BTW_COMPOSE_ENABLED=0
	File     bool // <data>/compose.off exists (or the in-memory switch with no data dir)
}

func envOff(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "0", "false", "off", "no":
		return true
	}
	return false
}

// Kill checks the switch; call it on every request (the file and the environment are read each time).
func (l *Limiter) Kill() KillState {
	l.mu.Lock()
	getenv, mem := l.getenv, l.memOff
	l.mu.Unlock()
	k := KillState{Env: envOff(getenv(EnvEnabled))}
	if l.cfg.DataDir != "" {
		if _, err := os.Stat(filepath.Join(l.cfg.DataDir, FlagFile)); err == nil {
			k.File = true
		}
	} else {
		k.File = mem
	}
	k.Disabled = k.Env || k.File
	return k
}

// SetEnabled flips the flag-file switch (the environment switch can only be changed by whoever starts the
// process). enabled=false writes <data>/compose.off; enabled=true removes it.
func (l *Limiter) SetEnabled(enabled bool) error {
	if l.cfg.DataDir == "" {
		l.mu.Lock()
		l.memOff = !enabled
		l.mu.Unlock()
		return nil
	}
	p := filepath.Join(l.cfg.DataDir, FlagFile)
	if enabled {
		if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	return writeAtomic(p, []byte("compose switched off at "+l.now().UTC().Format(time.RFC3339)+"\n"), 0o600)
}

// ---------- windows ----------

// Admit records one compose request against the user's hour and day windows and the IP's day window,
// or refuses with a 429 and Retry-After. Nothing is recorded on refusal, so a refused request costs no quota.
func (l *Limiter) Admit(userID, ip string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.admitLocked(userID, ip, nil)
}

// Begin is Admit plus the spend cap in one step, in the order the contract fixes: user hour, user day,
// IP day, then the cap. The first model call's worst-case cost est is held against the cap; the caller
// settles it. A request refused by any of them is recorded nowhere and holds nothing, so being turned away
// by the cap does not use up the user's quota.
func (l *Limiter) Begin(userID, ip string, est float64) (*Reservation, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	var r *Reservation
	err := l.admitLocked(userID, ip, func() error {
		var e error
		r, e = l.reserveLocked(est)
		return e
	})
	if err != nil {
		return nil, err
	}
	return r, nil
}

// admitLocked checks the three windows, then runs last (the spend check) and, only when everything passed,
// records the admission.
func (l *Limiter) admitLocked(userID, ip string, last func() error) error {
	now := l.now()
	ipKey := ""
	if ip != "" {
		ipKey = l.HashIP(ip)
	}
	l.calls++
	if l.calls%256 == 0 {
		sweep(l.users, now)
		sweep(l.ips, now)
	}
	u := prune(l.users[userID], now)
	if wait, over := windowFull(u, now, time.Hour, l.cfg.UserHour); over {
		return rateLimited("hourly", l.cfg.UserHour, wait)
	}
	if wait, over := windowFull(u, now, 24*time.Hour, l.cfg.UserDay); over {
		return rateLimited("daily", l.cfg.UserDay, wait)
	}
	var p []time.Time
	if ipKey != "" {
		p = prune(l.ips[ipKey], now)
		if wait, over := windowFull(p, now, 24*time.Hour, l.cfg.IPDay); over {
			return rateLimited("per-address daily", l.cfg.IPDay, wait)
		}
	}
	if last != nil {
		if err := last(); err != nil {
			return err
		}
	}
	l.users[userID] = append(u, now)
	if ipKey != "" {
		l.ips[ipKey] = append(p, now)
	}
	return nil
}

func rateLimited(which string, n int, wait time.Duration) *api.Error {
	secs := int((wait + time.Second - 1) / time.Second)
	if secs < 1 {
		secs = 1
	}
	e := api.Errf(429, api.CodeRateLimited, "compose %s limit reached (%d); try again in %s", which, n, humanWait(secs))
	e.RetryAfter = secs
	return e
}

func humanWait(secs int) string {
	d := time.Duration(secs) * time.Second
	switch {
	case d >= 2*time.Hour:
		return fmt.Sprintf("about %d hours", int((d+30*time.Minute)/time.Hour))
	case d >= 2*time.Minute:
		return fmt.Sprintf("about %d minutes", int((d+30*time.Second)/time.Minute))
	}
	return fmt.Sprintf("%d seconds", secs)
}

// prune drops admissions older than 24h.
func prune(ts []time.Time, now time.Time) []time.Time {
	cut := now.Add(-24 * time.Hour)
	i := 0
	for i < len(ts) && !ts[i].After(cut) {
		i++
	}
	return ts[i:]
}

// windowFull: the window of length w holds limit events already? If so, how long until one expires.
func windowFull(ts []time.Time, now time.Time, w time.Duration, limit int) (time.Duration, bool) {
	if limit < 0 {
		return 0, false
	}
	cut := now.Add(-w)
	i := sort.Search(len(ts), func(i int) bool { return ts[i].After(cut) })
	in := ts[i:]
	if len(in) < limit {
		return 0, false
	}
	oldest := in[len(in)-limit] // the event that must leave the window before one more fits
	return oldest.Add(w).Sub(now), true
}

func sweep(m map[string][]time.Time, now time.Time) {
	for k, ts := range m {
		if ts = prune(ts, now); len(ts) == 0 {
			delete(m, k)
		} else {
			m[k] = ts
		}
	}
}

// ---------- spend ----------

// DayRecord is one UTC day's persisted counters (<data>/spend/YYYY-MM-DD.json).
type DayRecord struct {
	Date      string         `json:"date"`
	USD       float64        `json:"usd"`
	Requests  int            `json:"requests"`
	TokensIn  int            `json:"tokens_in"`
	TokensOut int            `json:"tokens_out"`
	Outcomes  map[string]int `json:"outcomes,omitempty"`
}

func dayOf(t time.Time) string { return t.UTC().Format("2006-01-02") }

func (l *Limiter) spendPath(day string) string {
	return filepath.Join(l.cfg.DataDir, "spend", day+".json")
}

// rollLocked makes the in-memory record the one for today (UTC), loading it from disk. A record that
// exists but cannot be read leaves the limiter closed (spend_cap) rather than counting from zero.
func (l *Limiter) rollLocked(first bool) error {
	day := dayOf(l.now())
	if !first && day == l.day {
		return nil
	}
	l.day = day
	l.rec = DayRecord{Date: day, Outcomes: map[string]int{}}
	l.spendBroke = ""
	if l.cfg.DataDir == "" {
		return nil
	}
	b, err := os.ReadFile(l.spendPath(day))
	if os.IsNotExist(err) {
		return nil
	}
	if err == nil {
		var r DayRecord
		if err = json.Unmarshal(b, &r); err == nil {
			if r.Outcomes == nil {
				r.Outcomes = map[string]int{}
			}
			r.Date = day
			l.rec = r
			return nil
		}
	}
	msg := fmt.Sprintf("the spend file %s is unreadable (%v); compose stays closed until it is fixed or removed", l.spendPath(day), err)
	l.spendBroke = msg
	if first {
		return fmt.Errorf("limits: %s", msg)
	}
	return nil
}

func (l *Limiter) persistLocked() {
	if l.cfg.DataDir == "" {
		return
	}
	b, _ := json.MarshalIndent(l.rec, "", " ")
	if err := writeAtomic(l.spendPath(l.day), append(b, '\n'), 0o600); err != nil {
		l.persistErr = err.Error()
		return
	}
	l.persistErr = ""
}

// Reservation is a worst-case cost held against the day's cap while a model call is in flight.
type Reservation struct {
	l    *Limiter
	est  float64
	done bool
}

// Reserve holds est USD against the cap, or refuses with 503 spend_cap. Settle (or Release) it when the
// call is over.
func (l *Limiter) Reserve(est float64) (*Reservation, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.reserveLocked(est)
}

func (l *Limiter) reserveLocked(est float64) (*Reservation, error) {
	_ = l.rollLocked(false)
	if l.spendBroke != "" {
		e := api.Errf(503, api.CodeSpendCap, "compose is closed: its spend record is unreadable")
		e.RetryAfter = 300
		return nil, e
	}
	if l.cfg.DailySpendUSD >= 0 && l.rec.USD+l.reserved+est > l.cfg.DailySpendUSD {
		e := api.Errf(503, api.CodeSpendCap, "today's compose budget is used up; it resets at 00:00 UTC")
		e.RetryAfter = l.secondsToResetLocked()
		return nil, e
	}
	l.reserved += est
	return &Reservation{l: l, est: est}, nil
}

// Settle replaces the reservation with the real cost and adds the tokens to the day's counters.
func (r *Reservation) Settle(costUSD float64, tokensIn, tokensOut int) {
	l := r.l
	l.mu.Lock()
	defer l.mu.Unlock()
	if r.done {
		return
	}
	r.done = true
	l.reserved -= r.est
	if l.reserved < 1e-12 {
		l.reserved = 0
	}
	_ = l.rollLocked(false)
	l.rec.USD += costUSD
	l.rec.TokensIn += tokensIn
	l.rec.TokensOut += tokensOut
	l.persistLocked()
}

// Release gives the reservation back with nothing spent.
func (r *Reservation) Release() { r.Settle(0, 0, 0) }

func (l *Limiter) secondsToResetLocked() int {
	now := l.now().UTC()
	next := time.Date(now.Year(), now.Month(), now.Day()+1, 0, 0, 0, 0, time.UTC)
	s := int((next.Sub(now) + time.Second - 1) / time.Second)
	if s < 1 {
		s = 1
	}
	return s
}

// SecondsToReset is how long until the spend counters reset (UTC midnight).
func (l *Limiter) SecondsToReset() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.secondsToResetLocked()
}

// Spent is today's recorded spend in USD (reservations in flight not included).
func (l *Limiter) Spent() float64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	_ = l.rollLocked(false)
	return l.rec.USD
}

// ---------- log ----------

// Entry is one line of -data/log/compose-YYYYMMDD.jsonl. It never holds the key, the prompt or the
// program: a hash and the first 80 characters of the prompt are all there is.
type Entry struct {
	TS          string  `json:"ts"`
	User        string  `json:"user"`
	IPHash      string  `json:"ip_hash"`
	PromptChars int     `json:"prompt_chars"`
	PromptSHA   string  `json:"prompt_sha256"`
	PromptHead  string  `json:"prompt_head"`
	Model       string  `json:"model"`
	TokensIn    int     `json:"tokens_in"`
	TokensOut   int     `json:"tokens_out"`
	CostUSD     float64 `json:"cost_usd"`
	Attempts    int     `json:"attempts"`
	Outcome     string  `json:"outcome"` // "ok" or an api error code
	CID         string  `json:"cid,omitempty"`
	ForkedFrom  string  `json:"forked_from,omitempty"`
	Detail      string  `json:"detail,omitempty"` // short, redacted reason (upstream status, never a body)
	MS          int64   `json:"ms"`
}

// PromptHash is the SHA-256 hex of the prompt, and its first 80 characters (one line, control characters
// dropped): the only trace of the prompt that is kept.
func PromptHash(prompt string) (sum, head string) {
	h := sha256.Sum256([]byte(prompt))
	var b strings.Builder
	n := 0
	for _, r := range prompt {
		if n >= 80 {
			break
		}
		if r == '\n' || r == '\t' {
			r = ' '
		}
		if r < 0x20 || r == 0x7f {
			continue
		}
		b.WriteRune(r)
		n++
	}
	return hex.EncodeToString(h[:]), b.String()
}

// Record counts the request in the day's outcome table and appends it to the day's log file. The caller
// must have redacted anything secret from Detail and PromptHead already.
func (l *Limiter) Record(e Entry) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now().UTC()
	if e.TS == "" {
		e.TS = now.Format(time.RFC3339Nano)
	}
	_ = l.rollLocked(false)
	l.rec.Requests++
	if e.Outcome != "" {
		l.rec.Outcomes[e.Outcome]++
	}
	l.persistLocked()
	if l.cfg.DataDir == "" {
		return
	}
	day := now.Format("20060102")
	if l.logF == nil || l.logDay != day {
		if l.logF != nil {
			_ = l.logF.Close()
			l.logF = nil
		}
		f, err := os.OpenFile(filepath.Join(l.cfg.DataDir, "log", "compose-"+day+".jsonl"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if err != nil {
			l.persistErr = err.Error()
			return
		}
		l.logF, l.logDay = f, day
	}
	b, err := json.Marshal(e)
	if err != nil {
		return
	}
	if _, err := l.logF.Write(append(b, '\n')); err != nil {
		l.persistErr = err.Error()
	}
}

// Close closes the log file.
func (l *Limiter) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.logF != nil {
		err := l.logF.Close()
		l.logF = nil
		return err
	}
	return nil
}

// ---------- stats ----------

// Stats is what GET /api/admin/stats reports about the limiter.
type Stats struct {
	Date         string         `json:"date"`
	SpentUSD     float64        `json:"spent_usd"`
	ReservedUSD  float64        `json:"reserved_usd"`
	CapUSD       float64        `json:"cap_usd"`
	Requests     int            `json:"requests"`
	TokensIn     int            `json:"tokens_in"`
	TokensOut    int            `json:"tokens_out"`
	Outcomes     map[string]int `json:"outcomes"`
	UsersTracked int            `json:"users_tracked"`
	IPsTracked   int            `json:"ips_tracked"`
	ResetInSecs  int            `json:"reset_in_seconds"`
	UserHour     int            `json:"user_per_hour"`
	UserDay      int            `json:"user_per_day"`
	IPDay        int            `json:"ip_per_day"`
	SpendClosed  string         `json:"spend_closed,omitempty"`
	PersistError string         `json:"persist_error,omitempty"`
}

// Stats is a snapshot of today's counters.
func (l *Limiter) Stats() Stats {
	l.mu.Lock()
	defer l.mu.Unlock()
	_ = l.rollLocked(false)
	now := l.now()
	sweep(l.users, now)
	sweep(l.ips, now)
	out := make(map[string]int, len(l.rec.Outcomes))
	for k, v := range l.rec.Outcomes {
		out[k] = v
	}
	return Stats{
		Date: l.day, SpentUSD: l.rec.USD, ReservedUSD: l.reserved, CapUSD: l.cfg.DailySpendUSD,
		Requests: l.rec.Requests, TokensIn: l.rec.TokensIn, TokensOut: l.rec.TokensOut, Outcomes: out,
		UsersTracked: len(l.users), IPsTracked: len(l.ips), ResetInSecs: l.secondsToResetLocked(),
		UserHour: l.cfg.UserHour, UserDay: l.cfg.UserDay, IPDay: l.cfg.IPDay,
		SpendClosed: l.spendBroke, PersistError: l.persistErr,
	}
}

// writeAtomic writes b to path through a temp file in the same directory and a rename, so a crash leaves
// the old file or the new one, never half of one.
func writeAtomic(path string, b []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	f, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	ok := false
	defer func() {
		if !ok {
			_ = f.Close()
			_ = os.Remove(tmp)
		}
	}()
	if _, err := f.Write(b); err != nil {
		return err
	}
	if err := f.Chmod(perm); err != nil {
		return err
	}
	if err := f.Sync(); err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	ok = true
	return nil
}
