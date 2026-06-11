package generator

import (
	"reflect"
	"testing"
)

// Pinned motif vector for BuildTrackTheme("techno", 42). The same vector
// MUST come out of public/lib/generator/theme.js::buildTrackTheme("techno",
// 42) — see public/lib/generator/theme.parity.test.html for the browser-
// side assertion. Drift between these two fixtures means a future shared
// `cohesion: "v2"` envelope will play one motif on local authoring (Go) and
// a different motif on prod static-host playback (JS). The whole point of
// the field is byte-equivalent reproduction.
//
// To regenerate after intentional algorithm changes:
//   1. Update generateMotif in theme.go (and the matching JS port).
//   2. Run this test once with a temporary print to capture the new vector.
//   3. Paste the new vector into BOTH this file and the JS test fixture.
//   4. Confirm both sides agree.
var pinnedTechno42Motif = MotifCell{
	Degrees: []int{
		0, -1, -1, 0, 0, -1, -1, -1, 0, -1, -1, 0, 0, -1, -1, -1,
		1, -1, -1, -1, 1, -1, 0, 0, 1, -1, -1, 0, 1, 1, -1, -1,
		0, -1, -1, -1, 0, -1, -1, -1, 0, -1, 2, 0, 0, -1, -1, 0,
		1, 0, -1, 2, 3, -1, -1, -1, 3, -1, 5, -1, 6, 0, -1, -1,
	},
	Mask: []bool{
		true, false, false, true, true, false, false, false, true, false, false, true, true, false, false, false,
		true, false, false, false, true, false, true, true, true, false, false, true, true, true, false, false,
		true, false, false, false, true, false, false, false, true, false, true, true, true, false, false, true,
		true, true, false, true, true, false, false, false, true, false, true, false, true, true, false, false,
	},
	Contour: 0,
}

func TestPinnedMotifVectorTechnoSeed42(t *testing.T) {
	got := BuildTrackTheme("techno", 42).Motif
	if !reflect.DeepEqual(got, pinnedTechno42Motif) {
		t.Fatalf("motif drift — Go side differs from pinned fixture.\n"+
			" got.Degrees=%v\nwant.Degrees=%v\n"+
			" got.Mask=%v\nwant.Mask=%v\n"+
			" got.Contour=%d want.Contour=%d\n\n"+
			"If this drift was intentional, also update the JS fixture in "+
			"public/lib/generator/theme.parity.test.html and rerun the JS "+
			"parity test — the two MUST stay in lockstep.",
			got.Degrees, pinnedTechno42Motif.Degrees,
			got.Mask, pinnedTechno42Motif.Mask,
			got.Contour, pinnedTechno42Motif.Contour)
	}
}
