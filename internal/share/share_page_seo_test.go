package share

import (
	"bytes"
	"testing"
)

func TestStripDefaultSEORemovesOnlyTheMarkedBlock(t *testing.T) {
	doc := []byte("<head><title>x</title>\n<!-- default seo -->\n<meta name=\"description\" content=\"d\"/>\n<!-- /default seo -->\n<link rel=\"stylesheet\" href=\"a.css\"/></head>")
	got := stripDefaultSEO(doc)
	if bytes.Contains(got, []byte("description")) || !bytes.Contains(got, []byte("a.css")) || !bytes.Contains(got, []byte("<title>x</title>")) {
		t.Fatalf("got %q", got)
	}
	if plain := []byte("<head></head>"); !bytes.Equal(stripDefaultSEO(plain), plain) {
		t.Fatal("unmarked document must be untouched")
	}
}
