package audiorender

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
)

// LoudnormResult is the parsed JSON ffmpeg's loudnorm filter prints
// when invoked with print_format=json. Captures both the measurement
// of the input and (implicitly, via the second pass we don't run)
// what it tried to hit. Single-pass dynamic mode — fast, "good
// enough" for our streaming-tier target. Two-pass would buy ~1 LU of
// precision at the cost of doubling render time; not worth it.
type LoudnormResult struct {
	InputI      float64 `json:"input_i"`
	InputTP     float64 `json:"input_tp"`
	InputLRA    float64 `json:"input_lra"`
	InputThresh float64 `json:"input_thresh"`
	OutputI     float64 `json:"output_i"`
	OutputTP    float64 `json:"output_tp"`
	OutputLRA   float64 `json:"output_lra"`
	OutputThresh float64 `json:"output_thresh"`
	NormalizationType string `json:"normalization_type"`
	TargetOffset      float64 `json:"target_offset"`
}

var loudnormJSON = regexp.MustCompile(`(?s)\{\s*"input_i"[^}]*\}`)

// loudnorm runs a single-pass ffmpeg loudnorm filter on src, writing
// a normalized .webm to dst. Returns the parsed measurement if
// ffmpeg's stderr included the JSON block; otherwise returns
// non-nil without metrics. Error means ffmpeg itself failed and
// the dst file should be discarded by the caller.
//
// targetI = integrated LUFS target (e.g. −16). truePeak ≤ 0 → −1.0
// dBTP. lra = loudness range cap (LU); ≤0 → 11 (loudnorm's pop
// default). Use lower lra (~7) for genres that want squash, higher
// (~15) for genres that need air.
func loudnorm(ctx context.Context, ffmpegPath, src, dst string, targetI, truePeak, lra float64) (*LoudnormResult, error) {
	bin := ffmpegPath
	if bin == "" {
		bin = "ffmpeg"
	}
	if truePeak >= 0 {
		// Sentinel: only treat negative truePeak as a real value (a
		// dBTP ceiling is always ≤ 0). 0 or positive → use the safe
		// streaming default.
		truePeak = -1.0
	}
	if lra <= 0 {
		lra = 11
	}
	filter := fmt.Sprintf(
		"loudnorm=I=%.2f:TP=%.2f:LRA=%.2f:print_format=json",
		targetI, truePeak, lra,
	)
	args := []string{
		"-y", "-hide_banner", "-nostats", "-loglevel", "info",
		"-i", src,
		"-af", filter,
		"-c:a", "libopus",
		"-b:a", "96k",
		"-vbr", "on",
		"-f", "webm",
		dst,
	}
	cmd := exec.CommandContext(ctx, bin, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("ffmpeg loudnorm: %w (%s)", err, tail(string(out), 400))
	}
	// loudnorm prints its measurement JSON on stderr (combined into
	// out by CombinedOutput). Best-effort extract; the file is
	// already normalized regardless.
	m := loudnormJSON.FindString(string(out))
	if m == "" {
		return nil, nil
	}
	var res LoudnormResult
	// Tolerate "inf" / "-inf" / quoted floats by sanitizing first.
	cleaned := sanitizeLoudnormJSON(m)
	if err := json.Unmarshal([]byte(cleaned), &res); err != nil {
		return nil, nil
	}
	return &res, nil
}

// sanitizeLoudnormJSON unquotes the float-shaped string values
// loudnorm emits ("-23.5") and replaces "inf"/"-inf"/"nan" with
// JSON-safe stand-ins (0). Without this, encoding/json refuses the
// document and we lose the metrics.
func sanitizeLoudnormJSON(s string) string {
	out := s
	// Replace inf/nan tokens (with or without quotes) with 0.
	for _, tok := range []string{`"inf"`, `"-inf"`, `"nan"`, "inf", "-inf", "nan"} {
		out = strings.ReplaceAll(out, ": "+tok, ": 0")
	}
	// Unquote string-shaped floats: "-23.5" → -23.5. loudnorm always
	// emits these as strings, but Go's json wants raw numbers for
	// float64. Walk char-by-char so we only unquote values, not keys.
	out = unquoteNumericStrings(out)
	return out
}

func unquoteNumericStrings(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	i := 0
	for i < len(s) {
		c := s[i]
		if c == ':' {
			b.WriteByte(c)
			i++
			// skip spaces
			for i < len(s) && (s[i] == ' ' || s[i] == '\n' || s[i] == '\t') {
				b.WriteByte(s[i])
				i++
			}
			if i < len(s) && s[i] == '"' {
				// look ahead to next quote
				j := i + 1
				for j < len(s) && s[j] != '"' {
					j++
				}
				if j < len(s) {
					inner := s[i+1 : j]
					if isNumeric(inner) {
						b.WriteString(inner)
						i = j + 1
						continue
					}
				}
			}
			continue
		}
		b.WriteByte(c)
		i++
	}
	return b.String()
}

func isNumeric(s string) bool {
	if s == "" {
		return false
	}
	_, err := strconv.ParseFloat(s, 64)
	return err == nil
}

func tail(s string, n int) string {
	if len(s) <= n {
		return strings.TrimSpace(s)
	}
	return strings.TrimSpace(s[len(s)-n:])
}
