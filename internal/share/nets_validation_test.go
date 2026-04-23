package share

import (
	"strings"
	"testing"
)

// Guardrail tests for the `nets` schema extension — once we invite
// agents to POST hand-authored payloads directly, the server needs to
// refuse pathological shapes cheaply. These tests pin the boundaries
// so future schema drift can't silently loosen them.

const validHandAuthoredPayload = `{
	"@context": "https://beats.bitwrap.io/schema/beats-share.context.jsonld",
	"@type": "BeatsShare",
	"v": 1,
	"genre": "custom",
	"seed": 0,
	"tempo": 92,
	"nets": {
		"arp": {
			"role": "music",
			"track": { "channel": 4, "defaultVelocity": 90, "instrument": "bright-pluck" },
			"places": { "p0": { "initial": [1], "x": 0, "y": 0 } },
			"transitions": {
				"t0": { "x": 0, "y": 0, "midi": { "note": 60, "channel": 4, "velocity": 90, "duration": 140 } }
			},
			"arcs": [ { "source": "p0", "target": "t0", "weight": [1] } ]
		}
	}
}`

func TestSchema_AcceptsValidHandAuthored(t *testing.T) {
	if err := validateSharePayload([]byte(validHandAuthoredPayload)); err != nil {
		t.Fatalf("valid hand-authored payload rejected: %v", err)
	}
}

func TestSchema_RejectsProtoPollutionKey(t *testing.T) {
	// Net IDs and the inner place/transition maps must match the
	// propertyNames pattern, which excludes __proto__ and constructor.
	for _, bad := range []string{
		`{"@type":"BeatsShare","v":1,"genre":"custom","seed":0,"nets":{"__proto__":{}}}`,
		`{"@type":"BeatsShare","v":1,"genre":"custom","seed":0,"nets":{"arp":{"places":{"__proto__":{"initial":[0],"x":0,"y":0}}}}}`,
	} {
		if err := validateSharePayload([]byte(bad)); err == nil {
			t.Errorf("payload with __proto__ key accepted: %q", bad)
		}
	}
}

func TestSchema_RejectsTooManyNets(t *testing.T) {
	var b strings.Builder
	b.WriteString(`{"@type":"BeatsShare","v":1,"genre":"custom","seed":0,"nets":{`)
	// 257 nets — one above the 256 cap
	for i := 0; i < 257; i++ {
		if i > 0 {
			b.WriteString(",")
		}
		// Minimal valid net shape; just needs to parse.
		b.WriteString(`"n`)
		b.WriteString(itoaLocal(i))
		b.WriteString(`":{}`)
	}
	b.WriteString(`}}`)
	if err := validateSharePayload([]byte(b.String())); err == nil {
		t.Fatal("payload with 257 nets was accepted; expected schema rejection on maxProperties")
	}
}

func TestSchema_RejectsUnknownControlAction(t *testing.T) {
	p := `{"@type":"BeatsShare","v":1,"genre":"custom","seed":0,"nets":{
		"c":{"role":"control","track":{"channel":1},"places":{"p0":{"initial":[1],"x":0,"y":0}},
		"transitions":{"t0":{"x":0,"y":0,"control":{"action":"rm-rf","targetNet":"arp"}}},"arcs":[]}}}`
	if err := validateSharePayload([]byte(p)); err == nil {
		t.Fatal("payload with invalid control action was accepted")
	}
}

func TestSchema_LegacyRecipeStillValidates(t *testing.T) {
	// A share that predates the nets extension — no nets field at all —
	// must still pass since adding the field was meant to be additive.
	p := `{"@type":"BeatsShare","v":1,"genre":"techno","seed":42,"tempo":128}`
	if err := validateSharePayload([]byte(p)); err != nil {
		t.Fatalf("legacy recipe rejected: %v", err)
	}
}

func itoaLocal(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
