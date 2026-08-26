// Command parity is the Go half of the live Go↔JS model-CID parity
// harness (go-pflow ROADMAP Phase 3: direct parity diff in Bazel).
//
// It reads a model JSON file, parses it through the LIVE production path
// (pflow.ParseProject) and prints the canonical CID JSON plus the CID —
// the exact bytes internal/pflow/cid.go hashes. The JS runner
// (tools/parity/model-cid-parity.mjs) produces the same two lines from
// public/lib/pflow.js and diffs them byte-for-byte, so any drift in the
// parse → normalize → hash path — including the beat-relative
// durationSteps-vs-legacy-ms canonical-form rule — fails the build.
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"beats-bitwrap-io/internal/pflow"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintf(os.Stderr, "usage: %s <model.json>\n", os.Args[0])
		os.Exit(2)
	}
	raw, err := os.ReadFile(os.Args[1])
	if err != nil {
		fmt.Fprintf(os.Stderr, "read %s: %v\n", os.Args[1], err)
		os.Exit(1)
	}
	var data map[string]interface{}
	if err := json.Unmarshal(raw, &data); err != nil {
		fmt.Fprintf(os.Stderr, "parse %s: %v\n", os.Args[1], err)
		os.Exit(1)
	}
	proj := pflow.ParseProject(data)
	canon, err := proj.CanonicalJSON()
	if err != nil {
		fmt.Fprintf(os.Stderr, "canonicalize: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("%s\ncid:%s\n", canon, proj.CID())
}
