// Package mcp provides an MCP server for controlling petri-note.
// It calls the petri-note HTTP API so the running server stays in sync
// with any connected browser clients.
package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

func baseURL() string {
	if v := os.Getenv("BEATS_BTW_URL"); v != "" {
		return v
	}
	return "http://localhost:8080"
}

// validCID gates user-supplied CIDs before they're interpolated into
// URLs. Matches the existing CIDv1 / base58btc / dag-json shape used
// by the share store (leading 'z' multibase prefix + 40-90 base58
// characters). Rejects path-traversal sequences and other junk so the
// MCP tools can't be used as a probe vector against the target host.
func validCID(s string) bool {
	if len(s) < 40 || len(s) > 90 {
		return false
	}
	if s[0] != 'z' {
		return false
	}
	for i := 1; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= '0' && c <= '9':
		case c >= 'A' && c <= 'Z':
		case c >= 'a' && c <= 'z':
		default:
			return false
		}
	}
	return true
}

// apiCall makes a request to the petri-note HTTP server.
func apiCall(method, path string, body interface{}) (json.RawMessage, error) {
	return apiCallTo("", method, path, body)
}

// apiCallTo makes a request to a specific host (or the default when empty).
// Used by the rebuild/archive tools so a single MCP session can manage
// both a local authoring server and the remote production host.
func apiCallTo(host, method, path string, body interface{}) (json.RawMessage, error) {
	var reqBody io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reqBody = bytes.NewReader(data)
	}

	base := host
	if base == "" {
		base = baseURL()
	}
	req, err := http.NewRequest(method, base+path, reqBody)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("server not reachable at %s: %v", base, err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(respBody))
	}
	return json.RawMessage(respBody), nil
}

// Serve starts the MCP server on stdio.
func Serve() error {
	s := server.NewMCPServer(
		"beats-btw",
		"0.1.0",
		server.WithToolCapabilities(false),
		server.WithRecovery(),
	)

	s.AddTool(generateTool(), handleGenerate)
	s.AddTool(transportTool(), handleTransport)
	s.AddTool(tempoTool(), handleTempo)
	s.AddTool(getProjectTool(), handleGetProject)
	s.AddTool(loadProjectTool(), handleLoadProject)
	s.AddTool(listGenresTool(), handleListGenres)
	s.AddTool(listInstrumentsTool(), handleListInstruments)
	s.AddTool(shuffleInstrumentsTool(), handleShuffleInstruments)
	s.AddTool(muteTrackTool(), handleMuteTrack)
	s.AddTool(setInstrumentTool(), handleSetInstrument)
	s.AddTool(midiRoutingTool(), handleMidiRouting)
	s.AddTool(rebuildQueueTool(), handleRebuildQueue)
	s.AddTool(rebuildMarkTool(), handleRebuildMark)
	s.AddTool(rebuildClearTool(), handleRebuildClear)
	s.AddTool(archiveMissingTool(), handleArchiveMissing)
	s.AddTool(archiveLookupTool(), handleArchiveLookup)
	s.AddTool(collectionStatusTool(), handleCollectionStatus)

	return server.ServeStdio(s)
}

// hostArg returns the host override for a tool call, or the empty string
// (so apiCallTo falls back to BEATS_BTW_URL). Trims trailing slashes so
// "https://beats.bitwrap.io/" and "https://beats.bitwrap.io" both work.
func hostArg(req mcp.CallToolRequest) string {
	h, _ := req.GetArguments()["host"].(string)
	for len(h) > 0 && h[len(h)-1] == '/' {
		h = h[:len(h)-1]
	}
	return h
}

// === Tool definitions ===

func generateTool() mcp.Tool {
	return mcp.NewTool("generate",
		mcp.WithDescription("Generate a new music project from a genre preset. Stops current playback, creates drums (kick/snare/hihat as Euclidean rhythms), bass (Markov melody), and lead melody. Use 'play' transport action to start playback after generating."),
		mcp.WithString("genre",
			mcp.Required(),
			mcp.Description("Genre preset: techno, house, jazz, ambient, dnb, edm, speedcore, dubstep, country, blues, synthwave"),
		),
		mcp.WithNumber("bpm",
			mcp.Description("Override tempo in BPM (default: genre-specific)"),
		),
		mcp.WithNumber("seed",
			mcp.Description("Random seed for reproducible generation"),
		),
		mcp.WithString("structure",
			mcp.Description("Song structure template: standard, minimal, extended. Omit for infinite loop mode."),
		),
		mcp.WithBoolean("drum-fills",
			mcp.Description("Add drum fills at section boundaries (structure mode). Default: genre-specific."),
		),
		mcp.WithBoolean("walking-bass",
			mcp.Description("Use walking bass with chromatic passing tones between chord roots. Default: genre-specific."),
		),
		mcp.WithNumber("polyrhythm",
			mcp.Description("Odd-length hihat loop for polyrhythm (e.g. 6 for 6-over-4). 0=disabled. Default: genre-specific."),
		),
		mcp.WithNumber("syncopation",
			mcp.Description("Probability 0.0-1.0 of shifting notes to the offbeat (anticipation). Default: genre-specific."),
		),
		mcp.WithBoolean("call-response",
			mcp.Description("Use call-and-response melody (2-bar call + 2-bar response resolving to tonic). Default: genre-specific."),
		),
		mcp.WithBoolean("tension-curve",
			mcp.Description("Scale density/velocity/register per riff variant for dynamic energy (structure mode). Default: genre-specific."),
		),
		mcp.WithNumber("modal-interchange",
			mcp.Description("Probability 0.0-1.0 of borrowing chords from the parallel key. Default: genre-specific."),
		),
		mcp.WithNumber("ghost-notes",
			mcp.Description("Density 0.0-1.0 of low-velocity ghost notes between main hihat hits. Default: genre-specific."),
		),
	)
}

func handleGenerate(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	genre, _ := req.GetArguments()["genre"].(string)
	if genre == "" {
		genre = "techno"
	}
	params := map[string]interface{}{}
	if bpm, ok := req.GetArguments()["bpm"].(float64); ok {
		params["bpm"] = bpm
	}
	if seed, ok := req.GetArguments()["seed"].(float64); ok {
		params["seed"] = seed
	}
	if structure, ok := req.GetArguments()["structure"].(string); ok && structure != "" {
		params["structure"] = structure
	}
	// Boolean variety overrides
	for _, key := range []string{"drum-fills", "walking-bass", "call-response", "tension-curve"} {
		if v, ok := req.GetArguments()[key].(bool); ok {
			params[key] = v
		}
	}
	// Numeric variety overrides
	for _, key := range []string{"polyrhythm", "syncopation", "modal-interchange", "ghost-notes"} {
		if v, ok := req.GetArguments()[key].(float64); ok {
			params[key] = v
		}
	}

	body := map[string]interface{}{"genre": genre, "params": params}
	resp, err := apiCall("POST", "/api/generate", body)
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}

	// Summarize the project rather than dumping all JSON
	var proj map[string]interface{}
	json.Unmarshal(resp, &proj)

	name, _ := proj["name"].(string)
	tempo, _ := proj["tempo"].(float64)
	nets, _ := proj["nets"].(map[string]interface{})

	summary := fmt.Sprintf("Generated: %s (%.0f BPM)", name, tempo)
	if structure, ok := params["structure"].(string); ok && structure != "" {
		summary += fmt.Sprintf(" [structure: %s]", structure)
	}
	summary += "\nNets: "
	for netId := range nets {
		summary += netId + " "
	}
	summary += "\n\nUse transport action 'play' to start playback."

	return mcp.NewToolResultText(summary), nil
}

func transportTool() mcp.Tool {
	return mcp.NewTool("transport",
		mcp.WithDescription("Control playback: play, stop, or pause the sequencer"),
		mcp.WithString("action",
			mcp.Required(),
			mcp.Description("Transport action: play, stop, pause"),
		),
	)
}

func handleTransport(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	action, _ := req.GetArguments()["action"].(string)
	body := map[string]string{"action": action}
	_, err := apiCall("POST", "/api/transport", body)
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	return mcp.NewToolResultText(fmt.Sprintf("Transport: %s", action)), nil
}

func tempoTool() mcp.Tool {
	return mcp.NewTool("set_tempo",
		mcp.WithDescription("Change the sequencer tempo in BPM (20-300)"),
		mcp.WithNumber("bpm",
			mcp.Required(),
			mcp.Description("Tempo in beats per minute"),
		),
	)
}

func handleTempo(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	bpm, _ := req.GetArguments()["bpm"].(float64)
	body := map[string]float64{"bpm": bpm}
	_, err := apiCall("POST", "/api/tempo", body)
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	return mcp.NewToolResultText(fmt.Sprintf("Tempo set to %.0f BPM", bpm)), nil
}

func getProjectTool() mcp.Tool {
	return mcp.NewTool("get_project",
		mcp.WithDescription("Get the current project state as JSON. Returns all nets, places, transitions, arcs, and MIDI bindings."),
	)
}

func handleGetProject(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	resp, err := apiCall("GET", "/api/project", nil)
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	// Pretty-print
	var buf bytes.Buffer
	json.Indent(&buf, resp, "", "  ")
	return mcp.NewToolResultText(buf.String()), nil
}

func loadProjectTool() mcp.Tool {
	return mcp.NewTool("load_project",
		mcp.WithDescription(`Load a custom project into the sequencer. The project JSON follows the petri-note schema:
{
  "name": "my project",
  "tempo": 120,
  "nets": {
    "net_id": {
      "track": {"channel": 10, "defaultVelocity": 100},
      "places": {
        "p0": {"x": 100, "y": 100, "initial": [1]},
        "p1": {"x": 200, "y": 100, "initial": [0]}
      },
      "transitions": {
        "t0": {"x": 150, "y": 100, "midi": {"note": 36, "channel": 10, "velocity": 100, "duration": 50}}
      },
      "arcs": [
        {"source": "p0", "target": "t0", "weight": [1]},
        {"source": "t0", "target": "p1", "weight": [1]}
      ]
    }
  }
}

MIDI notes: 36=kick, 38=snare, 42=hihat, 60=C4.
Channels: 10=drums, 4=lead, 5=pluck, 6=bass.
A circulating token in a ring of places creates a rhythm.`),
		mcp.WithString("project",
			mcp.Required(),
			mcp.Description("Project JSON string"),
		),
	)
}

func handleLoadProject(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	projStr, _ := req.GetArguments()["project"].(string)
	var projData map[string]interface{}
	if err := json.Unmarshal([]byte(projStr), &projData); err != nil {
		return mcp.NewToolResultError("Invalid project JSON: " + err.Error()), nil
	}

	_, err := apiCall("POST", "/api/project", projData)
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}

	name, _ := projData["name"].(string)
	nets, _ := projData["nets"].(map[string]interface{})
	return mcp.NewToolResultText(fmt.Sprintf("Loaded project: %s (%d nets)", name, len(nets))), nil
}

func listGenresTool() mcp.Tool {
	return mcp.NewTool("list_genres",
		mcp.WithDescription("List available genre presets for generation"),
	)
}

func handleListGenres(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	resp, err := apiCall("GET", "/api/genres", nil)
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	return mcp.NewToolResultText(string(resp)), nil
}

func listInstrumentsTool() mcp.Tool {
	return mcp.NewTool("list_instruments",
		mcp.WithDescription("List available synthesizer instruments that can be assigned to channels in the browser"),
	)
}

func handleListInstruments(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	resp, err := apiCall("GET", "/api/instruments", nil)
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	return mcp.NewToolResultText(string(resp)), nil
}

func shuffleInstrumentsTool() mcp.Tool {
	return mcp.NewTool("shuffle_instruments",
		mcp.WithDescription("Randomly pick new instruments for each track from its instrument set. Creates variety without changing patterns."),
		mcp.WithNumber("seed",
			mcp.Description("Random seed for reproducible shuffling (optional)"),
		),
	)
}

func handleShuffleInstruments(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	body := map[string]interface{}{}
	if seed, ok := req.GetArguments()["seed"].(float64); ok {
		body["seed"] = int64(seed)
	}
	resp, err := apiCall("POST", "/api/shuffle-instruments", body)
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}

	var instruments map[string]string
	json.Unmarshal(resp, &instruments)

	summary := "Shuffled instruments:\n"
	for netId, inst := range instruments {
		summary += fmt.Sprintf("  %s → %s\n", netId, inst)
	}
	return mcp.NewToolResultText(summary), nil
}

func muteTrackTool() mcp.Tool {
	return mcp.NewTool("mute_track",
		mcp.WithDescription("Mute or unmute a track (net) in the sequencer. Muted tracks still run their Petri net but don't produce MIDI output."),
		mcp.WithString("netId",
			mcp.Required(),
			mcp.Description("Net ID to mute/unmute (e.g., 'kick', 'bass', 'melody')"),
		),
		mcp.WithBoolean("muted",
			mcp.Description("true to mute, false to unmute (default: true)"),
		),
	)
}

func setInstrumentTool() mcp.Tool {
	return mcp.NewTool("set_instrument",
		mcp.WithDescription("Swap the bound instrument on a net, or on every net sharing a riff group. Use this to audition tones without regenerating — the server updates its project state and broadcasts the change so every connected browser's mixer dropdown follows. Call list_instruments for the catalog."),
		mcp.WithString("netId",
			mcp.Description("Net ID to retarget (e.g. 'bass-0', 'melody', 'hit1'). Ignored when riffGroup is set."),
		),
		mcp.WithString("riffGroup",
			mcp.Description("When set, applies to every net in that riff group (e.g. 'bass' hits all 16 bass-N slot variants at once)."),
		),
		mcp.WithString("instrument",
			mcp.Required(),
			mcp.Description("Instrument name — any value returned by list_instruments (e.g. 'acid', 'sub-bass', 'rave-stab', 'dark-pad')."),
		),
	)
}

func handleSetInstrument(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	args := req.GetArguments()
	instrument, _ := args["instrument"].(string)
	if instrument == "" {
		return mcp.NewToolResultError("instrument is required"), nil
	}
	netId, _ := args["netId"].(string)
	riffGroup, _ := args["riffGroup"].(string)
	if netId == "" && riffGroup == "" {
		return mcp.NewToolResultError("one of netId or riffGroup is required"), nil
	}
	body := map[string]interface{}{"instrument": instrument, "netId": netId, "riffGroup": riffGroup}
	resp, err := apiCall("POST", "/api/instrument", body)
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	return mcp.NewToolResultText(string(resp)), nil
}

func midiRoutingTool() mcp.Tool {
	return mcp.NewTool("get_midi_routing",
		mcp.WithDescription("Report the current server-side MIDI output mode (none/single/fanout/per-net), the open ports, and — in fanout mode — which netId is assigned to which port. Use this to see whether bass is going to 'btw Bus 4' etc."),
	)
}

func handleMidiRouting(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	resp, err := apiCall("GET", "/api/midi-routing", nil)
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	var routing struct {
		Mode        string            `json:"mode"`
		Ports       []string          `json:"ports"`
		Assignments map[string]string `json:"assignments"`
	}
	json.Unmarshal(resp, &routing)

	out := fmt.Sprintf("MIDI mode: %s\n", routing.Mode)
	if len(routing.Ports) > 0 {
		out += "Ports:\n"
		for _, p := range routing.Ports {
			out += "  " + p + "\n"
		}
	}
	if len(routing.Assignments) > 0 {
		out += "Assignments:\n"
		for netId, port := range routing.Assignments {
			out += fmt.Sprintf("  %s → %s\n", netId, port)
		}
	}
	return mcp.NewToolResultText(out), nil
}

// === Rebuild-queue + archive tools ===

func rebuildQueueTool() mcp.Tool {
	return mcp.NewTool("rebuild_queue",
		mcp.WithDescription("List CIDs currently flagged for audio re-render. The off-host worker (scripts/process-rebuild-queue.py) drains this queue. Returns at most `limit` entries (default 50, max 500)."),
		mcp.WithString("host",
			mcp.Description("Override target host (e.g. 'https://beats.bitwrap.io'). Defaults to BEATS_BTW_URL."),
		),
		mcp.WithNumber("limit",
			mcp.Description("Max CIDs to return (1-500, default 50)."),
		),
	)
}

func handleRebuildQueue(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	path := "/api/rebuild-queue"
	if v, ok := req.GetArguments()["limit"].(float64); ok && v > 0 {
		path = fmt.Sprintf("%s?limit=%d", path, int(v))
	}
	resp, err := apiCallTo(hostArg(req), "GET", path, nil)
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	var cids []string
	json.Unmarshal(resp, &cids)
	out := fmt.Sprintf("queue depth: %d\n", len(cids))
	for _, c := range cids {
		out += "  " + c + "\n"
	}
	return mcp.NewToolResultText(out), nil
}

func rebuildMarkTool() mcp.Tool {
	return mcp.NewTool("rebuild_mark",
		mcp.WithDescription("Flag a share CID for audio re-render. Worker picks it up on the next sweep. Idempotent — duplicate marks are silently coalesced server-side."),
		mcp.WithString("cid",
			mcp.Required(),
			mcp.Description("Share CID (z…) to mark for rebuild."),
		),
		mcp.WithString("host",
			mcp.Description("Override target host."),
		),
	)
}

func handleRebuildMark(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	cid, _ := req.GetArguments()["cid"].(string)
	if cid == "" {
		return mcp.NewToolResultError("cid is required"), nil
	}
	if !validCID(cid) {
		return mcp.NewToolResultError("invalid cid format"), nil
	}
	_, err := apiCallTo(hostArg(req), "POST", "/api/rebuild-mark", map[string]string{"cid": cid})
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	return mcp.NewToolResultText("marked: " + cid), nil
}

func rebuildClearTool() mcp.Tool {
	return mcp.NewTool("rebuild_clear",
		mcp.WithDescription("Drop a CID from the rebuild queue without re-rendering. Useful for stuck rows or canceling a mark."),
		mcp.WithString("cid",
			mcp.Required(),
			mcp.Description("Share CID to clear."),
		),
		mcp.WithString("host",
			mcp.Description("Override target host."),
		),
	)
}

func handleRebuildClear(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	cid, _ := req.GetArguments()["cid"].(string)
	if cid == "" {
		return mcp.NewToolResultError("cid is required"), nil
	}
	if !validCID(cid) {
		return mcp.NewToolResultError("invalid cid format"), nil
	}
	_, err := apiCallTo(hostArg(req), "POST", "/api/rebuild-clear", map[string]string{"cid": cid})
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	return mcp.NewToolResultText("cleared: " + cid), nil
}

func archiveMissingTool() mcp.Tool {
	return mcp.NewTool("archive_missing",
		mcp.WithDescription("List CIDs in the share store that have no cached audio render. Drives the archive sweep — pair with rebuild_mark to enqueue them."),
		mcp.WithNumber("limit",
			mcp.Description("Max CIDs to return (default 100)."),
		),
		mcp.WithString("host",
			mcp.Description("Override target host."),
		),
	)
}

func handleArchiveMissing(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	path := "/api/archive-missing"
	if v, ok := req.GetArguments()["limit"].(float64); ok && v > 0 {
		path = fmt.Sprintf("%s?limit=%d", path, int(v))
	}
	resp, err := apiCallTo(hostArg(req), "GET", path, nil)
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	var cids []string
	json.Unmarshal(resp, &cids)
	out := fmt.Sprintf("missing renders: %d\n", len(cids))
	for _, c := range cids {
		out += "  " + c + "\n"
	}
	return mcp.NewToolResultText(out), nil
}

func archiveLookupTool() mcp.Tool {
	return mcp.NewTool("archive_lookup",
		mcp.WithDescription("Report whether a CID is live in the share store and which persisted snapshots contain it."),
		mcp.WithString("cid",
			mcp.Required(),
			mcp.Description("Share CID to look up."),
		),
		mcp.WithString("host",
			mcp.Description("Override target host."),
		),
	)
}

func handleArchiveLookup(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	cid, _ := req.GetArguments()["cid"].(string)
	if cid == "" {
		return mcp.NewToolResultError("cid is required"), nil
	}
	if !validCID(cid) {
		return mcp.NewToolResultError("invalid cid format"), nil
	}
	resp, err := apiCallTo(hostArg(req), "GET", "/api/archive-lookup?cid="+cid, nil)
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	var buf bytes.Buffer
	json.Indent(&buf, resp, "", "  ")
	return mcp.NewToolResultText(buf.String()), nil
}

func collectionStatusTool() mcp.Tool {
	return mcp.NewTool("collection_status",
		mcp.WithDescription("Report rebuild + render coverage for a list of CIDs (a 'collection'). For each CID: in queue? has cached audio? envelope present? Useful when seeding a batch and wanting to know which still need work."),
		mcp.WithArray("cids",
			mcp.Required(),
			mcp.Description("List of share CIDs to check."),
			mcp.Items(map[string]any{"type": "string"}),
		),
		mcp.WithString("host",
			mcp.Description("Override target host."),
		),
	)
}

func handleCollectionStatus(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	raw, _ := req.GetArguments()["cids"].([]interface{})
	cids := make([]string, 0, len(raw))
	for _, v := range raw {
		if s, ok := v.(string); ok && s != "" {
			cids = append(cids, s)
		}
	}
	if len(cids) == 0 {
		return mcp.NewToolResultError("cids is required"), nil
	}
	host := hostArg(req)
	queueResp, err := apiCallTo(host, "GET", "/api/rebuild-queue?limit=500", nil)
	if err != nil {
		return mcp.NewToolResultError("rebuild-queue: " + err.Error()), nil
	}
	var queueList []string
	json.Unmarshal(queueResp, &queueList)
	queued := map[string]bool{}
	for _, c := range queueList {
		queued[c] = true
	}

	base := host
	if base == "" {
		base = baseURL()
	}
	type row struct {
		CID       string `json:"cid"`
		Envelope  bool   `json:"envelope"`
		Audio     bool   `json:"audio"`
		Queued    bool   `json:"queued"`
		AudioSize int64  `json:"audio_size_bytes,omitempty"`
	}
	rows := make([]row, 0, len(cids))
	var queuedN, audioN, envN, invalidN int
	for _, cid := range cids {
		if !validCID(cid) {
			rows = append(rows, row{CID: cid})
			invalidN++
			continue
		}
		r := row{CID: cid, Queued: queued[cid]}
		if r.Queued {
			queuedN++
		}
		// envelope: GET /o/{cid} (the share-store handler doesn't accept
		// HEAD). Envelopes are tiny (~1-2 KB) so the body cost is fine.
		if envReq, _ := http.NewRequest("GET", base+"/o/"+cid, nil); envReq != nil {
			if resp, err := http.DefaultClient.Do(envReq); err == nil {
				io.Copy(io.Discard, resp.Body)
				resp.Body.Close()
				if resp.StatusCode < 400 {
					r.Envelope = true
					envN++
				}
			}
		}
		// audio: GET /audio/{cid}.webm with Range: bytes=0-0 so we only
		// pull a single byte. Content-Range carries the full file size.
		if audReq, _ := http.NewRequest("GET", base+"/audio/"+cid+".webm", nil); audReq != nil {
			audReq.Header.Set("Range", "bytes=0-0")
			if resp, err := http.DefaultClient.Do(audReq); err == nil {
				io.Copy(io.Discard, resp.Body)
				resp.Body.Close()
				if resp.StatusCode < 400 {
					r.Audio = true
					audioN++
					// Content-Range: bytes 0-0/12345  → 12345
					if cr := resp.Header.Get("Content-Range"); cr != "" {
						if i := bytes.LastIndexByte([]byte(cr), '/'); i >= 0 {
							fmt.Sscanf(cr[i+1:], "%d", &r.AudioSize)
						}
					}
				}
			}
		}
		rows = append(rows, r)
	}
	out := fmt.Sprintf("host: %s\ntotal: %d  envelope: %d  audio: %d  queued: %d  invalid: %d\n\n",
		base, len(cids), envN, audioN, queuedN, invalidN)
	for _, r := range rows {
		// Reject malformed CIDs up front — they were never sent to the
		// server in the first place, so flag them distinctly.
		if !validCID(r.CID) {
			out += fmt.Sprintf("  XXX  %s  (invalid CID)\n", r.CID)
			continue
		}
		flags := ""
		if r.Envelope {
			flags += "E"
		} else {
			flags += "-"
		}
		if r.Audio {
			flags += "A"
		} else {
			flags += "-"
		}
		if r.Queued {
			flags += "Q"
		} else {
			flags += "-"
		}
		size := ""
		if r.AudioSize > 0 {
			size = fmt.Sprintf("  %d B", r.AudioSize)
		}
		out += fmt.Sprintf("  %s  %s%s\n", flags, r.CID, size)
	}
	out += "\nlegend: E=envelope sealed  A=audio rendered  Q=in rebuild queue  XXX=invalid CID\n"
	return mcp.NewToolResultText(out), nil
}

func handleMuteTrack(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	netId, _ := req.GetArguments()["netId"].(string)
	if netId == "" {
		return mcp.NewToolResultError("netId is required"), nil
	}
	muted := true
	if v, ok := req.GetArguments()["muted"].(bool); ok {
		muted = v
	}

	body := map[string]interface{}{"netId": netId, "muted": muted}
	_, err := apiCall("POST", "/api/mute", body)
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}

	action := "Muted"
	if !muted {
		action = "Unmuted"
	}
	return mcp.NewToolResultText(fmt.Sprintf("%s track: %s", action, netId)), nil
}
