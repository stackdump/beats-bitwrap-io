// Public, stateless MCP tool set — the surface safe to expose at /mcp on the
// production beats.bitwrap.io (which runs without -authoring, so there is no
// server-side sequencer to drive). These tools call internal packages
// directly (generator catalog, share canonicalization) rather than proxying
// to the authoring /api/* routes, except generate_share's seal which uses the
// always-public PUT /o/{cid}. No transport/tempo/mute control is exposed.
package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	"beats-bitwrap-io/internal/generator"
	"beats-bitwrap-io/internal/share"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

const shareContext = "https://beats.bitwrap.io/schema/beats-share"

// NewPublicServer builds the curated, stateless MCP server mounted on a
// production host. Tools here neither require nor assume a running sequencer.
func NewPublicServer() *server.MCPServer {
	s := server.NewMCPServer(
		"beats-btw",
		"0.1.0",
		server.WithToolCapabilities(false),
		server.WithRecovery(),
	)
	s.AddTool(generateShareTool(), handleGenerateShare)
	s.AddTool(listGenresTool(), handleListGenresLocal)
	s.AddTool(getSongTool(), handleGetSong)
	return s
}

// --- generate_share -------------------------------------------------------

func generateShareTool() mcp.Tool {
	return mcp.NewTool("generate_share",
		mcp.WithDescription("Create a shareable, deterministic beat from a genre + seed and return a playable URL. Builds a share-v1 envelope, computes its content-address (CID), and seals it to the store. Opening the URL regenerates byte-identical playback in the browser — no server, no AI at play time."),
		mcp.WithString("genre",
			mcp.Required(),
			mcp.Description("Genre preset, e.g. techno, house, ambient, dnb, dubstep, edm, synthwave, trance, trap, lofi. Use list_genres for the full set."),
		),
		mcp.WithNumber("seed",
			mcp.Description("Integer seed for reproducible generation (default 0). Same genre+seed always yields the same track."),
		),
		mcp.WithNumber("tempo",
			mcp.Description("Override tempo in BPM (default: genre-specific)."),
		),
		mcp.WithString("structure",
			mcp.Description("Arrangement: loop, ab, drop, build, jam, minimal, standard, extended. Omit for infinite loop."),
		),
		mcp.WithNumber("arrangeSeed",
			mcp.Description("Seed for the arrangement (blueprint pick, humanization). Only meaningful with a non-loop structure."),
		),
		mcp.WithNumber("swing",
			mcp.Description("Swing percentage 0-100 (default: genre-specific)."),
		),
		mcp.WithNumber("humanize",
			mcp.Description("Humanize amount 0-100 (default: genre-specific)."),
		),
		mcp.WithBoolean("render",
			mcp.Description("Produce the downloadable .webm. With BEATS_REBUILD_SECRET set (authoring backend): mirrors the envelope to the publish host, synchronously renders on the local authoring server, then PUTs the .webm to the publish host with X-Rebuild-Secret. Without the secret (public MCP, anonymous user): queues the CID on the publish host's render farm via POST /api/rebuild-mark — the worker bakes it asynchronously. Either way the link plays in-browser via Tone.js regeneration without the .webm. Default false (envelope-only, no farm load)."),
		),
		mcp.WithBoolean("wait",
			mcp.Description("With render=true, block until the .webm is published on the mirror host (HEAD /audio/{cid}.webm returns 200) or 5 minutes elapse — whichever comes first. Useful when the caller wants a guaranteed-playable audio file in the response rather than a queued promise. Ignored when render=false or when the sync render+mirror path is in use (that path already waits). Default false."),
		),
	)
}

func handleGenerateShare(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	args := req.GetArguments()
	genre, _ := args["genre"].(string)
	if genre == "" {
		return mcp.NewToolResultError("genre is required"), nil
	}
	if _, ok := generator.Genres[genre]; !ok {
		return mcp.NewToolResultError(fmt.Sprintf("unknown genre %q — see list_genres", genre)), nil
	}

	seed := 0
	if v, ok := args["seed"].(float64); ok {
		seed = int(v)
	}

	// Build the envelope. Only include provided overrides so unconfigured
	// shares stay byte-identical across producers (CID stability).
	env := map[string]any{
		"@context": shareContext,
		"@type":    "BeatsShare",
		"v":        1,
		"genre":    genre,
		"seed":     seed,
	}
	if v, ok := args["tempo"].(float64); ok {
		env["tempo"] = int(v)
	}
	if v, ok := args["structure"].(string); ok && v != "" {
		env["structure"] = v
	}
	if v, ok := args["arrangeSeed"].(float64); ok {
		env["arrangeSeed"] = int(v)
	}
	if v, ok := args["swing"].(float64); ok {
		env["swing"] = v
	}
	if v, ok := args["humanize"].(float64); ok {
		env["humanize"] = v
	}

	cid, canonical, err := share.CanonicalCID(env)
	if err != nil {
		return mcp.NewToolResultError("canonicalize: " + err.Error()), nil
	}
	// Seal via the always-public PUT /o/{cid}; the server re-verifies the CID
	// against these exact bytes. Idempotent — same bytes return 200.
	if _, err := apiCallRaw("PUT", "/o/"+cid, canonical); err != nil {
		return mcp.NewToolResultError("seal: " + err.Error()), nil
	}

	url := publicBase + "/?cid=" + cid

	// Optional: render the .webm and publish it to the mirror host. Foreground
	// for a brief budget (cached renders + mirror finish inline), background
	// after. Cold renders run at 1x wall-clock and never fit a tool-call
	// timeout, so we promise the URL instead of dying. The render always
	// completes on the server either way. Budget kept under the parent
	// http.Server WriteTimeout (15s) so the response isn't killed mid-select.
	// A failure inside this block notes the error but never fails the seal
	// (the URL already plays in-browser without a .webm).
	renderNote := ""
	if render, _ := args["render"].(bool); render {
		wait, _ := args["wait"].(bool)
		renderNote = startRenderAndMirror(cid, canonical, 10*time.Second, wait)
	}

	return mcp.NewToolResultText(fmt.Sprintf(
		"Sealed %s (seed %d) → %s\nCID: %s\nOpen the URL to play; it regenerates the exact track client-side.%s",
		genre, seed, url, cid, renderNote,
	)), nil
}

// startRenderAndMirror kicks off the render+mirror chain in a goroutine and
// races it against `budget`. If the chain finishes in time, the foreground
// note is returned. Otherwise the goroutine keeps running to completion and
// the caller is told what URL to poll. Without BEATS_REBUILD_SECRET — which
// is the public-MCP case (anonymous user, no authoring backend) — it falls
// back to the publicly-open POST /api/rebuild-mark, letting the publish
// host's render farm bake the .webm asynchronously. Callers that need
// stricter "render is definitely on prod when I return" semantics can just
// re-invoke (CIDs are idempotent — the second call returns from cache once
// prod is warm).
func startRenderAndMirror(cid string, canonical []byte, budget time.Duration, wait bool) string {
	mirror := strings.TrimRight(os.Getenv("BEATS_MIRROR_HOST"), "/")
	if mirror == "" {
		mirror = publicBase
	}
	// Mirror the envelope to the publish host first. Required for both paths:
	// the queue-mark fallback rejects CIDs not in the publish-host share store,
	// and the sync render+mirror path expects the envelope to be reachable on
	// the URL it will eventually return. Idempotent (server re-verifies CID,
	// re-PUT of identical bytes is a 200 no-op). When the MCP is in-process on
	// the publish host itself, baseURL() and mirror loop back to the same store
	// — the seal earlier in handleGenerateShare already populated it, and this
	// is a cheap idempotent re-PUT.
	if _, err := apiCallRawTo(mirror, "PUT", "/o/"+cid, canonical, "application/json", nil, 30); err != nil {
		return "\nEnvelope mirror to " + mirror + " failed (" + err.Error() + ") — the link still plays in-browser."
	}

	secret := strings.TrimSpace(os.Getenv("BEATS_REBUILD_SECRET"))
	if secret == "" {
		// Public-MCP fallback: queue the CID for the publish host's render
		// farm. Best-effort — a failure here (host has no -rebuild-queue,
		// network blip) is noted but never fails the seal.
		if _, err := apiCallTo(mirror, "POST", "/api/rebuild-mark",
			map[string]any{"cid": cid}); err != nil {
			return "\nAudio render NOT queued (" + err.Error() + ") — the link still plays in-browser."
		}
		if wait {
			audioURL := fmt.Sprintf("%s/audio/%s.webm", mirror, cid)
			if waited, ok := waitForAudio(mirror, cid, 5*time.Minute); ok {
				return fmt.Sprintf("\nRendered by farm in %s — playable at %s.", waited.Round(time.Second), audioURL)
			} else {
				return fmt.Sprintf(
					"\nQueued for audio render on %s; still rendering after 5 min — check %s shortly (the link plays in-browser regardless).",
					mirror, audioURL,
				)
			}
		}
		return fmt.Sprintf(
			"\nQueued for audio render on %s — the publish host's render farm will bake %s/audio/%s.webm (typically minutes; the link plays in-browser regardless).",
			mirror, mirror, cid,
		)
	}
	done := make(chan string, 1)
	go func() { done <- renderAndMirror(cid, mirror, secret) }()
	select {
	case msg := <-done:
		return msg
	case <-time.After(budget):
		return fmt.Sprintf(
			"\nRender in progress on local; mirror PUT will follow. Re-check %s/audio/%s.webm in a few minutes (realtime renders ≈ track length).",
			mirror, cid,
		)
	}
}

// waitForAudio HEAD-polls {mirror}/audio/{cid}.webm every 5s until 200 or
// the timeout elapses. Returns (elapsed, true) on success, (timeout, false)
// on timeout. Cheap probe — server's HEAD path is cache-only and never
// triggers a render itself, so a tight poll loop doesn't burn the farm.
func waitForAudio(mirror, cid string, timeout time.Duration) (time.Duration, bool) {
	deadline := time.Now().Add(timeout)
	url := mirror + "/audio/" + cid + ".webm"
	client := &http.Client{Timeout: 10 * time.Second}
	start := time.Now()
	for {
		req, _ := http.NewRequest(http.MethodHead, url, nil)
		if resp, err := client.Do(req); err == nil {
			resp.Body.Close()
			if resp.StatusCode == 200 {
				return time.Since(start), true
			}
		}
		if time.Now().After(deadline) {
			return timeout, false
		}
		time.Sleep(5 * time.Second)
	}
}

// renderAndMirror is the sync-path tail: trigger local render → PUT .webm
// to the publish host. The envelope mirror is handled by the caller because
// both branches (sync + queue-fallback) need it. Returns a human-readable
// note. Never panics — failures degrade to text so the seal still surfaces.
func renderAndMirror(cid, mirror, secret string) string {
	// Trigger local render. The local /audio/{cid}.webm GET blocks for the
	// realtime render on first request and returns the bytes when ready.
	// Long timeout — cold renders run at 1x wall-clock.
	body, _, err := fetchRaw("", "/audio/"+cid+".webm", 900)
	if err != nil {
		return "\nRender failed on local render of /audio/" + cid + ".webm: " + err.Error()
	}
	// Mirror .webm with X-Rebuild-Secret so the PUT bypasses rate-limit /
	// faster-than-realtime / first-write-wins checks.
	if _, err := apiCallRawTo(mirror, "PUT", "/audio/"+cid+".webm", body, "audio/webm",
		map[string]string{"X-Rebuild-Secret": secret}, 120); err != nil {
		return "\nLocal render OK (" + fmt.Sprintf("%d bytes", len(body)) + ") but mirror PUT to " + mirror + " failed: " + err.Error()
	}
	return fmt.Sprintf("\nRendered + mirrored: %s/audio/%s.webm (%d bytes).", mirror, cid, len(body))
}

// --- list_genres (in-process) --------------------------------------------

// handleListGenresLocal reads the Go genre catalog directly so it works in
// production (the proxy handleListGenres hits the authoring-only /api/genres).
func handleListGenresLocal(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	type g struct {
		Name  string  `json:"name"`
		BPM   float64 `json:"bpm"`
		Scale string  `json:"scale"`
	}
	out := make([]g, 0, len(generator.Genres))
	for name, gen := range generator.Genres {
		out = append(out, g{Name: name, BPM: gen.BPM, Scale: gen.ScaleName})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	b, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	return mcp.NewToolResultText(string(b)), nil
}

// --- get_song -------------------------------------------------------------

func getSongTool() mcp.Tool {
	return mcp.NewTool("get_song",
		mcp.WithDescription("Fetch the sealed share-v1 envelope for a CID (the deterministic recipe behind a ?cid= link)."),
		mcp.WithString("cid",
			mcp.Required(),
			mcp.Description("Content-address from a beats share URL (the z… string after ?cid=)."),
		),
	)
}

func handleGetSong(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	cid, _ := req.GetArguments()["cid"].(string)
	if !validCID(cid) {
		return mcp.NewToolResultError("invalid cid"), nil
	}
	resp, err := apiCall("GET", "/o/"+cid, nil)
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	return mcp.NewToolResultText(string(resp)), nil
}
