package card

import (
	"fmt"
	"image/color"
	"sync"

	"golang.org/x/image/font"
	"golang.org/x/image/font/gofont/gobold"
	"golang.org/x/image/font/gofont/gomono"
	"golang.org/x/image/font/gofont/gomonobold"
	"golang.org/x/image/font/gofont/goregular"
	"golang.org/x/image/font/opentype"
)

// The card's look: a near-black blue-grey code stage with btw's own accents (teal, violet, rose),
// not beats' waveform palette. Every colour is a constant so the image is a pure function of its input.

func rgb(hex uint32) color.NRGBA {
	return color.NRGBA{R: uint8(hex >> 16), G: uint8(hex >> 8), B: uint8(hex), A: 255}
}

func alpha(c color.NRGBA, a float64) color.NRGBA {
	if a < 0 {
		a = 0
	}
	if a > 1 {
		a = 1
	}
	c.A = uint8(a*255 + 0.5)
	return c
}

var (
	colBG0    = rgb(0x070b12) // outer ground, top
	colBG1    = rgb(0x0b111c) // outer ground, bottom
	colStage  = rgb(0x0e1522) // the code stage
	colEdge   = rgb(0x1d2a42) // stage outline
	colRule   = rgb(0x182236) // hairlines
	colText   = rgb(0xe6ecf5) // titles
	colSub    = rgb(0x8d9bb5) // secondary text
	colDim    = rgb(0x66768f) // tertiary text, line numbers
	colAccent = rgb(0x5eead4) // btw teal
	colGreen  = rgb(0x4ade80) // "playing" gutter dot
	colAmber  = rgb(0xffb020) // lamps and the bright gutter dot
	colAmberT = rgb(0xffe3a6) // a lit token
	colBlock  = rgb(0x16213a) // an idle timeline block
	colBlockT = rgb(0x93a3bf) // its name
)

// syntax colours by the class names btwd highlight / btw_highlight answer (the djlive classes, lower case, plus
// the spellings DESIGN.md lists). Unknown classes read as plain words.
var classColour = map[string]color.NRGBA{
	"comment":   rgb(0x7487a6),
	"keyword":   rgb(0xc4a7ff),
	"role":      rgb(0x5eead4),
	"action":    rgb(0x7db8ff),
	"verb":      rgb(0x7db8ff),
	"deck":      rgb(0xff8aa1),
	"number":    rgb(0xf4c27a),
	"step":      rgb(0xa8e6a1),
	"note":      rgb(0xa8e6a1),
	"rest":      rgb(0x62759a),
	"generator": rgb(0xf7b4d6),
	"param":     rgb(0x9fb6d8),
	"operator":  rgb(0x93a3bf),
	"op":        rgb(0x93a3bf),
	"punct":     rgb(0x93a3bf),
	"word":      rgb(0xd3dbe8),
	"string":    rgb(0xa8e6a1),
	"error":     rgb(0xff6b6b),
}

var colWord = classColour["word"]

func colourOf(class string) color.NRGBA {
	if c, ok := classColour[class]; ok {
		return c
	}
	return colWord
}

// ---- fonts ----------------------------------------------------------------------------------------------

type fontKind int

const (
	fMono fontKind = iota
	fMonoBold
	fSans
	fSansBold
)

// Parsed fonts are safe to share; a face (its glyph buffer) is not, so each render builds its own faces
// (the approach internal/share/share_card_png.go takes).
var (
	fontsOnce sync.Once
	fonts     [4]*opentype.Font
	fontsErr  error
)

func parseFonts() {
	for i, ttf := range [][]byte{gomono.TTF, gomonobold.TTF, goregular.TTF, gobold.TTF} {
		f, err := opentype.Parse(ttf)
		if err != nil {
			fontsErr = err
			return
		}
		fonts[i] = f
	}
}

type faceKey struct {
	k fontKind
	s float64
}

// faceSet is one render's faces.
type faceSet struct {
	m map[faceKey]font.Face
}

func newFaceSet() *faceSet { return &faceSet{m: map[faceKey]font.Face{}} }

func (fs *faceSet) face(k fontKind, size float64) (font.Face, error) {
	fontsOnce.Do(parseFonts)
	if fontsErr != nil {
		return nil, fontsErr
	}
	key := faceKey{k, size}
	if f, ok := fs.m[key]; ok {
		return f, nil
	}
	f, err := opentype.NewFace(fonts[k], &opentype.FaceOptions{Size: size, DPI: 72, Hinting: font.HintingFull})
	if err != nil {
		return nil, fmt.Errorf("card: font face: %w", err)
	}
	fs.m[key] = f
	return f, nil
}

func (fs *faceSet) close() {
	for _, f := range fs.m {
		_ = f.Close()
	}
}

// ---- a seeded PRNG ----------------------------------------------------------------------------------------

// rng is splitmix64: tiny, fixed forever (math/rand's stream is not a promise), seeded from the CID's bytes.
type rng struct{ s uint64 }

func newRNG(seed string) *rng {
	// FNV-1a 64 over the bytes, then one splitmix step so close seeds diverge at once.
	h := uint64(14695981039346656037)
	for i := 0; i < len(seed); i++ {
		h ^= uint64(seed[i])
		h *= 1099511628211
	}
	r := &rng{s: h}
	r.next()
	return r
}

func (r *rng) next() uint64 {
	r.s += 0x9e3779b97f4a7c15
	z := r.s
	z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9
	z = (z ^ (z >> 27)) * 0x94d049bb133111eb
	return z ^ (z >> 31)
}

// intn is in [0, n).
func (r *rng) intn(n int) int {
	if n <= 1 {
		return 0
	}
	return int(r.next() % uint64(n))
}

// float is in [0, 1).
func (r *rng) float() float64 { return float64(r.next()>>11) / (1 << 53) }
