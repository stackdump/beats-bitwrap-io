package share

// Render-completion webhooks. When the publish host stores a new .webm — either
// from a server-side render or an authenticated worker PUT — it fires a signed
// notification at BEATS_RENDER_WEBHOOK_URL so async consumers (Slack, feed
// builders, mobile clients) can react without waiting on the request/response
// turn of generate_share.
//
// The event carries the CID and a URL; consumers verify the artifact by
// fetching /audio/{cid}.webm directly (content-addressed → content is its own
// proof). The Ed25519 signature on the event body is a defense against
// transport tampering, signed with the same operator key that signs envelopes.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// RenderEventSource tags who produced the .webm. "renderfarm" = authenticated
// worker PUT (the typical async bake path); "server" = the publish host
// rendered in-process (e.g. authoring mode with -audio-render). Browser
// uploads do NOT fire this event — those are user-self-renders, semantically
// distinct from a bake landing.
type RenderEventSource string

const (
	RenderSourceFarm   RenderEventSource = "renderfarm"
	RenderSourceServer RenderEventSource = "server"
)

// BuildRenderEvent assembles the canonical render.complete payload. Signing
// happens separately so callers can choose to send unsigned (operator key
// absent) without changing the shape.
func BuildRenderEvent(cid, audioURL string, bytes int64, source RenderEventSource, ts time.Time) map[string]any {
	return map[string]any{
		"event":      "render.complete",
		"cid":        cid,
		"url":        audioURL,
		"bytes":      bytes,
		"source":     string(source),
		"renderedAt": ts.UTC().Format(time.RFC3339),
		// `text` is a Slack-friendly summary; non-Slack receivers ignore it.
		// Putting it inline (rather than nested in `attachments`) keeps the
		// payload single-shape regardless of receiver.
		"text": fmt.Sprintf("🎧 baked %s → %s", cid, audioURL),
	}
}

// SignRenderEvent stamps `signer` + `signature` on the event using the same
// canonical-JSON-with-signature-stripped discipline as SignManifest. A no-op
// when k is nil so callers can pass through optionally-configured keys.
func SignRenderEvent(event map[string]any, k *OperatorKey) error {
	if k == nil {
		return nil
	}
	return k.SignManifest(event)
}

// PostRenderEvent serializes the event and POSTs it. Short timeout — webhooks
// shouldn't block the PUT response; the caller fires this in a goroutine.
func PostRenderEvent(webhookURL string, event map[string]any) error {
	if webhookURL == "" {
		return nil
	}
	body, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	req, err := http.NewRequest(http.MethodPost, webhookURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return nil
}
