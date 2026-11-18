package btw

import (
	"strings"
	"testing"
)

// A link made by `djctl btw share` (djrust-vevr-se): hand-dubstep-140, 778 bytes of canonical text.
const dubstepLink = "https://beats.bitwrap.io/p#z4EBG9jD5z7Kk3J1PeAG7PmE1hTNikEv1rNXWTdpYux1EDAEmMR.5VJRasMwDP3PKR7kZ_sYxDSMErZAd41RRhbbSYgdBzuMBkrPPs0ubrqUXqAY9J6kJwlbnoQeDVieJb2YIXXCRd1jV6DvCA84rc4ydoQbKivuaoKu7dpquspd48HjEd-Vc3j7lMxHz9Ck7OKcwL1bk9kjKGOqTiNjUentvkQ3uOndCuFEuOVHAS2U4TMN9CW5n7U5d5CBNJtLlOZFIU_zODRfVS-Vj9Wy_Nt2ZbUZ6F3r1lj-JPUz_rM6XbPmBuNLVia6cpOwBWSnCKFG5FmGlxJsmxExPxTc0i-yLhHEZ7BX79GqKQdlzPhljVIwA3ZBzoL8Fw"

func TestRustMadeLinkVerifiesHere(t *testing.T) {
	r, err := Open(dubstepLink)
	if err != nil {
		t.Fatal(err)
	}
	if !r.Verified {
		t.Fatalf("a link the language made does not verify: %+v", r)
	}
	if !strings.HasPrefix(r.Text, "tempo 140\nkey fm\ndeck A: kick x ~ ~ ~") {
		t.Fatalf("program = %q", r.Text[:60])
	}
	if r.Chars != 405 {
		t.Fatalf("chars = %d", r.Chars)
	}
}

func TestForgedTextIsRefused(t *testing.T) {
	l, _ := Parse(dubstepLink)
	forged := "https://beats.bitwrap.io/p#" + l.CID + "." + Pack(strings.Replace(l.Text, "tempo 140", "tempo 141", 1))
	r, err := Open(forged)
	if err != nil {
		t.Fatal(err)
	}
	if r.Verified || len(r.Warnings) == 0 || !strings.Contains(r.Warnings[0], "REFUSED") {
		t.Fatalf("a forged link was not refused: %+v", r)
	}
}

func TestNotesAndSignatureTravelUnsealed(t *testing.T) {
	l, _ := Parse(dubstepLink)
	link := "https://beats.bitwrap.io/p#" + l.CID + "." + Pack(l.Text) + ".sigABC~" + Pack("the drop\nbig wobble")
	r, err := Open(link)
	if err != nil || !r.Verified {
		t.Fatalf("%v %+v", err, r)
	}
	if r.Sig != "sigABC" || len(r.Notes) != 2 || r.Notes[1] != "big wobble" {
		t.Fatalf("%+v", r)
	}
}

func TestBareCIDHasNoProgram(t *testing.T) {
	r, err := Open("z4EBG9jD5z7Kk3J1PeAG7PmE1hTNikEv1rNXWTdpYux1EDAEmMR")
	if err != nil || r.Verified || r.Text != "" || len(r.Warnings) == 0 {
		t.Fatalf("%v %+v", err, r)
	}
	if _, err := Open("not a link!"); err == nil {
		t.Fatal("garbage opened")
	}
}
