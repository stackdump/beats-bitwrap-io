package main

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"beats-bitwrap-io/internal/share"
)

func TestSetDescriptionRefusesWhatIsNotACID(t *testing.T) {
	st, err := share.NewStoreForType(share.CompositionType, t.TempDir(), 1<<20, 100, 100)
	if err != nil {
		t.Fatal(err)
	}
	h := setDescriptionHandler(st)
	for path, want := range map[string]int{
		"/set/not-a-cid.jsonld": http.StatusBadRequest,
		"/set/zQm3h5Tp7YdKfWcN9bXrLs2UvAeGjH8nPqRtMwXyZaBcDe.jsonld": http.StatusNotFound,
	} {
		rec := httptest.NewRecorder()
		h(rec, httptest.NewRequest("GET", path, nil))
		if rec.Code != want {
			t.Errorf("%s: %d, want %d", path, rec.Code, want)
		}
	}
}

func TestBeatscriptDescriptorIsServedAsLinkedData(t *testing.T) {
	rec := httptest.NewRecorder()
	beatscriptDescriptorHandler(rec, httptest.NewRequest("GET", "/schema/beatscript", nil))
	if rec.Code != 200 || rec.Header().Get("Content-Type") != "application/ld+json" || rec.Body.Len() == 0 {
		t.Errorf("%d %q", rec.Code, rec.Header().Get("Content-Type"))
	}
}
