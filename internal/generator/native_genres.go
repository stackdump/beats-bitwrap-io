package generator

// NativeGenres are the genres only the djwasm engine composes (acid, deephouse, electro,
// italo: djrust's data/genres-native.json). There is no Go (or JS) composer for them: the page
// asks the engine for the project, so a share envelope that names one is valid and plays, but
// Genres has no entry for it. This is the metadata the server needs to describe such a share
// (card tempo, scale label, mastering bucket); the facts match
// public/lib/genres/native-genres.js, which test-native-genres.mjs holds to the engine.
var NativeGenres = map[string]NativeGenre{
	"acid":      {Name: "acid", BPM: 125, ScaleName: "Minor"},
	"deephouse": {Name: "deephouse", BPM: 122, ScaleName: "Dorian"},
	"electro":   {Name: "electro", BPM: 118, ScaleName: "Minor"},
	"italo":     {Name: "italo", BPM: 120, ScaleName: "Minor"},
}

// NativeGenre is what the server knows about an engine-only genre.
type NativeGenre struct {
	Name      string
	BPM       float64
	ScaleName string
}

// KnownGenre reports whether name is a genre a share may carry: one of the Go/JS composer's, or
// one only the engine composes.
func KnownGenre(name string) bool {
	if _, ok := Genres[name]; ok {
		return true
	}
	_, ok := NativeGenres[name]
	return ok
}
