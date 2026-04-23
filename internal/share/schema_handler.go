package share

// Content-negotiated handler for /schema/beats-share. Mirrors the pattern
// used by pflow-xyz (cmd/webserver/content_negotiation.go): same URL serves
// the JSON-LD @context, the JSON-Schema, or an HTML term glossary based on
// the request's Accept header.

import (
	_ "embed"
	"encoding/json"
	"html/template"
	"net/http"
	"sort"
	"strings"
)

//go:embed beats-share.context.jsonld
var beatsShareContextBytes []byte

// shareSchemaBytes is defined in seal.go (embedded for validator compilation).

type schemaTerm struct {
	Name      string
	ID        string
	Type      string
	Container string
}

var schemaGlossaryTmpl = template.Must(template.New("glossary").Parse(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>BeatsShare schema · beats.bitwrap.io</title>
<style>
  body { font: 14px/1.5 -apple-system, system-ui, sans-serif; max-width: 820px; margin: 2rem auto; padding: 0 1rem; background:#0d0d0d; color:#ddd; }
  h1 { font-size: 1.4rem; margin-bottom: .25rem; }
  p  { color:#999; margin-top:.25rem; }
  a  { color:#6af; }
  table { width:100%; border-collapse: collapse; margin-top: 1rem; }
  th, td { text-align:left; padding:.4rem .6rem; border-bottom:1px solid #222; font-family: ui-monospace, monospace; font-size: 13px; }
  th { color:#aaa; font-weight: 600; }
  code { color:#9cf; }
</style></head><body>
<h1>BeatsShare · JSON-LD context</h1>
<p>Canonical envelope for a share-v1 payload produced by <a href="https://beats.bitwrap.io/">beats.bitwrap.io</a>. See also
<a href="/schema/beats-share.schema.json">JSON-Schema</a> ·
<a href="/schema/beats-share.context.jsonld">raw JSON-LD</a>.</p>
<table>
  <thead><tr><th>Term</th><th>@id</th><th>@type</th><th>@container</th></tr></thead>
  <tbody>
  {{range .}}<tr><td>{{.Name}}</td><td><code>{{.ID}}</code></td><td>{{.Type}}</td><td>{{.Container}}</td></tr>
  {{end}}
  </tbody>
</table>
</body></html>`))

// HandleBeatsShareSchema serves /schema/beats-share with content negotiation.
// Rules: the schema / HTML forms must be requested explicitly (no wildcard
// match); anything else — including a missing or `*/*` Accept — returns the
// JSON-LD context, which is the canonical form for tooling like jsonld.js.
func HandleBeatsShareSchema(w http.ResponseWriter, r *http.Request) {
	accept := r.Header.Get("Accept")
	switch {
	case acceptMentions(accept, "application/schema+json"):
		w.Header().Set("Content-Type", "application/schema+json")
		w.Header().Set("Cache-Control", "public, max-age=300")
		w.Write(shareSchemaBytes)
	case acceptMentions(accept, "text/html") &&
		!acceptMentions(accept, "application/ld+json") &&
		!acceptMentions(accept, "application/schema+json"):
		terms, err := parseContextTerms(beatsShareContextBytes)
		if err != nil {
			http.Error(w, "schema render error", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		if err := schemaGlossaryTmpl.Execute(w, terms); err != nil {
			http.Error(w, "render error", http.StatusInternalServerError)
		}
	default:
		w.Header().Set("Content-Type", "application/ld+json")
		w.Header().Set("Cache-Control", "public, max-age=300")
		w.Write(beatsShareContextBytes)
	}
}

// acceptMentions reports whether the Accept header explicitly names `mime`
// (no wildcard expansion). Used to decide when to serve the non-default
// forms — a bare `*/*` should never trigger schema+json or text/html.
func acceptMentions(accept, mime string) bool {
	for _, part := range strings.Split(accept, ",") {
		typ, _, _ := strings.Cut(strings.TrimSpace(part), ";")
		if strings.TrimSpace(typ) == mime {
			return true
		}
	}
	return false
}

// parseContextTerms extracts a sorted list of schema terms from the embedded
// JSON-LD context so the HTML glossary renders straight from the canonical
// document — no duplicated term lists to keep in sync.
func parseContextTerms(raw []byte) ([]schemaTerm, error) {
	var doc struct {
		Context map[string]any `json:"@context"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}
	var out []schemaTerm
	for name, v := range doc.Context {
		if strings.HasPrefix(name, "@") {
			continue
		}
		t := schemaTerm{Name: name}
		switch val := v.(type) {
		case string:
			t.ID = val
		case map[string]any:
			if id, ok := val["@id"].(string); ok {
				t.ID = id
			}
			if ty, ok := val["@type"].(string); ok {
				t.Type = ty
			}
			if c, ok := val["@container"].(string); ok {
				t.Container = c
			}
		default:
			continue
		}
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}


