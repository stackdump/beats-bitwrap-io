package audioengine

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestSetFromVersionJS(t *testing.T) {
	if !SetFromVersionJS([]byte("export const DJRUST_VERSION = '1.2.3';\n")) {
		t.Fatal("no version read")
	}
	if Tag() != "djrust-1.2.3" || Query() != "?v=djrust-1.2.3" {
		t.Fatalf("tag %q query %q", Tag(), Query())
	}
	if SetFromVersionJS([]byte("// nothing here")) || Tag() != "djrust-1.2.3" {
		t.Fatalf("a file without a version changed the tag to %q", Tag())
	}
}

// The pin beats ships is readable: the server takes its tag from this file at startup.
func TestTheShippedPinIsReadable(t *testing.T) {
	_, here, _, _ := runtime.Caller(0)
	src, err := os.ReadFile(filepath.Join(filepath.Dir(here), "..", "..", "public", "djrust", "version.js"))
	if err != nil {
		t.Skip("public/djrust/version.js not in this test's tree:", err)
	}
	if !SetFromVersionJS(src) {
		t.Fatal("public/djrust/version.js has no DJRUST_VERSION the server can read")
	}
}
