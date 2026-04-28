package audiorender

import "strings"

// MasterTarget is the per-genre loudnorm target. Zero LUFS means
// "use the global default"; the renderer falls back to
// Config.LoudnormTargetLUFS / LRA=11 when a genre has no entry.
type MasterTarget struct {
	LUFS float64
	LRA  float64
}

// genreMastering tunes the loudnorm pass per genre. Three buckets:
//
//   - Spacious / acoustic / restrained (ambient, lofi, jazz, blues,
//     bossa, country, reggae): −18 LUFS / LRA=15. Preserves crest
//     and dynamics; aiming hotter would squash the things that
//     make these genres readable.
//   - Club / driving (techno, house, trance, garage, edm, dnb,
//     dubstep, trap, speedcore): −14 LUFS / LRA=7. Streaming-tier
//     loud, tight LRA matching how DJs actually master these.
//   - Aggressive / mid-density (metal, funk, synthwave): −15 LUFS
//     / LRA=9. Between the two — needs presence without losing
//     all the punch.
//
// Anything not in the table falls back to the global default
// (currently −16 LUFS / LRA=11). New genres start there until we
// have analyzer data on them.
//
// Tuning rationale: LUFS targets follow streaming-platform norms
// scaled by genre intuition; LRA values come from common
// mastering-engineer guidance (Bob Katz K-system, 2014 EBU LRA
// recommendations) cross-referenced with what loudnorm's single-pass
// dynamic mode reliably hits.
var genreMastering = map[string]MasterTarget{
	// Spacious bucket
	"ambient":  {LUFS: -18, LRA: 15},
	"lofi":     {LUFS: -18, LRA: 15},
	"jazz":     {LUFS: -18, LRA: 15},
	"blues":    {LUFS: -18, LRA: 15},
	"bossa":    {LUFS: -18, LRA: 15},
	"country":  {LUFS: -18, LRA: 14},
	"reggae":   {LUFS: -17, LRA: 13},

	// Club / driving bucket
	"techno":    {LUFS: -14, LRA: 7},
	"house":     {LUFS: -14, LRA: 7},
	"trance":    {LUFS: -14, LRA: 7},
	"garage":    {LUFS: -14, LRA: 7},
	"edm":       {LUFS: -14, LRA: 7},
	"dnb":       {LUFS: -14, LRA: 7},
	"dubstep":   {LUFS: -13, LRA: 6},
	"trap":      {LUFS: -13, LRA: 6},
	"speedcore": {LUFS: -13, LRA: 5},

	// Mid bucket
	"metal":     {LUFS: -14, LRA: 8},
	"funk":      {LUFS: -15, LRA: 9},
	"synthwave": {LUFS: -15, LRA: 9},
}

// MasteringFor returns the per-genre target, or the zero MasterTarget
// when the genre is unmapped. Genre matching is case-insensitive and
// trimmed; consumers should fall back to their own default on zero.
func MasteringFor(genre string) MasterTarget {
	return genreMastering[strings.ToLower(strings.TrimSpace(genre))]
}
