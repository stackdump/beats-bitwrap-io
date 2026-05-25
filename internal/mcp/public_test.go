package mcp

import (
	"sort"
	"testing"
)

// The public MCP server (mounted at /mcp on production beats.bitwrap.io) must
// expose only stateless generate/read tools — never sequencer control or
// rebuild/archive tools. This guards that security property against accidental
// additions to NewPublicServer.
func TestPublicServerToolset(t *testing.T) {
	tools := NewPublicServer().ListTools()

	got := make([]string, 0, len(tools))
	for name := range tools {
		got = append(got, name)
	}
	sort.Strings(got)

	want := []string{"generate_share", "get_song", "list_genres"}
	if len(got) != len(want) {
		t.Fatalf("public tool set = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("public tool set = %v, want %v", got, want)
		}
	}

	forbidden := []string{
		"transport", "set_tempo", "mute_track", "set_instrument",
		"generate", "load_project", "get_project", "shuffle_instruments",
		"get_midi_routing", "rebuild_mark", "rebuild_clear", "rebuild_queue",
		"archive_lookup", "archive_missing", "collection_status",
	}
	for _, f := range forbidden {
		if _, ok := tools[f]; ok {
			t.Errorf("control/admin tool %q must NOT be exposed in the public MCP set", f)
		}
	}
}

// The full server (stdio + authoring HTTP) keeps the control tools and also
// gains generate_share.
func TestFullServerHasControlAndShare(t *testing.T) {
	tools := NewServer().ListTools()
	for _, name := range []string{"transport", "generate", "generate_share", "list_genres"} {
		if _, ok := tools[name]; !ok {
			t.Errorf("full server missing expected tool %q", name)
		}
	}
}
