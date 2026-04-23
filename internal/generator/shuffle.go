package generator

import (
	"math/rand"
	"time"

	"beats-bitwrap-io/internal/pflow"
)

// ShuffleInstruments picks a random instrument from each net's InstrumentSet.
// Returns a map of netId -> chosen instrument name.
func ShuffleInstruments(proj *pflow.Project, seed int64) map[string]string {
	if seed == 0 {
		seed = time.Now().UnixNano()
	}
	rng := rand.New(rand.NewSource(seed))

	result := make(map[string]string)
	for netId, bundle := range proj.Nets {
		if len(bundle.Track.InstrumentSet) == 0 {
			continue
		}
		chosen := bundle.Track.InstrumentSet[rng.Intn(len(bundle.Track.InstrumentSet))]
		bundle.Track.Instrument = chosen
		result[netId] = chosen
	}
	return result
}
