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

// apiCall makes a request to the petri-note HTTP server.
func apiCall(method, path string, body interface{}) (json.RawMessage, error) {
	var reqBody io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reqBody = bytes.NewReader(data)
	}

	base := baseURL()
	req, err := http.NewRequest(method, base+path, reqBody)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("petri-note server not reachable at %s: %v", base, err)
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

	return server.ServeStdio(s)
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
