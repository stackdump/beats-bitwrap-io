package api

import (
	"net"
	"net/http"
	"net/netip"
	"strings"
)

// ClientIP is the address a request really came from, as every per-IP limit, log line and the
// compose / MCP callers must see it. The service runs behind nginx on the same host, so RemoteAddr is
// a loopback address in production and would put every visitor in one bucket.
//
//   - RemoteAddr is a loopback address (the reverse proxy): take X-Real-IP (nginx sets it from
//     $remote_addr), else the LAST entry of X-Forwarded-For (the one the proxy appended), else RemoteAddr.
//   - Any other RemoteAddr: those headers are ignored entirely, so a direct client cannot spoof them.
//
// The result is a bare IP ("203.0.113.9", "2001:db8::1"), never host:port. Unparseable header values
// are skipped.
func ClientIP(r *http.Request) string {
	remote := remoteIP(r.RemoteAddr)
	if !remote.IsValid() || !remote.IsLoopback() {
		if remote.IsValid() {
			return remote.String()
		}
		return strings.TrimSpace(r.RemoteAddr)
	}
	if v := strings.TrimSpace(r.Header.Get("X-Real-IP")); v != "" {
		if a, err := netip.ParseAddr(v); err == nil {
			return a.Unmap().String()
		}
	}
	if xff := r.Header.Values("X-Forwarded-For"); len(xff) > 0 {
		parts := strings.Split(strings.Join(xff, ","), ",")
		for i := len(parts) - 1; i >= 0; i-- {
			if v := strings.TrimSpace(parts[i]); v != "" {
				if a, err := netip.ParseAddr(v); err == nil {
					return a.Unmap().String()
				}
				break
			}
		}
	}
	return remote.String()
}

func remoteIP(addr string) netip.Addr {
	host := addr
	if h, _, err := net.SplitHostPort(addr); err == nil {
		host = h
	}
	host = strings.Trim(host, "[]")
	if i := strings.IndexByte(host, '%'); i >= 0 { // zone
		host = host[:i]
	}
	a, err := netip.ParseAddr(host)
	if err != nil {
		return netip.Addr{}
	}
	return a.Unmap()
}

// ResolveClientIP is a middleware: it replaces r.RemoteAddr with "<ClientIP>:0" and drops the proxy
// headers, so any handler (compose, MCP, cards) that reads r.RemoteAddr or calls ClientIP again sees the
// resolved client, and nothing downstream can be fooled by a header. Idempotent.
func ResolveClientIP(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := ClientIP(r)
		r2 := r.Clone(r.Context())
		r2.RemoteAddr = net.JoinHostPort(ip, "0")
		r2.Header.Del("X-Real-IP")
		r2.Header.Del("X-Forwarded-For")
		next.ServeHTTP(w, r2)
	})
}

// IPKey is the key a per-IP limiter should use: the address itself for IPv4, the /64 for IPv6 (a
// host there has billions of addresses, so the bare address would be no limit at all).
func IPKey(ip string) string {
	a, err := netip.ParseAddr(ip)
	if err != nil {
		return ip
	}
	a = a.Unmap()
	if a.Is6() {
		p, err := a.Prefix(64)
		if err == nil {
			return p.Masked().String()
		}
	}
	return a.String()
}
