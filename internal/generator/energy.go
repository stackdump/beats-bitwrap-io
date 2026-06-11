package generator

// Cohesion v2 — SectionProfile drives content (not just mute state) per section.
// Today sectionArchetypes only carries map[role]bool — a drop is "kick on,
// melody on" and a breakdown is "hihat on, bass on, melody on", but the
// underlying nets are identical, so the listener hears "section names
// changing" not "sections sounding different".
//
// SectionProfile gives each role a RoleProfile: density multiplier, register
// shift, hits override, motif mode, plus per-section FilterOpen and Energy
// scalars that auto-populate a FeelCurve so the Feel puck physically moves
// through the track (drops open the filter, breakdowns close it).
//
// The tables here are declarative — varying "what a drop does" in a genre
// is a single map-entry edit, not a code change.

// RoleProfile is the per-role content driver for one section.
type RoleProfile struct {
	// Active controls whether the role plays in the section at all.
	// Equivalent to today's map[role]bool semantics; everything else is new.
	Active bool

	// DensityMul scales the role's note density. 1.0 = base; 1.5 = busier;
	// 0.5 = sparser. Applied to Markov draws (melody/bass) and as a
	// hint to drum hit-count overrides.
	DensityMul float64

	// VelocityAdd is added to the base velocity. Drives "drops feel
	// louder, intros feel quieter" without re-mixing.
	VelocityAdd int

	// RegisterShift is added (in semitones) to the role's RootNote.
	// Bass uses this for the classic "drop2 dives sub octave"
	// (RegisterShift = -12) and breakdown "bass floats up an octave"
	// (RegisterShift = +12).
	RegisterShift int

	// HitsOverride pins the absolute kick/snare/hihat hit count for the
	// section, overriding the genre default. 0 = inherit. Setting it to
	// 0 explicitly is currently expressed by leaving Active=false.
	HitsOverride int

	// MotifMode controls how the role consumes the track motif. Drums
	// default to MotifIgnore. See theme.go for the recall grammar.
	MotifMode MotifMode
}

// SectionProfile is the per-section content driver, indexed by role name.
type SectionProfile struct {
	Roles      map[string]RoleProfile
	FilterOpen float64 // 0..1; mapped to Feel-Y (filter cutoff openness)
	Energy     float64 // 0..1; mapped to Feel-X (general intensity)
}

// EnergyShape is a named family-level curve. Per-family defaults are filled
// in below — picking a shape gives a genre a baseline energy story it can
// override piece-by-piece.
type EnergyShape int

const (
	EnergyEDMBuildDrop EnergyShape = iota // intro low, buildup ramp, drop peak, breakdown trough, drop2 peak, outro low
	EnergySongVerseChorus                 // verse mid, chorus peak, bridge dip, chorus peak
	EnergyChillFlatArc                    // intro low, slow arc up, gentle peak, fade
)

// energyShapeFor maps a structure family to its default EnergyShape. Genre-
// specific overrides ride on top via SectionOverrides (theory.go).
func energyShapeFor(family structureFamily) EnergyShape {
	switch family {
	case familyEDM:
		return EnergyEDMBuildDrop
	case familySong, familyJazz:
		return EnergySongVerseChorus
	case familyChill:
		return EnergyChillFlatArc
	}
	return EnergyEDMBuildDrop
}

// energyEDM is the per-section (Energy, FilterOpen) table for buildup/drop
// genres. The Feel puck's X axis snaps to Energy at section start; the Y axis
// snaps to FilterOpen. The numbers were picked so the auto-injected FeelCurve
// sounds like a producer's session in a hosted DAW: intros are quiet & dark,
// buildups ramp X but keep Y low (filter held closed), drops blast both, the
// breakdown pulls Y down (filter closes) without going fully silent.
var energyEDM = map[string]SectionProfile{
	"intro":      {Energy: 0.30, FilterOpen: 0.35},
	"buildup":    {Energy: 0.65, FilterOpen: 0.40},
	"pre-chorus": {Energy: 0.60, FilterOpen: 0.45},
	"drop":       {Energy: 0.95, FilterOpen: 0.90},
	"verse":      {Energy: 0.55, FilterOpen: 0.50},
	"chorus":     {Energy: 0.85, FilterOpen: 0.80},
	"breakdown":  {Energy: 0.30, FilterOpen: 0.25},
	"bridge":     {Energy: 0.55, FilterOpen: 0.55},
	"solo":       {Energy: 0.70, FilterOpen: 0.70},
	"outro":      {Energy: 0.30, FilterOpen: 0.30},
}

var energySong = map[string]SectionProfile{
	"intro":      {Energy: 0.35, FilterOpen: 0.40},
	"verse":      {Energy: 0.55, FilterOpen: 0.55},
	"pre-chorus": {Energy: 0.70, FilterOpen: 0.55},
	"chorus":     {Energy: 0.85, FilterOpen: 0.80},
	"breakdown":  {Energy: 0.40, FilterOpen: 0.40},
	"bridge":     {Energy: 0.55, FilterOpen: 0.55},
	"drop":       {Energy: 0.85, FilterOpen: 0.80},
	"solo":       {Energy: 0.75, FilterOpen: 0.75},
	"outro":      {Energy: 0.30, FilterOpen: 0.35},
}

var energyChill = map[string]SectionProfile{
	"intro":      {Energy: 0.25, FilterOpen: 0.35},
	"verse":      {Energy: 0.45, FilterOpen: 0.50},
	"chorus":     {Energy: 0.60, FilterOpen: 0.60},
	"bridge":     {Energy: 0.55, FilterOpen: 0.55},
	"breakdown":  {Energy: 0.30, FilterOpen: 0.40},
	"buildup":    {Energy: 0.40, FilterOpen: 0.45},
	"drop":       {Energy: 0.55, FilterOpen: 0.55},
	"pre-chorus": {Energy: 0.50, FilterOpen: 0.50},
	"solo":       {Energy: 0.55, FilterOpen: 0.55},
	"outro":      {Energy: 0.25, FilterOpen: 0.30},
}

// energyTableFor returns the per-section Energy/FilterOpen base table for a
// family. Tables are read-only — callers clone before mutating per-genre.
func energyTableFor(family structureFamily) map[string]SectionProfile {
	switch family {
	case familyEDM:
		return energyEDM
	case familySong, familyJazz:
		return energySong
	case familyChill:
		return energyChill
	}
	return energyEDM
}

// roleProfilesEDM defines the v2 per-section RoleProfile map for the EDM
// family. This is the table that turns "a drop is just verse with melody on"
// into "a drop has the motif at full density, kick at 4-on-floor, hats
// dense, bass at base register; a breakdown mutes the kick, augments the
// motif, lifts the bass up an octave".
//
// Roles not in a section's map default to inactive. RoleProfile.Active=true
// is required for the role to play.
var roleProfilesEDM = map[string]map[string]RoleProfile{
	"intro": {
		"kick":  {Active: true, DensityMul: 1.0, VelocityAdd: -10, HitsOverride: 4},
		"hihat": {Active: true, DensityMul: 0.5, VelocityAdd: -10, HitsOverride: 2},
	},
	"buildup": {
		"kick":    {Active: true, DensityMul: 1.0, HitsOverride: 4},
		"snare":   {Active: true, DensityMul: 0.7},
		"hihat":   {Active: true, DensityMul: 1.0, HitsOverride: 8},
		"bass":    {Active: true, DensityMul: 0.8, MotifMode: MotifFragment},
		"melody":  {Active: true, DensityMul: 0.7, MotifMode: MotifFragment},
		"harmony": {Active: true, DensityMul: 0.8, VelocityAdd: -6},
	},
	"drop": {
		"kick":    {Active: true, DensityMul: 1.0, VelocityAdd: 8, HitsOverride: 4},
		"snare":   {Active: true, DensityMul: 1.0, VelocityAdd: 6},
		"hihat":   {Active: true, DensityMul: 1.0, VelocityAdd: 4, HitsOverride: 8},
		"clap":    {Active: true, DensityMul: 1.0, VelocityAdd: 6},
		"bass":    {Active: true, DensityMul: 1.0, VelocityAdd: 6, MotifMode: MotifIgnore},
		"melody":  {Active: true, DensityMul: 1.0, VelocityAdd: 6, MotifMode: MotifPlay},
		"arp":     {Active: true, DensityMul: 1.0, VelocityAdd: 4, MotifMode: MotifTransposed},
		"harmony": {Active: true, DensityMul: 1.0, VelocityAdd: 4},
	},
	"verse": {
		"kick":    {Active: true, HitsOverride: 4},
		"snare":   {Active: true},
		"hihat":   {Active: true, HitsOverride: 5},
		"bass":    {Active: true, DensityMul: 0.9, MotifMode: MotifIgnore},
		"melody":  {Active: true, DensityMul: 0.6, MotifMode: MotifFragment},
		"harmony": {Active: true, DensityMul: 0.8, VelocityAdd: -4},
	},
	"breakdown": {
		// No kick — the breakdown's defining trait. Hats sparse, bass
		// lifts an octave to "atmospheric" register, melody plays the
		// motif augmented (slowed, recognizable). Pad holds the harmony
		// so the section doesn't feel empty without the kick.
		"hihat":   {Active: true, DensityMul: 0.6, VelocityAdd: -8, HitsOverride: 2},
		"bass":    {Active: true, DensityMul: 0.5, RegisterShift: 12, MotifMode: MotifIgnore},
		"melody":  {Active: true, DensityMul: 0.7, MotifMode: MotifAugmented},
		"harmony": {Active: true, DensityMul: 1.0},
	},
	"chorus": {
		"kick":    {Active: true, HitsOverride: 4},
		"snare":   {Active: true},
		"hihat":   {Active: true, HitsOverride: 8},
		"bass":    {Active: true, DensityMul: 1.0, MotifMode: MotifIgnore},
		"melody":  {Active: true, DensityMul: 1.0, MotifMode: MotifPlay},
		"arp":     {Active: true, DensityMul: 1.0, MotifMode: MotifTransposed},
		"harmony": {Active: true, DensityMul: 1.0, VelocityAdd: 4},
	},
	"bridge": {
		"hihat":   {Active: true, DensityMul: 0.7},
		"bass":    {Active: true, DensityMul: 0.8, MotifMode: MotifIgnore},
		"melody":  {Active: true, DensityMul: 0.8, MotifMode: MotifInverted},
		"harmony": {Active: true, DensityMul: 0.9},
	},
	"solo": {
		"kick":    {Active: true, HitsOverride: 4},
		"hihat":   {Active: true, HitsOverride: 6},
		"bass":    {Active: true, MotifMode: MotifIgnore},
		"melody":  {Active: true, DensityMul: 1.1, MotifMode: MotifPlay},
		"harmony": {Active: true, DensityMul: 0.9},
	},
	"pre-chorus": {
		"kick":    {Active: true, HitsOverride: 4},
		"snare":   {Active: true},
		"hihat":   {Active: true, HitsOverride: 6},
		"bass":    {Active: true, MotifMode: MotifIgnore},
		"arp":     {Active: true, DensityMul: 1.0, MotifMode: MotifFragment},
		"harmony": {Active: true, DensityMul: 0.9},
	},
	"outro": {
		"kick":    {Active: true, HitsOverride: 2, VelocityAdd: -10},
		"hihat":   {Active: true, HitsOverride: 2, VelocityAdd: -10},
		"melody":  {Active: true, DensityMul: 0.5, MotifMode: MotifFragment},
		"harmony": {Active: true, DensityMul: 0.7, VelocityAdd: -8},
	},
}

// roleProfilesSong is the song-family per-section RoleProfile table.
// Song blueprints are verse/chorus oriented (no drop/breakdown energy
// trough), so the motif lives on the melody across verse / chorus /
// bridge — verbatim in the chorus (the "anchor"), fragmented in the
// verse and outro (the "tease/fade"), inverted in the bridge.
//
// Synthwave drums stay active across all song sections (no kick mute);
// the cohesion signature here is the recurring motif + the locked
// bass-on-kick groove, not section-content silence.
var roleProfilesSong = map[string]map[string]RoleProfile{
	"intro": {
		"kick":    {Active: true, DensityMul: 1.0, VelocityAdd: -10, HitsOverride: 4},
		"hihat":   {Active: true, DensityMul: 0.7, VelocityAdd: -8},
		"melody":  {Active: true, DensityMul: 0.4, MotifMode: MotifFragment},
		"harmony": {Active: true, DensityMul: 0.8, VelocityAdd: -6},
	},
	"verse": {
		"kick":    {Active: true, HitsOverride: 4},
		"snare":   {Active: true},
		"hihat":   {Active: true},
		"bass":    {Active: true, MotifMode: MotifIgnore},
		"melody":  {Active: true, DensityMul: 0.7, MotifMode: MotifFragment},
		"harmony": {Active: true, DensityMul: 0.9},
	},
	"pre-chorus": {
		"kick":    {Active: true, HitsOverride: 4},
		"snare":   {Active: true},
		"hihat":   {Active: true},
		"bass":    {Active: true, MotifMode: MotifIgnore},
		"arp":     {Active: true, DensityMul: 0.9, MotifMode: MotifFragment},
		"harmony": {Active: true, DensityMul: 0.9},
	},
	"chorus": {
		"kick":    {Active: true, HitsOverride: 4, VelocityAdd: 6},
		"snare":   {Active: true, VelocityAdd: 4},
		"hihat":   {Active: true, VelocityAdd: 4},
		"bass":    {Active: true, VelocityAdd: 6, MotifMode: MotifIgnore},
		"melody":  {Active: true, VelocityAdd: 6, MotifMode: MotifPlay},
		"arp":     {Active: true, MotifMode: MotifTransposed},
		"harmony": {Active: true, DensityMul: 1.0, VelocityAdd: 4},
	},
	"bridge": {
		"kick":    {Active: true, HitsOverride: 4},
		"hihat":   {Active: true, DensityMul: 0.7},
		"bass":    {Active: true, DensityMul: 0.8, MotifMode: MotifIgnore},
		"melody":  {Active: true, DensityMul: 0.8, MotifMode: MotifInverted},
		"harmony": {Active: true, DensityMul: 0.9},
	},
	"breakdown": {
		// Song-family breakdown: drums thin out but kick stays present
		// (unlike EDM where the kick fully drops). Melody augments —
		// the chorus motif slowed down sells "we're in the quiet part
		// before it comes back". Pad carries the harmony through.
		"kick":    {Active: true, DensityMul: 0.7, VelocityAdd: -10, HitsOverride: 2},
		"hihat":   {Active: true, DensityMul: 0.5, VelocityAdd: -8},
		"bass":    {Active: true, DensityMul: 0.5, RegisterShift: 12, MotifMode: MotifIgnore},
		"melody":  {Active: true, DensityMul: 0.7, MotifMode: MotifAugmented},
		"harmony": {Active: true, DensityMul: 1.0},
	},
	"drop": {
		"kick":    {Active: true, HitsOverride: 4, VelocityAdd: 8},
		"snare":   {Active: true, VelocityAdd: 6},
		"hihat":   {Active: true, VelocityAdd: 4},
		"bass":    {Active: true, VelocityAdd: 6, MotifMode: MotifIgnore},
		"melody":  {Active: true, VelocityAdd: 6, MotifMode: MotifPlay},
		"harmony": {Active: true, DensityMul: 1.0, VelocityAdd: 4},
	},
	"solo": {
		"kick":    {Active: true, HitsOverride: 4},
		"hihat":   {Active: true},
		"bass":    {Active: true, MotifMode: MotifIgnore},
		"melody":  {Active: true, DensityMul: 1.1, MotifMode: MotifPlay},
		"harmony": {Active: true, DensityMul: 0.9},
	},
	"outro": {
		"kick":    {Active: true, HitsOverride: 2, VelocityAdd: -10},
		"hihat":   {Active: true, DensityMul: 0.6, VelocityAdd: -10},
		"melody":  {Active: true, DensityMul: 0.5, MotifMode: MotifFragment},
		"harmony": {Active: true, DensityMul: 0.7, VelocityAdd: -8},
	},
}

// rolesTableFor selects the per-family role-profile table. Families with
// an explicitly-authored table (EDM, song) get the hand-tuned density /
// velocity / hits values. Families without one (jazz, chill) fall through
// to synthesizeRoles, which derives a profile from the family archetype +
// the section→motif-mode policy — so every genre gets full v2 (harmonic
// motion + per-section motif recall), not just the tuned ones.
func rolesTableFor(family structureFamily) map[string]map[string]RoleProfile {
	switch family {
	case familyEDM:
		return roleProfilesEDM
	case familySong:
		return roleProfilesSong
	}
	return nil
}

// motifModeForSection is the section→recall-grammar policy: which MotifMode
// a melodic role takes in a given section. The explicit EDM/Song tables
// encode this by hand; synthesizeRoles applies it uniformly to families
// without a table. Drops/choruses state the hook plainly, breakdowns slow
// it (augmented), bridges flip it (inverted), everything else teases
// (fragment).
func motifModeForSection(sectionName string) MotifMode {
	switch sectionName {
	case "drop", "chorus", "solo":
		return MotifPlay
	case "breakdown":
		return MotifAugmented
	case "bridge":
		return MotifInverted
	default: // intro, verse, buildup, pre-chorus, outro
		return MotifFragment
	}
}

// synthesizeRoles builds a section's RoleProfile map for a family without an
// explicit table. Active roles come from the family archetype (jazz keeps
// ride+walking-bass, chill stays pad-forward); melodic roles get the
// section's motif mode; the chord pad is forced active so the harmonic bed
// is always present. This is what lets jazz/bossa/ambient/lofi run the full
// cohesion engine without hand-authoring two more tables.
func synthesizeRoles(family structureFamily, sectionName string) map[string]RoleProfile {
	out := map[string]RoleProfile{}
	for role := range archetypeFor(family, sectionName) {
		rp := RoleProfile{Active: true}
		if role == "melody" || role == "arp" {
			rp.MotifMode = motifModeForSection(sectionName)
		}
		out[role] = rp
	}
	if _, ok := out["harmony"]; !ok {
		out["harmony"] = RoleProfile{Active: true}
	}
	return out
}

// energyProfilesFor returns the per-section SectionProfile map for a
// (family, genre). Energy/FilterOpen come from the family base table; roles
// come from the explicit per-family table when present, else from
// synthesizeRoles. Every section ends up with a populated role map, so no
// genre falls back to empty-section v1.
func energyProfilesFor(family structureFamily, genreName string) map[string]SectionProfile {
	base := energyTableFor(family)
	roles := rolesTableFor(family)

	out := make(map[string]SectionProfile, len(base))
	for name, prof := range base {
		var filledRoles map[string]RoleProfile
		if roles != nil {
			if r, ok := roles[name]; ok {
				filledRoles = make(map[string]RoleProfile, len(r))
				for role, p := range r {
					filledRoles[role] = p
				}
			}
		}
		if filledRoles == nil {
			// No explicit entry (jazz/chill family, or a section the
			// tuned table doesn't cover) — synthesize from the archetype.
			filledRoles = synthesizeRoles(family, name)
		}
		out[name] = SectionProfile{
			Roles:      filledRoles,
			FilterOpen: prof.FilterOpen,
			Energy:     prof.Energy,
		}
	}
	return out
}

// activeRolesFromProfile returns the legacy map[role]bool that
// sectionArchetypes-aware code consumes, so v2-aware paths can interop with
// non-v2-aware paths (e.g. linearControlNet, mixer grouping).
func activeRolesFromProfile(p SectionProfile) map[string]bool {
	out := make(map[string]bool, len(p.Roles))
	for role, rp := range p.Roles {
		if rp.Active {
			out[role] = true
		}
	}
	return out
}
