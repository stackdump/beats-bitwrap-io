package audiorender

// Curated master-chain presets. Author-supplied chains override.
// Values picked from standard mastering practice — tight low end +
// gentle bus comp + tilt EQ + final limiter for "club"; longer
// release / lighter ratios for "broadcast"; preserve crest factor
// for "ambient"; tape-flavoured tilt for "lofi".
//
// Each preset returns the chain in canonical order (highpass →
// compress → eq → limiter → stereoWiden) so applyMasterChain doesn't
// emit the non-canonical-order warning. PresetChain is also called
// from the CLI when the envelope sets only `master.preset` and
// leaves `master.chain` empty.

import "strings"

// PresetChain returns the canonical chain for a named preset.
// Unknown name → nil (caller should fall back to no chain).
func PresetChain(name string) []ChainStep {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "club":
		return []ChainStep{
			{Type: "highpass", Freq: 30},
			{Type: "compress", Threshold: -12, Ratio: 2.5, Attack: 10, Release: 120, Makeup: 2},
			{Type: "eq", Tilt: -0.5, Presence: 1.0},
			{Type: "limiter", Ceiling: -1.0},
			{Type: "stereoWiden", Amount: 0.15},
		}
	case "broadcast":
		return []ChainStep{
			{Type: "highpass", Freq: 40},
			{Type: "compress", Threshold: -18, Ratio: 1.6, Attack: 20, Release: 200, Makeup: 1},
			{Type: "eq", Presence: 0.5},
			{Type: "limiter", Ceiling: -2.0},
		}
	case "ambient":
		return []ChainStep{
			{Type: "highpass", Freq: 20},
			{Type: "compress", Threshold: -22, Ratio: 1.3, Attack: 40, Release: 400, Makeup: 0.5},
			{Type: "eq", Tilt: 0.5},
			{Type: "limiter", Ceiling: -1.5},
			{Type: "stereoWiden", Amount: 0.25},
		}
	case "lofi":
		return []ChainStep{
			{Type: "highpass", Freq: 60},
			{Type: "compress", Threshold: -14, Ratio: 3.0, Attack: 15, Release: 80, Makeup: 2},
			{Type: "eq", Tilt: 1.5, Presence: -1.5},
			{Type: "limiter", Ceiling: -1.0},
		}
	}
	return nil
}
