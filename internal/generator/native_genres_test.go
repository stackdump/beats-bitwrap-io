package generator

import "testing"

func TestNativeGenresDoNotShadowComposerGenres(t *testing.T) {
	for name, g := range NativeGenres {
		if _, ok := Genres[name]; ok {
			t.Errorf("%s is both a composer genre and a native one", name)
		}
		if g.Name != name || g.BPM <= 0 || g.ScaleName == "" {
			t.Errorf("%s: incomplete %+v", name, g)
		}
		if !KnownGenre(name) {
			t.Errorf("%s not known", name)
		}
	}
	if KnownGenre("no-such-genre") {
		t.Error("an unknown name is known")
	}
	if len(Genres) != 19 {
		t.Errorf("composer genres changed: %d", len(Genres))
	}
}
