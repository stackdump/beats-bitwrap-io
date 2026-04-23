package routes

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"beats-bitwrap-io/internal/sequencer"
	"beats-bitwrap-io/internal/ws"
)

func newTestServer() (*Server, *http.ServeMux) {
	seq := sequencer.New()
	hub := ws.NewHub(seq)
	go hub.Run()
	WireCallbacks(seq, hub)
	srv := NewServer(seq, hub)
	mux := http.NewServeMux()
	srv.RegisterRoutes(mux, http.FileServer(http.Dir("../../public")))
	return srv, mux
}

func TestTransport(t *testing.T) {
	_, mux := newTestServer()

	for _, action := range []string{"play", "stop", "pause"} {
		body := `{"action":"` + action + `"}`
		req := httptest.NewRequest(http.MethodPost, "/api/transport", strings.NewReader(body))
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Errorf("transport %s: got %d, want 200", action, w.Code)
		}
	}

	// GET should fail
	req := httptest.NewRequest(http.MethodGet, "/api/transport", nil)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("transport GET: got %d, want 405", w.Code)
	}
}

func TestTempo(t *testing.T) {
	_, mux := newTestServer()

	req := httptest.NewRequest(http.MethodPost, "/api/tempo", strings.NewReader(`{"bpm":140}`))
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("tempo: got %d, want 200", w.Code)
	}
	if !strings.Contains(w.Body.String(), "140") {
		t.Errorf("tempo response missing bpm: %s", w.Body.String())
	}
}

func TestProjectGetEmpty(t *testing.T) {
	_, mux := newTestServer()

	req := httptest.NewRequest(http.MethodGet, "/api/project", nil)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("project GET: got %d, want 200", w.Code)
	}
	if strings.TrimSpace(w.Body.String()) != "null" {
		t.Errorf("expected null, got: %s", w.Body.String())
	}
}

func TestGenerate(t *testing.T) {
	_, mux := newTestServer()

	body := `{"genre":"techno","params":{}}`
	req := httptest.NewRequest(http.MethodPost, "/api/generate", strings.NewReader(body))
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("generate: got %d, want 200", w.Code)
	}
	var proj map[string]interface{}
	if err := json.NewDecoder(w.Body).Decode(&proj); err != nil {
		t.Fatalf("generate response decode: %v", err)
	}
	if _, ok := proj["nets"]; !ok {
		t.Error("generate response missing 'nets' key")
	}
}

func TestMute(t *testing.T) {
	_, mux := newTestServer()

	body := `{"netId":"test-net","muted":true}`
	req := httptest.NewRequest(http.MethodPost, "/api/mute", strings.NewReader(body))
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("mute: got %d, want 200", w.Code)
	}
}

func TestGenres(t *testing.T) {
	_, mux := newTestServer()

	req := httptest.NewRequest(http.MethodGet, "/api/genres", nil)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("genres: got %d, want 200", w.Code)
	}
	var genres map[string]interface{}
	if err := json.NewDecoder(w.Body).Decode(&genres); err != nil {
		t.Fatalf("genres decode: %v", err)
	}
	if len(genres) == 0 {
		t.Error("genres returned empty map")
	}
}

func TestInstruments(t *testing.T) {
	_, mux := newTestServer()

	req := httptest.NewRequest(http.MethodGet, "/api/instruments", nil)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("instruments: got %d, want 200", w.Code)
	}
	var instruments []string
	if err := json.NewDecoder(w.Body).Decode(&instruments); err != nil {
		t.Fatalf("instruments decode: %v", err)
	}
	if len(instruments) == 0 {
		t.Error("instruments returned empty list")
	}
}

func TestShuffleNoProject(t *testing.T) {
	_, mux := newTestServer()

	req := httptest.NewRequest(http.MethodPost, "/api/shuffle-instruments", strings.NewReader(`{"seed":42}`))
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Errorf("shuffle without project: got %d, want 400", w.Code)
	}
}
