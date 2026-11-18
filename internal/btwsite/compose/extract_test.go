package compose

import "testing"

func TestExtractProgram(t *testing.T) {
	prog := "tempo 120\nkey am\ndeck A: kick x ~ x ~\n"
	for name, tc := range map[string]struct{ in, want string }{
		"plain":            {prog, prog},
		"no final newline": {"tempo 120\nkey am\ndeck A: kick x ~ x ~", prog},
		"crlf":             {"tempo 120\r\nkey am\r\ndeck A: kick x ~ x ~\r\n", prog},
		"bom":              {"\xef\xbb\xbf" + prog, prog},
		"trailing spaces":  {"tempo 120  \nkey am\t\ndeck A: kick x ~ x ~   \n\n\n", prog},
		"fence":            {"```\n" + prog + "```", prog},
		"fence with lang":  {"```btw\n" + prog + "```\n", prog},
		"fence and prose":  {"Sure! Here is a track:\n\n```btw\n" + prog + "```\n\nThis uses a four-on-the-floor kick.\n", prog},
		"unterminated":     {"```btw\n" + prog, prog},
		"leading sentence": {"Here is your program:\n" + prog, prog},
		"leading para":     {"Here is a dark techno track for you.\n\n" + prog, prog},
		"trailing para":    {prog + "\nThis program has a kick and a snare.\nEnjoy the music!\n", prog},
		"bullets after":    {prog + "\n**Notes**\n* the kick is steady\n* the snare is on 2 and 4\n", prog},
		"blank line inside a block stays": {"tempo 120\nkey am\nsection a 8 bars {\n  deck A: kick x ~ x ~\n\n  master: reverb 0.2\n}\narrange a\n",
			"tempo 120\nkey am\nsection a 8 bars {\n  deck A: kick x ~ x ~\n\n  master: reverb 0.2\n}\narrange a\n"},
		"comments stay":                      {"# a comment\n" + prog, "# a comment\n" + prog},
		"two fences, first with a statement": {"```\nnot code at all\n```\n```btw\n" + prog + "```\n", prog},
		// what is wrong is left for the checker to say: nothing is silently dropped
		"typo line is kept":        {"tempo 120\nkey am\nkik x ~ x ~\n", "tempo 120\nkey am\nkik x ~ x ~\n"},
		"stray word is kept":       {prog + "\nBAD\n", prog + "\nBAD\n"},
		"capitalised word is kept": {"Tempo 120\nkey am\n", "Tempo 120\nkey am\n"},
		"no statements at all":     {"I cannot do that.", "I cannot do that.\n"},
		"empty":                    {"  \n\n", ""},
		"only a fence":             {"```\n```", ""},
	} {
		if got := ExtractProgram(tc.in); got != tc.want {
			t.Errorf("%s:\n got %q\nwant %q", name, got, tc.want)
		}
	}
}
