// Package audioengine names the audio engine version the feed's audio is rendered with.
//
// Audio is a function of (share CID, engine version): djrust renders one share the same way
// for one engine version, and moving beats' pin (public/djrust/version.js, DJRUST_VERSION) is
// the only way rendered audio changes. /audio/{cid}.webm is served immutable, so every audio
// URL the site hands a listener carries the version (?v=djrust-<version>): a render made by a
// newer engine lands at a URL no browser or podcast client has cached.
package audioengine

import (
	"regexp"
	"sync"
)

var (
	mu  sync.RWMutex
	tag = "djrust"
)

var versionRe = regexp.MustCompile(`DJRUST_VERSION\s*=\s*['"]([0-9A-Za-z.+-]+)['"]`)

// SetFromVersionJS takes the engine version from public/djrust/version.js. It reports false
// (and leaves the tag) when the file has no DJRUST_VERSION.
func SetFromVersionJS(src []byte) bool {
	m := versionRe.FindSubmatch(src)
	if m == nil {
		return false
	}
	mu.Lock()
	tag = "djrust-" + string(m[1])
	mu.Unlock()
	return true
}

// Tag is the engine and version, e.g. "djrust-0.2.0".
func Tag() string {
	mu.RLock()
	defer mu.RUnlock()
	return tag
}

// Query is the query string audio URLs carry: "?v=djrust-0.2.0".
func Query() string { return "?v=" + Tag() }
