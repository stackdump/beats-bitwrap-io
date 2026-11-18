package card

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"math"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/fogleman/gg"
	"golang.org/x/image/font"
	"golang.org/x/image/math/fixed"

	"beats-bitwrap-io/internal/btwsite/api"
)

// Variant is a card's size.
type Variant int

const (
	// Wide is the 1200x630 link-preview card (og:image).
	Wide Variant = iota
	// Square is the 1080x1080 card for feeds.
	Square
)

func (v Variant) String() string {
	if v == Square {
		return "square"
	}
	return "wide"
}

// Size is the pixel size.
func (v Variant) Size() (w, h int) {
	if v == Square {
		return 1080, 1080
	}
	return 1200, 630
}

// content is everything the image is drawn from (nothing else: the card is a pure function of it).
type content struct {
	Seed      string // seeds the markers: the CID
	CID       string
	Name      string
	License   string
	Canonical string
	Spans     []api.Span
	Lines     []rline // set: show exactly these lines (the generic card); else the region is picked
	Section   string  // the section the region came from
	Tempo     float64
	Key       string
	Bars      int
	Seconds   float64
	Sections  []api.Section
	Generic   bool
}

type layout struct {
	W, H, M              float64
	nameSize, nameBase   float64
	brandSize, brandBase float64
	stageY, stageH       float64
	tlY, tlH             float64
	tlFont               float64
	factsBase, factsRow2 float64
	valSize, unitSize    float64
	badgeSize, cidSize   float64
	codeSizes            []float64
	lhMul                float64
	gutter               float64 // code starts this far inside the stage
	pad                  float64
	twoRowFacts          bool
	bigName              bool
}

func layoutFor(v Variant) layout {
	if v == Square {
		return layout{
			W: 1080, H: 1080, M: 56,
			brandSize: 22, brandBase: 82,
			nameSize: 58, nameBase: 158,
			stageY: 196, stageH: 604,
			tlY: 826, tlH: 58, tlFont: 18,
			factsBase: 962, factsRow2: 1020,
			valSize: 44, unitSize: 22, badgeSize: 20, cidSize: 22,
			codeSizes: []float64{28, 27, 26, 25, 24, 23, 22},
			lhMul:     1.5, gutter: 86, pad: 22, twoRowFacts: true,
		}
	}
	return layout{
		W: 1200, H: 630, M: 44,
		brandSize: 20, brandBase: 62,
		nameSize: 36, nameBase: 66,
		stageY: 92, stageH: 372,
		tlY: 486, tlH: 38, tlFont: 15,
		factsBase: 584,
		valSize:   30, unitSize: 17, badgeSize: 16, cidSize: 19,
		codeSizes: []float64{25, 24, 23, 22, 21, 20, 19},
		lhMul:     1.36, gutter: 78, pad: 16,
	}
}

// painter bundles the gg context and the render's faces.
type painter struct {
	dc  *gg.Context
	img *image.RGBA
	fs  *faceSet
}

func (p *painter) setFace(k fontKind, size float64) font.Face {
	f, err := p.fs.face(k, size)
	if err != nil {
		panic(err) // recovered in drawCard
	}
	p.dc.SetFontFace(f)
	return f
}

// text draws s with its baseline at y, straight into the pixels (gg's DrawString runs every glyph through a
// general image transform, which is several times slower).
func (p *painter) text(k fontKind, size, x, y float64, c color.NRGBA, s string) {
	f, err := p.fs.face(k, size)
	if err != nil {
		panic(err)
	}
	d := font.Drawer{Dst: p.img, Src: image.NewUniform(c), Face: f,
		Dot: fixed.Point26_6{X: fixed.Int26_6(math.Round(x * 64)), Y: fixed.Int26_6(math.Round(y * 64))}}
	d.DrawString(s)
}

func (p *painter) width(k fontKind, size float64, s string) float64 {
	f := p.setFace(k, size)
	return float64(font.MeasureString(f, s)) / 64
}

// ellipsize shortens s to fit width.
func (p *painter) ellipsize(k fontKind, size, width float64, s string) string {
	if p.width(k, size, s) <= width {
		return s
	}
	r := []rune(s)
	for len(r) > 1 {
		r = r[:len(r)-1]
		t := strings.TrimRight(string(r), " ") + "…"
		if p.width(k, size, t) <= width {
			return t
		}
	}
	return "…"
}

// drawCard renders c as a PNG.
func drawCard(c *content, v Variant) (out []byte, err error) {
	defer func() {
		if r := recover(); r != nil {
			if e, ok := r.(error); ok {
				err = e
				return
			}
			panic(r)
		}
	}()
	L := layoutFor(v)
	W, H := v.Size()
	img := cachedBackground(W, H)
	p := &painter{dc: gg.NewContextForRGBA(img), img: img, fs: newFaceSet()}
	defer p.fs.close()
	r := newRNG(c.Seed)

	p.header(c, L)
	p.stage(c, L, r)
	p.timeline(c, L, r)
	p.facts(c, L)

	// BestSpeed: the default level is half again slower for 25% fewer bytes, and BestCompression is 40x slower
	var buf bytes.Buffer
	enc := png.Encoder{CompressionLevel: png.BestSpeed}
	if err := enc.Encode(&buf, p.dc.Image()); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

var (
	bgMu    sync.Mutex
	bgCache = map[[2]int]*image.RGBA{}
)

// cachedBackground is a fresh copy of the ground for a size (painted once per process).
func cachedBackground(W, H int) *image.RGBA {
	bgMu.Lock()
	base, ok := bgCache[[2]int{W, H}]
	if !ok {
		base = background(W, H)
		bgCache[[2]int{W, H}] = base
	}
	bgMu.Unlock()
	img := image.NewRGBA(base.Rect)
	copy(img.Pix, base.Pix)
	return img
}

// background paints the ground straight into the pixels (a vertical gradient and two soft blooms): far cheaper
// than gg's per-pixel gradient patterns, and the same bytes every time.
func background(W, H int) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, W, H))
	type bloom struct {
		x, y, r float64
		c       color.NRGBA
		a       float64
	}
	blooms := []bloom{
		{float64(W) - 40, 0, float64(W) * 0.55, colAccent, 0.07}, // teal, behind the brand corner
		{0, float64(H), float64(W) * 0.5, rgb(0x7c5cff), 0.06},   // violet, low on the left
	}
	for y := 0; y < H; y++ {
		t := float64(y) / float64(H-1)
		br := float64(colBG0.R)*(1-t) + float64(colBG1.R)*t
		bg := float64(colBG0.G)*(1-t) + float64(colBG1.G)*t
		bb := float64(colBG0.B)*(1-t) + float64(colBG1.B)*t
		for x := 0; x < W; x++ {
			r, g, b := br, bg, bb
			for _, bl := range blooms {
				d := math.Hypot(float64(x)-bl.x, float64(y)-bl.y) / bl.r
				if d >= 1 {
					continue
				}
				a := bl.a * (1 - d)
				r += (float64(bl.c.R) - r) * a
				g += (float64(bl.c.G) - g) * a
				b += (float64(bl.c.B) - b) * a
			}
			i := img.PixOffset(x, y)
			img.Pix[i], img.Pix[i+1], img.Pix[i+2], img.Pix[i+3] = uint8(r+0.5), uint8(g+0.5), uint8(b+0.5), 255
		}
	}
	return img
}

// petriMark draws the brand glyph: place - transition - place.
func (p *painter) petriMark(x, y float64) float64 {
	dc := p.dc
	dc.SetColor(colAccent)
	dc.SetLineWidth(2.2)
	dc.DrawCircle(x+7, y, 6.5)
	dc.Stroke()
	dc.DrawLine(x+13.5, y, x+22, y)
	dc.Stroke()
	dc.DrawRoundedRectangle(x+22, y-9, 5, 18, 1.5)
	dc.Fill()
	dc.DrawLine(x+27, y, x+35.5, y)
	dc.Stroke()
	dc.DrawCircle(x+42, y, 6.5)
	dc.Stroke()
	dc.DrawCircle(x+7, y, 2.4)
	dc.Fill()
	return 50
}

func (p *painter) header(c *content, L layout) {
	// brand, top right
	const site = "btw.bitwrap.io"
	sw := p.width(fSans, L.brandSize, site)
	p.text(fSans, L.brandSize, L.W-L.M-sw, L.brandBase, colSub, site)
	p.petriMark(L.W-L.M-sw-60, L.brandBase-L.brandSize*0.36)

	name := c.Name
	maxW := L.W - 2*L.M
	if L.twoRowFacts { // square: the name has its own row under the brand
		p.text(fSansBold, L.nameSize, L.M, L.nameBase, colText, p.ellipsize(fSansBold, L.nameSize, maxW, name))
		return
	}
	maxW -= sw + 60 + 36
	p.text(fSansBold, L.nameSize, L.M, L.nameBase, colText, p.ellipsize(fSansBold, L.nameSize, maxW, name))
}

// ---- the code stage -------------------------------------------------------------------------------------

type lamp struct{ line, col, n int }

func (p *painter) stage(c *content, L layout, r *rng) {
	dc := p.dc
	sx, sy, sw, sh := L.M, L.stageY, L.W-2*L.M, L.stageH
	dc.SetColor(colStage)
	dc.DrawRoundedRectangle(sx, sy, sw, sh, 16)
	dc.Fill()
	dc.SetColor(colEdge)
	dc.SetLineWidth(1.5)
	dc.DrawRoundedRectangle(sx+0.75, sy+0.75, sw-1.5, sh-1.5, 16)
	dc.Stroke()

	lines := c.Lines
	var classes []string
	var offsets []int
	canon := strings.Split(strings.TrimRight(c.Canonical, "\n"), "\n")
	if lines == nil {
		lines, c.Section = pickRegion(canon) // the timeline highlights the region's section
	}
	if len(c.Canonical) > 0 {
		classes = classAt(c.Canonical, c.Spans)
		off := 0
		for _, l := range strings.SplitAfter(c.Canonical, "\n") {
			offsets = append(offsets, off)
			off += len(l)
		}
	}
	if len(lines) == 0 {
		return
	}

	// ----- per-line prepared runes + classes
	type pline struct {
		rline
		runes []rune
		cls   []string // per rune
		trunc bool
	}
	prep := make([]pline, len(lines))
	for i, l := range lines {
		pl := pline{rline: l}
		raw := l.text
		pl.runes = []rune(cleanLine(raw))
		pl.cls = make([]string, len(pl.runes))
		if l.idx >= 0 && l.idx < len(offsets) && classes != nil && cleanLine(raw) == raw {
			base := offsets[l.idx]
			bi := 0
			for k, ru := range pl.runes {
				if base+bi < len(classes) {
					pl.cls[k] = classes[base+bi]
				}
				bi += utf8.RuneLen(ru)
			}
		}
		prep[i] = pl
	}
	rampLines := []int{}
	for i, pl := range prep {
		if pl.idx >= 0 && isRampLine(string(pl.runes)) {
			rampLines = append(rampLines, i)
		}
	}
	// the elided marker is dim
	for i := range prep {
		if prep[i].idx == -1 {
			for k := range prep[i].cls {
				prep[i].cls[k] = "comment"
			}
		}
	}

	codeW := sw - L.gutter - L.pad - 6
	// the largest code size whose lines fit the stage with at most a couple of them cut at the right edge; when
	// none does, the one that fits with the fewest cut.
	var size, lh, adv float64
	bestTrunc := -1
	for i, sz := range L.codeSizes {
		f := p.setFace(fMono, sz)
		a := float64(font.MeasureString(f, "0")) / 64
		maxCols := int(codeW / a)
		trunc := 0
		for _, pl := range prep {
			if len(pl.runes) > maxCols {
				trunc++
			}
		}
		l := math.Round(sz * L.lhMul)
		extra := 0.0
		for _, pl := range prep {
			if pl.gapTop {
				extra += l * 0.5
			}
		}
		if len(rampLines) > 0 {
			extra += 7
		}
		fits := float64(len(prep))*l+extra <= sh-2*L.pad
		if fits {
			if bestTrunc < 0 || trunc < bestTrunc {
				size, lh, adv, bestTrunc = sz, l, a, trunc
			}
			if trunc <= 1 || trunc*6 <= len(prep) {
				size, lh, adv = sz, l, a
				break
			}
		} else if i == len(L.codeSizes)-1 && bestTrunc < 0 {
			size, lh, adv = sz, l, a
		}
	}
	{
		// room to spare: open the lines up (at most a quarter), so a short program does not huddle in a big stage
		units := float64(len(prep))
		for _, pl := range prep {
			if pl.gapTop {
				units += 0.5
			}
		}
		if max := (sh - 2*L.pad - 7*boolf(len(rampLines) > 0)) / units; max > lh {
			lh = math.Round(math.Min(max, lh*1.25))
		}
	}
	maxCols := int(codeW / adv)
	for i := range prep {
		if len(prep[i].runes) > maxCols {
			prep[i].runes = append(append([]rune{}, prep[i].runes[:maxCols-1]...), '…')
			prep[i].cls = append(append([]string{}, prep[i].cls[:maxCols-1]...), "comment")
			prep[i].trunc = true
		}
	}

	// ----- markers, chosen from the CID's seed
	greens := map[int]bool{}
	var parts []int
	for i, pl := range prep {
		if pl.idx >= 0 && isPartLine(string(pl.runes)) {
			parts = append(parts, i)
		}
	}
	for _, i := range parts {
		if r.float() < 0.85 {
			greens[i] = true
		}
	}
	if len(greens) == 0 && len(parts) > 0 {
		greens[parts[0]] = true
	}
	var cands []lamp
	for i, pl := range prep {
		if pl.idx < 0 {
			continue
		}
		for _, h := range hitTokens(string(pl.runes)) {
			if h.col+h.n <= len(pl.runes) && !(pl.trunc && h.col+h.n >= len(pl.runes)-1) {
				cands = append(cands, lamp{i, h.col, h.n})
			}
		}
	}
	var lamps []lamp
	want := 2 + r.intn(2)
	usedLine := map[int]bool{}
	for pass := 0; pass < 2 && len(lamps) < want; pass++ {
		pool := append([]lamp{}, cands...)
		for len(pool) > 0 && len(lamps) < want {
			k := r.intn(len(pool))
			cd := pool[k]
			pool = append(pool[:k], pool[k+1:]...)
			if pass == 0 && usedLine[cd.line] {
				continue
			}
			dup := false
			for _, l := range lamps {
				if l == cd {
					dup = true
				}
			}
			if dup {
				continue
			}
			usedLine[cd.line] = true
			lamps = append(lamps, cd)
		}
	}
	ramp := -1
	progress := 0.0
	if len(rampLines) > 0 {
		ramp = rampLines[r.intn(len(rampLines))]
		progress = math.Round((0.22+0.56*r.float())*20) / 20
	}
	lampAt := map[int][]lamp{}
	for _, l := range lamps {
		lampAt[l.line] = append(lampAt[l.line], l)
	}

	// ----- layout of the rows
	tops := make([]float64, len(prep))
	y := 0.0
	for i, pl := range prep {
		if pl.gapTop {
			y += lh * 0.5
		}
		tops[i] = y
		y += lh
		if i == ramp {
			y += 7
		}
	}
	total := y
	y0 := sy + math.Max(L.pad*0.8, (sh-total)/2)
	cx := sx + L.gutter
	numRight := sx + L.gutter - 42
	dotX := sx + L.gutter - 24

	// glows first (under the text). No clip mask: gg draws every string through a canvas-sized temporary
	// when one is set, which made a card cost seconds. The glow rectangles are kept inside the stage instead.
	for _, lp := range lamps {
		base := y0 + tops[lp.line]
		x := cx + float64(lp.col)*adv
		w := float64(lp.n) * adv
		cy := base + lh/2
		rad := w/2 + 22
		rg := gg.NewRadialGradient(x+w/2, cy, 2, x+w/2, cy, rad)
		rg.AddColorStop(0, alpha(colAmber, 0.55))
		rg.AddColorStop(0.55, alpha(colAmber, 0.16))
		rg.AddColorStop(1, alpha(colAmber, 0))
		dc.SetFillStyle(rg)
		gx0, gy0 := math.Max(x+w/2-rad, sx+2), math.Max(cy-rad, sy+2)
		gx1, gy1 := math.Min(x+w/2+rad, sx+sw-2), math.Min(cy+rad, sy+sh-2)
		dc.DrawRectangle(gx0, gy0, gx1-gx0, gy1-gy0)
		dc.Fill()
		dc.SetColor(alpha(colAmber, 0.30))
		dc.DrawRoundedRectangle(x-3, base+lh*0.12, w+6, lh*0.76, 6)
		dc.Fill()
	}

	// the lines
	for i, pl := range prep {
		base := y0 + tops[i]
		baseline := base + lh/2 + size*0.35
		if pl.gapTop {
			// a dotted rule where lines were left out
			dc.SetColor(alpha(colDim, 0.55))
			gy := base - lh*0.25
			for gx := cx; gx < sx+sw-L.pad-6; gx += 9 {
				dc.DrawCircle(gx, gy, 1)
				dc.Fill()
			}
		}
		if pl.idx >= 0 {
			num := itoa(pl.idx + 1)
			nw := p.width(fMono, size*0.8, num)
			p.text(fMono, size*0.8, numRight-nw, baseline, alpha(colDim, 0.85), num)
		}
		// dots
		switch {
		case len(lampAt[i]) > 0:
			rg := gg.NewRadialGradient(dotX, base+lh/2, 0, dotX, base+lh/2, 12)
			rg.AddColorStop(0, alpha(colAmber, 0.65))
			rg.AddColorStop(1, alpha(colAmber, 0))
			dc.SetFillStyle(rg)
			dc.DrawRectangle(dotX-12, base+lh/2-12, 24, 24)
			dc.Fill()
			dc.SetColor(colAmber)
			dc.DrawCircle(dotX, base+lh/2, 5)
			dc.Fill()
		case i == ramp:
			dc.SetColor(alpha(colAccent, 0.95))
			dc.DrawCircle(dotX, base+lh/2, 4.2)
			dc.Fill()
		case greens[i]:
			dc.SetColor(alpha(colGreen, 0.80))
			dc.DrawCircle(dotX, base+lh/2, 4.2)
			dc.Fill()
		}
		// text, in runs of one class
		lit := map[int]bool{}
		for _, lp := range lampAt[i] {
			for k := lp.col; k < lp.col+lp.n; k++ {
				lit[k] = true
			}
		}
		k := 0
		for k < len(pl.runes) {
			j := k
			cl := pl.cls[k]
			isLit := lit[k]
			for j < len(pl.runes) && pl.cls[j] == cl && lit[j] == isLit {
				j++
			}
			s := string(pl.runes[k:j])
			if strings.TrimSpace(s) != "" {
				switch {
				case isLit:
					p.text(fMonoBold, size, cx+float64(k)*adv, baseline, colAmberT, s)
				default:
					p.text(fMono, size, cx+float64(k)*adv, baseline, colourOf(cl), s)
				}
			}
			k = j
		}
		if i == ramp {
			lead := 0
			for lead < len(pl.runes) && pl.runes[lead] == ' ' {
				lead++
			}
			bx := cx + float64(lead)*adv
			bw := float64(len(pl.runes)-lead) * adv
			by := base + lh + 0.5
			dc.SetColor(alpha(colAccent, 0.20))
			dc.DrawRoundedRectangle(bx, by, bw, 4, 2)
			dc.Fill()
			dc.SetColor(colAccent)
			dc.DrawRoundedRectangle(bx, by, math.Max(4, bw*progress), 4, 2)
			dc.Fill()
		}
	}
}

func boolf(b bool) float64 {
	if b {
		return 1
	}
	return 0
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [12]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

// ---- the section timeline ---------------------------------------------------------------------------------

func (p *painter) timeline(c *content, L layout, r *rng) {
	dc := p.dc
	x0, w := L.M, L.W-2*L.M
	secs := c.Sections
	total := 0
	for _, s := range secs {
		if s.Bars > 0 {
			total += s.Bars
		}
	}
	if len(secs) == 0 || total == 0 {
		secs = []api.Section{{Name: "loop", Start: 0, Bars: 1}}
		total = 1
	}
	if len(secs) > 40 {
		secs = secs[:40]
		total = 0
		for _, s := range secs {
			total += s.Bars
		}
	}
	const gap = 4.0
	avail := w - gap*float64(len(secs)-1)
	x := x0
	headFrac := 0.22 + 0.56*r.float()
	picked := -1
	for i, s := range secs {
		if s.Name == c.Section {
			picked = i
			break
		}
	}
	if picked < 0 {
		for i, s := range secs {
			if s.Name == "drop" {
				picked = i
			}
		}
	}
	if picked < 0 && len(secs) == 1 {
		picked = 0
	}
	for i, s := range secs {
		bw := avail * float64(s.Bars) / float64(total)
		if s.Bars <= 0 {
			continue
		}
		on := i == picked
		if on {
			dc.SetColor(alpha(colAccent, 0.15))
		} else {
			dc.SetColor(colBlock)
		}
		dc.DrawRoundedRectangle(x, L.tlY, bw, L.tlH, 7)
		dc.Fill()
		if on {
			dc.SetColor(alpha(colAccent, 0.85))
			dc.SetLineWidth(1.6)
			dc.DrawRoundedRectangle(x+0.8, L.tlY+0.8, bw-1.6, L.tlH-1.6, 6.5)
			dc.Stroke()
		}
		label := cleanText(s.Name, 24)
		tc := colBlockT
		if on {
			tc = colAccent
		}
		kind := fSans
		if on {
			kind = fSansBold
		}
		lx0, lx1 := x+bw/2, x+bw/2
		if bw > 26 {
			label = p.ellipsize(kind, L.tlFont, bw-14, label)
			lw := p.width(kind, L.tlFont, label)
			p.text(kind, L.tlFont, x+(bw-lw)/2, L.tlY+L.tlH/2+L.tlFont*0.35, tc, label)
			lx0, lx1 = x+(bw-lw)/2, x+(bw+lw)/2
		}
		if on {
			// the playhead, frozen mid-section (and clear of the name)
			hx := x + 6 + (bw-12)*headFrac
			if hx > lx0-8 && hx < lx1+8 {
				if hx-lx0 < lx1-hx && lx0-12 > x+6 {
					hx = lx0 - 12
				} else if lx1+12 < x+bw-6 {
					hx = lx1 + 12
				} else if lx0-12 > x+6 {
					hx = lx0 - 12
				}
			}
			g := gg.NewLinearGradient(hx-9, 0, hx+9, 0)
			g.AddColorStop(0, alpha(colAmber, 0))
			g.AddColorStop(0.5, alpha(colAmber, 0.55))
			g.AddColorStop(1, alpha(colAmber, 0))
			dc.SetFillStyle(g)
			dc.DrawRectangle(hx-9, L.tlY-5, 18, L.tlH+10)
			dc.Fill()
			dc.SetColor(colAmber)
			dc.DrawRoundedRectangle(hx-1.25, L.tlY-5, 2.5, L.tlH+10, 1.2)
			dc.Fill()
		}
		x += bw + gap
	}
}

// ---- the facts row -------------------------------------------------------------------------------------------

type fact struct{ val, unit string }

func (p *painter) facts(c *content, L layout) {
	dc := p.dc
	var fs []fact
	if c.Generic {
		fs = []fact{{"a track in a few lines", ""}, {"same text, same CID", ""}}
		if L.twoRowFacts {
			fs = []fact{{"a track in a few lines", ""}}
		}
	} else {
		if c.Tempo > 0 {
			fs = append(fs, fact{fmtBPM(c.Tempo), "BPM"})
		}
		if k := keyLabel(c.Key); k != "" {
			fs = append(fs, fact{k, ""})
		}
		switch {
		case c.Bars > 0 && c.Seconds > 0:
			fs = append(fs, fact{itoa(c.Bars), "bars"}, fact{clock(c.Seconds), ""})
		case c.Bars > 0:
			fs = append(fs, fact{itoa(c.Bars), "bars"})
		default:
			fs = append(fs, fact{"loop", ""})
		}
	}

	// right side: licence badge, short CID
	base := L.factsBase
	right := L.W - L.M
	idText := shortCID(c.CID)
	if c.Generic {
		idText = "btw.bitwrap.io"
	}
	rowRight := base
	if L.twoRowFacts {
		rowRight = L.factsRow2
	}
	cidKind := fMono
	cw := p.width(cidKind, L.cidSize, idText)
	p.text(cidKind, L.cidSize, right-cw, rowRight, colSub, idText)
	right -= cw + 22
	lic := licenseBadge(c.License)
	bw := p.width(fSansBold, L.badgeSize, lic) + 26
	bh := L.badgeSize * 1.9
	by := rowRight - L.badgeSize*0.35 - bh/2
	dc.SetColor(alpha(colAccent, 0.12))
	dc.DrawRoundedRectangle(right-bw, by, bw, bh, bh/2)
	dc.Fill()
	dc.SetColor(alpha(colAccent, 0.8))
	dc.SetLineWidth(1.5)
	dc.DrawRoundedRectangle(right-bw+0.75, by+0.75, bw-1.5, bh-1.5, bh/2)
	dc.Stroke()
	p.text(fSansBold, L.badgeSize, right-bw+13, rowRight, colAccent, lic)
	right -= bw + 22

	// left side: facts separated by hairlines
	x := L.M
	maxX := L.W - L.M
	if !L.twoRowFacts {
		maxX = right
	}
	for i, f := range fs {
		vw := p.width(fSansBold, L.valSize, f.val)
		uw := 0.0
		if f.unit != "" {
			uw = p.width(fSans, L.unitSize, f.unit) + 8
		}
		if x+vw+uw > maxX {
			break
		}
		if i > 0 {
			dc.SetColor(colRule)
			dc.SetLineWidth(2)
			dc.DrawLine(x-16, base-L.valSize*0.75, x-16, base+L.valSize*0.1)
			dc.Stroke()
		}
		p.text(fSansBold, L.valSize, x, base, colText, f.val)
		if f.unit != "" {
			p.text(fSans, L.unitSize, x+vw+8, base, colSub, f.unit)
		}
		x += vw + uw + 34
	}
}
