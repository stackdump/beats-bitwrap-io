package card

import (
	"strings"

	"beats-bitwrap-io/internal/btwsite/api"
)

// genericProgram is the fixed sample the generic card shows. It is written for the card, belongs to nobody and
// is never sent through the checker: it is coloured by the built-in lexer, so the generic card does not depend on
// btwd.
const genericProgram = `tempo 128
key am
let kick = x ~ ~ ~ x ~ ~ ~ x ~ ~ ~ x ~ ~ ~
let bass = a1! ~ a1 ~ ~ a1 ~ ~ c2 ~ a1 ~ ~ e2 ~ ~
section drop 8 bars {
  deck A: kick kick | bass bass inst=reese
  deck B: harmony chord(am) | melody <a4 c5 e5 g5> inst=pwm-lead
  master: filter lp 300 -> 2800 over 8 bars
}
arrange drop
`

func genericContent(site string) *content {
	lines := strings.Split(strings.TrimRight(genericProgram, "\n"), "\n")
	var rl []rline
	for i, l := range lines {
		rl = append(rl, rline{idx: i, text: l})
	}
	return &content{
		Seed: "btw-generic", Name: "write a whole track as text", License: "CC0-1.0",
		Canonical: genericProgram, Spans: basicSpans(genericProgram), Lines: rl, Section: "drop", Generic: true, Site: site,
		Sections: []api.Section{{Name: "intro", Start: 0, Bars: 4}, {Name: "build", Start: 4, Bars: 4}, {Name: "drop", Start: 8, Bars: 8}, {Name: "outro", Start: 16, Bars: 4}},
	}
}
