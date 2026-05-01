package audiorender

// Master FX chain. Slots between the timeline assembly and the
// loudnorm pass: shapes timbre + glues the mix; loudnorm rides the
// final level afterwards. v1 supports five step types — highpass,
// compress, eq (tilt + presence), limiter, stereoWiden — all of
// which compile to single ffmpeg filter fragments and are present in
// stock ffmpeg builds. Author-supplied chains are passed through in
// declared order (we do NOT reorder); preset expansion always emits
// the canonical order [hp → comp → eq → lim → wide].

import (
	"context"
	"fmt"
	"log"
	"math"
	"os/exec"
	"strings"
)

// ChainStep is a tagged-union of every master-chain step. Each step
// only reads the params relevant to its Type; unrelated fields are
// ignored. Numeric params are zero-defaulted so a minimal step like
// `{Type: "highpass"}` compiles with sensible defaults.
type ChainStep struct {
	Type string

	// highpass
	Freq float64

	// compress (acompressor)
	Threshold float64 // dB
	Ratio     float64
	Attack    float64 // ms
	Release   float64 // ms
	Makeup    float64 // dB

	// eq (paired bass/treble shelves + 4 kHz peaking)
	Tilt     float64 // dB; positive = darker (bass up, treble down)
	Presence float64 // dB at 4 kHz peaking

	// limiter (alimiter)
	Ceiling float64 // dBTP, ≤ 0

	// stereoWiden (extrastereo)
	Amount float64 // 0..1.5
}

// applyMasterChain runs the configured filter graph on src, writing
// chained PCM at dst. Empty chain → pass-through copy. A failed step
// is logged and skipped (mirroring the rubberband fallback in
// composition.go); only a total ffmpeg invocation failure bubbles up.
// The signature mirrors loudnormToWav so it slots cleanly between
// assembleTimeline and the existing loudnorm pass.
func applyMasterChain(ctx context.Context, ffmpegPath, src, dst string, chain []ChainStep) error {
	if len(chain) == 0 {
		return copyFile(src, dst)
	}
	parts := make([]string, 0, len(chain))
	for _, step := range chain {
		frag, err := compileChainStep(step)
		if err != nil {
			log.Printf("audiorender/composition: skipping master chain step %q: %v", step.Type, err)
			continue
		}
		parts = append(parts, frag)
	}
	if len(parts) == 0 {
		return copyFile(src, dst)
	}
	if !canonicalOrder(chain) {
		log.Printf("audiorender/composition: master chain in non-canonical order — preset chains are emitted as hp→comp→eq→lim→wide; author chains are passed through as-is")
	}
	bin := ffmpegPath
	if bin == "" {
		bin = "ffmpeg"
	}
	args := []string{
		"-y", "-loglevel", "error",
		"-i", src,
		"-af", strings.Join(parts, ","),
		"-c:a", "pcm_s16le",
		"-ar", "48000",
		"-ac", "2",
		dst,
	}
	cmd := exec.CommandContext(ctx, bin, args...)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("ffmpeg master chain: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// compileChainStep turns a ChainStep into one ffmpeg `-af` fragment.
// Every fragment is self-contained — no semicolons, no labels — so
// the caller can join them with commas to form one filter chain.
// Out-of-range params are clamped or rejected (returns error) so a
// downstream filter can't blow up mid-pipeline with a parse error.
func compileChainStep(s ChainStep) (string, error) {
	switch s.Type {
	case "highpass":
		freq := s.Freq
		if freq <= 0 {
			freq = 30
		}
		if freq < 10 || freq > 500 {
			return "", fmt.Errorf("highpass freq %v out of range [10, 500]", freq)
		}
		return fmt.Sprintf("highpass=f=%.2f:p=2", freq), nil

	case "compress":
		// acompressor's threshold is a LINEAR amplitude (0..1), not dB.
		// Convert: thr_lin = 10^(dB/20). Sensible defaults for a
		// gentle bus comp; aggressive presets override.
		threshDB := s.Threshold
		if threshDB == 0 {
			threshDB = -18
		}
		if threshDB < -60 || threshDB > 0 {
			return "", fmt.Errorf("compress threshold %v dB out of range [-60, 0]", threshDB)
		}
		ratio := s.Ratio
		if ratio <= 0 {
			ratio = 2
		}
		if ratio < 1 || ratio > 20 {
			return "", fmt.Errorf("compress ratio %v out of range [1, 20]", ratio)
		}
		attack := s.Attack
		if attack <= 0 {
			attack = 20
		}
		release := s.Release
		if release <= 0 {
			release = 250
		}
		makeup := s.Makeup
		if makeup < 0 {
			makeup = 0
		}
		thrLin := math.Pow(10, threshDB/20)
		return fmt.Sprintf(
			"acompressor=threshold=%.6f:ratio=%.4f:attack=%.4f:release=%.4f:makeup=%.4f:knee=2.82843:detection=rms",
			thrLin, ratio, attack, release, makeup,
		), nil

	case "eq":
		// Tilt is implemented as paired symmetric shelves so a single
		// "tilt" knob brightens or darkens the entire spectrum without
		// changing perceived loudness too much. Presence is a 4 kHz
		// peaking EQ; positive = forward, negative = recessed. Either
		// can be omitted (zero) to disable that half.
		var frags []string
		if s.Tilt != 0 {
			if s.Tilt < -6 || s.Tilt > 6 {
				return "", fmt.Errorf("eq tilt %v dB out of range [-6, 6]", s.Tilt)
			}
			frags = append(frags,
				fmt.Sprintf("bass=g=%.4f:f=120:width_type=h:width=1.5", s.Tilt),
				fmt.Sprintf("treble=g=%.4f:f=8000:width_type=h:width=1.5", -s.Tilt),
			)
		}
		if s.Presence != 0 {
			if s.Presence < -6 || s.Presence > 6 {
				return "", fmt.Errorf("eq presence %v dB out of range [-6, 6]", s.Presence)
			}
			frags = append(frags,
				fmt.Sprintf("equalizer=f=4000:width_type=q:w=1.0:g=%.4f", s.Presence),
			)
		}
		if len(frags) == 0 {
			return "", fmt.Errorf("eq step has zero tilt and zero presence — nothing to do")
		}
		return strings.Join(frags, ","), nil

	case "limiter":
		ceilDB := s.Ceiling
		if ceilDB == 0 {
			ceilDB = -1.0
		}
		if ceilDB < -6 || ceilDB > 0 {
			return "", fmt.Errorf("limiter ceiling %v dBTP out of range [-6, 0]", ceilDB)
		}
		ceilLin := math.Pow(10, ceilDB/20)
		return fmt.Sprintf("alimiter=limit=%.6f:attack=5:release=50", ceilLin), nil

	case "stereoWiden":
		amt := s.Amount
		if amt <= 0 {
			amt = 0.2
		}
		if amt > 1.5 {
			amt = 1.5
		}
		// extrastereo's m multiplier is 1 + amount: amount=0.2 → m=1.2
		// (subtle wider), amount=1.0 → m=2.0 (aggressive).
		return fmt.Sprintf("extrastereo=m=%.4f:c=disabled", 1.0+amt), nil
	}
	return "", fmt.Errorf("unknown master-chain step type %q", s.Type)
}

// canonicalOrder reports whether chain follows the documented
// hp→compress→eq→limiter→stereoWiden ordering. Used only to emit a
// soft warning — author chains are passed through as declared.
func canonicalOrder(chain []ChainStep) bool {
	rank := map[string]int{
		"highpass":    1,
		"compress":    2,
		"eq":          3,
		"limiter":     4,
		"stereoWiden": 5,
	}
	prev := 0
	for _, s := range chain {
		r, ok := rank[s.Type]
		if !ok {
			continue
		}
		if r < prev {
			return false
		}
		prev = r
	}
	return true
}
