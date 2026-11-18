package ld

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestContextRoutes(t *testing.T) {
	mux := http.NewServeMux()
	Mount(mux)
	for path, cache := range map[string]string{PathV1: "public, max-age=31536000, immutable", PathLatest: "public, max-age=300", "/context": "public, max-age=300"} {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
		h := rec.Header()
		if rec.Code != 200 || !strings.HasPrefix(h.Get("Content-Type"), "application/ld+json") || h.Get("Access-Control-Allow-Origin") != "*" ||
			h.Get("Cache-Control") != cache || !strings.Contains(h.Get("Link"), `rel="describedby"`) {
			t.Errorf("%s: %d %v", path, rec.Code, h)
		}
		var v map[string]map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &v); err != nil || v["@context"]["cid"] != "djrust:cid" {
			t.Errorf("%s body: %v", path, err)
		}
		r2 := httptest.NewRecorder()
		req := httptest.NewRequest("GET", path, nil)
		req.Header.Set("If-None-Match", h.Get("ETag"))
		mux.ServeHTTP(r2, req)
		if r2.Code != 304 {
			t.Errorf("%s: If-None-Match gave %d", path, r2.Code)
		}
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest("OPTIONS", PathV1, nil))
	if rec.Code != 204 || rec.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Errorf("preflight: %d", rec.Code)
	}
}

// Every term a document uses is defined by the context, so an expander drops nothing.
func TestDocumentTermsAreInContext(t *testing.T) {
	var c map[string]map[string]any
	if err := json.Unmarshal(ContextV1(), &c); err != nil {
		t.Fatal(err)
	}
	tempo := 120.0
	d := Document("https://btw.bitwrap.io", Program{CID: "zabc", Name: "n", Key: "c", Tempo: &tempo, License: "CC0-1.0", Author: "a"})
	for k := range d {
		if strings.HasPrefix(k, "@") {
			continue
		}
		if _, ok := c["@context"][k]; !ok {
			t.Errorf("term %q is not in the context", k)
		}
	}
}
