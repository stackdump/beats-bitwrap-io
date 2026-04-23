package routes

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"beats-bitwrap-io/internal/generator"
	"beats-bitwrap-io/internal/pflow"
	"beats-bitwrap-io/internal/sequencer"
	"beats-bitwrap-io/internal/ws"
)

// Server holds dependencies for HTTP route handlers.
type Server struct {
	seq *sequencer.Sequencer
	hub *ws.Hub
}

// NewServer creates a Server with the given dependencies.
func NewServer(seq *sequencer.Sequencer, hub *ws.Hub) *Server {
	return &Server{seq: seq, hub: hub}
}

// RegisterRoutes adds all HTTP handlers to the given mux. The caller
// supplies the root handler so it can wrap index.html with share-card
// OG/JSON-LD decoration when ?cid= is present (see internal/share).
func (s *Server) RegisterRoutes(mux *http.ServeMux, rootHandler http.Handler) {
	mux.Handle("/", rootHandler)
	mux.HandleFunc("/ws", s.hub.ServeWS)
	mux.HandleFunc("/api/song.jsonld", s.handleSongJSONLD)
	mux.HandleFunc("/api/generate-preview", s.handleGeneratePreview)
	mux.HandleFunc("/api/generate", s.handleGenerate)
	mux.HandleFunc("/api/transport", s.handleTransport)
	mux.HandleFunc("/api/tempo", s.handleTempo)
	mux.HandleFunc("/api/project", s.handleProject)
	mux.HandleFunc("/api/genres", s.handleGenres)
	mux.HandleFunc("/api/shuffle-instruments", s.handleShuffleInstruments)
	mux.HandleFunc("/api/mute", s.handleMute)
	mux.HandleFunc("/api/instruments", s.handleInstruments)
	mux.HandleFunc("/api/instrument", s.handleInstrument)
	mux.HandleFunc("/api/arrange", s.handleArrange)
	mux.HandleFunc("/api/save", s.handleSave)
	mux.HandleFunc("/api/vote", s.handleVote)
	mux.HandleFunc("/api/tracks/", s.handleLoadTrack)
	mux.HandleFunc("/api/tracks", s.handleListTracks)
}

func (s *Server) handleSongJSONLD(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		genre := r.URL.Query().Get("genre")
		if genre == "" {
			genre = "techno"
		}
		params := map[string]interface{}{}
		if st := r.URL.Query().Get("structure"); st != "" {
			params["structure"] = st
		}
		proj := generator.Compose(genre, params)
		baseURL := "http://" + r.Host
		ld := proj.ToJSONLD(baseURL)
		w.Header().Set("Content-Type", "application/ld+json")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		json.NewEncoder(w).Encode(ld)
		return
	}
	if r.Method == http.MethodPost {
		var ld map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&ld); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		projData, ok := ld["petriNote:project"].(map[string]interface{})
		if !ok {
			http.Error(w, "missing petriNote:project in JSON-LD", http.StatusBadRequest)
			return
		}
		s.seq.Stop()
		s.seq.LoadProject(projData)
		s.hub.BroadcastProjectSync(projData)
		s.seq.Play()
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"ok":true,"action":"loaded and playing"}`)
		return
	}
	http.Error(w, "GET or POST only", http.StatusMethodNotAllowed)
}

func (s *Server) handleGeneratePreview(w http.ResponseWriter, r *http.Request) {
	params := map[string]interface{}{}
	genre := r.URL.Query().Get("genre")
	if r.Method == http.MethodPost {
		var req struct {
			Genre       string                 `json:"genre"`
			Params      map[string]interface{} `json:"params"`
			Instruments map[string]interface{} `json:"instruments"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err == nil {
			if req.Genre != "" {
				genre = req.Genre
			}
			for k, v := range req.Params {
				params[k] = v
			}
			if len(req.Instruments) > 0 {
				params["instruments"] = req.Instruments
			}
		}
	}
	if genre == "" {
		genre = "techno"
	}
	if st := r.URL.Query().Get("structure"); st != "" {
		params["structure"] = st
	}
	proj := generator.Compose(genre, params)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(proj.ToJSON())
}

func (s *Server) handleGenerate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Genre  string                 `json:"genre"`
		Params map[string]interface{} `json:"params"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	s.seq.Stop()
	proj := generator.Compose(req.Genre, req.Params)
	s.seq.LoadPflowProject(proj)
	if len(proj.InitialMutes) > 0 {
		s.seq.SetInitialMutes(proj.InitialMutes)
	}
	projJSON := proj.ToJSON()
	s.hub.BroadcastProjectSync(projJSON)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(projJSON)
}

func (s *Server) handleArrange(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Genre          string                     `json:"genre"`
		Structure      string                     `json:"structure"`
		Seed           *int64                     `json:"arrangeSeed"`
		VelocityDeltas map[string]int             `json:"velocityDeltas"`
		MaxVariants    int                        `json:"maxVariants"`
		FadeIn         []string                   `json:"fadeIn"`
		DrumBreak      int                        `json:"drumBreak"`
		Sections       []generator.AuthorSection  `json:"sections"`
		FeelCurve      []generator.FeelPoint      `json:"feelCurve"`
		MacroCurve     []generator.MacroPoint     `json:"macroCurve"`
		OverlayOnly    bool                       `json:"overlay"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if req.Genre == "" {
		req.Genre = "techno"
	}
	if req.Structure == "" {
		req.Structure = "standard"
	}

	// Get current project, parse it, arrange, reload
	projJSON := s.seq.GetProject()
	if projJSON == nil {
		http.Error(w, "no project loaded", http.StatusBadRequest)
		return
	}

	proj := pflow.ParseProject(projJSON)
	opts := generator.ArrangeOpts{
		VelocityDeltas: req.VelocityDeltas,
		MaxVariants:    req.MaxVariants,
		FadeIn:         req.FadeIn,
		DrumBreak:      req.DrumBreak,
		Sections:       req.Sections,
		FeelCurve:      req.FeelCurve,
		MacroCurve:     req.MacroCurve,
		OverlayOnly:    req.OverlayOnly,
	}
	if req.Seed != nil {
		opts.Seed = *req.Seed
	} else {
		opts.Seed = time.Now().UnixNano()
	}
	generator.ArrangeWithOpts(proj, req.Genre, req.Structure, opts)

	s.seq.Stop()
	s.seq.LoadPflowProject(proj)
	if len(proj.InitialMutes) > 0 {
		s.seq.SetInitialMutes(proj.InitialMutes)
	}
	result := proj.ToJSON()
	s.hub.BroadcastProjectSync(result)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

func (s *Server) handleTransport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Action string `json:"action"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	switch req.Action {
	case "play":
		s.seq.Play()
	case "stop":
		s.seq.Stop()
	case "pause":
		s.seq.Pause()
	default:
		http.Error(w, "unknown action: "+req.Action, http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprintf(w, `{"ok":true,"action":%q}`, req.Action)
}

func (s *Server) handleTempo(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		BPM float64 `json:"bpm"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	s.seq.SetTempo(req.BPM)
	s.hub.BroadcastTempoChanged(req.BPM)
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprintf(w, `{"ok":true,"bpm":%.1f}`, req.BPM)
}

func (s *Server) handleProject(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		proj := s.seq.GetProject()
		w.Header().Set("Content-Type", "application/json")
		if proj == nil {
			fmt.Fprint(w, "null")
			return
		}
		json.NewEncoder(w).Encode(proj)
		return
	}
	if r.Method == http.MethodPost {
		var projData map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&projData); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		s.seq.Stop()
		s.seq.LoadProject(projData)
		s.hub.BroadcastProjectSync(projData)
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"ok":true}`)
		return
	}
	http.Error(w, "GET or POST only", http.StatusMethodNotAllowed)
}

func (s *Server) handleGenres(w http.ResponseWriter, r *http.Request) {
	type genreInfo struct {
		Name             string  `json:"name"`
		BPM              float64 `json:"bpm"`
		DrumFills        bool    `json:"drumFills"`
		WalkingBass      bool    `json:"walkingBass"`
		Polyrhythm       int     `json:"polyrhythm"`
		Syncopation      float64 `json:"syncopation"`
		CallResponse     bool    `json:"callResponse"`
		TensionCurve     bool    `json:"tensionCurve"`
		ModalInterchange float64 `json:"modalInterchange"`
		GhostNotes       float64 `json:"ghostNotes"`
		Swing            float64 `json:"swing"`
		Humanize         float64 `json:"humanize"`
	}
	result := map[string]genreInfo{}
	for name, g := range generator.Genres {
		result[name] = genreInfo{
			Name:             g.Name,
			BPM:              g.BPM,
			DrumFills:        g.DrumFills,
			WalkingBass:      g.WalkingBass,
			Polyrhythm:       g.Polyrhythm,
			Syncopation:      g.Syncopation,
			CallResponse:     g.CallResponse,
			TensionCurve:     g.TensionCurve,
			ModalInterchange: g.ModalInterchange,
			GhostNotes:       g.GhostNotes,
			Swing:            g.Swing,
			Humanize:         g.Humanize,
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

func (s *Server) handleShuffleInstruments(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Seed int64 `json:"seed"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	result := s.seq.ShuffleInstruments(req.Seed)
	if result == nil {
		http.Error(w, "no project loaded", http.StatusBadRequest)
		return
	}
	s.hub.BroadcastInstrumentsChanged(result)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

func (s *Server) handleMute(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		NetId string `json:"netId"`
		Muted bool   `json:"muted"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	s.seq.SetMuted(req.NetId, req.Muted)
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprintf(w, `{"ok":true,"netId":%q,"muted":%v}`, req.NetId, req.Muted)
}

// handleInstrument swaps one net's track.instrument (or every net in a
// riff group when `riffGroup` is set) and broadcasts the resolved map
// so every WS client's mixer dropdown updates in lockstep.
func (s *Server) handleInstrument(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		NetId      string `json:"netId"`
		RiffGroup  string `json:"riffGroup"`
		Instrument string `json:"instrument"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if req.Instrument == "" {
		http.Error(w, "instrument required", http.StatusBadRequest)
		return
	}
	changed := s.seq.SetInstrument(req.NetId, req.RiffGroup, req.Instrument)
	if len(changed) > 0 {
		s.hub.BroadcastInstrumentsChanged(changed)
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "changed": changed})
}

func (s *Server) handleInstruments(w http.ResponseWriter, r *http.Request) {
	instruments := []string{
		"piano", "electric-piano", "bass", "sub-bass", "acid", "reese",
		"lead", "square-lead", "pwm-lead", "supersaw", "hoover",
		"detuned-saw", "wobble-bass", "distorted-lead", "scream-lead", "rave-stab",
		"pad", "warm-pad", "strings", "dark-pad",
		"fm-bell", "marimba", "vibes", "organ", "clavinet",
		"pluck", "bright-pluck", "muted-pluck",
		"metallic", "noise-hit",
		"drums", "drums-breakbeat", "drums-cr78", "drums-v8",
		"808-bass", "drums-808", "drums-lofi",
		"brass", "trumpet", "flute", "sax", "choir",
		"sitar", "kalimba", "steel-drum", "music-box",
		"harpsichord", "glass-pad",
		"tape-lead", "sync-lead", "rubber-bass", "talkbox",
		"acoustic-guitar", "electric-guitar", "distorted-guitar",
		"duo-lead", "duo-bass",
		"am-bell", "am-pad",
		"big-saw", "edm-stab", "trance-lead", "edm-pluck",
		"drop-bass", "chiptune", "rave-organ", "laser",
		"wobble-lead", "screech", "fm-bass",
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(instruments)
}

// WireCallbacks connects the sequencer events to the hub broadcasts
// and the generator/shuffle callbacks to the hub.
func WireCallbacks(seq *sequencer.Sequencer, hub *ws.Hub) {
	seq.OnTransitionFired = func(netId, transId string, midi *pflow.MidiBinding) {
		hub.BroadcastTransitionFired(netId, transId, midi)
	}
	seq.OnStateChange = func(state map[string]map[string]float64, tick uint64) {
		hub.BroadcastStateSync(state, tick)
	}
	seq.OnControlEvent = func(netId, transId string, ctrl *pflow.ControlBinding) {
		hub.BroadcastControlFired(netId, transId, ctrl)
	}
	seq.OnMuteChanged = func(mutedNets map[string]bool, mutedNotes map[string]map[int]bool) {
		hub.BroadcastMuteState(mutedNets, mutedNotes)
	}
	seq.OnPlaybackComplete = func() {
		hub.BroadcastPlaybackComplete()
	}
	seq.OnProjectSwapped = func(project map[string]interface{}) {
		hub.BroadcastProjectSync(project)
	}

	hub.OnGenerate = func(genre string, params map[string]interface{}) (map[string]interface{}, error) {
		// Queue for seamless bar-boundary swap (sequencer handles timing).
		// If not playing, QueueProject loads immediately.
		proj := generator.Compose(genre, params)
		seq.QueueProject(proj)
		return nil, nil
	}

	hub.OnArrange = func(genre, structure string) (map[string]interface{}, error) {
		projJSON := seq.GetProject()
		if projJSON == nil {
			return nil, fmt.Errorf("no project loaded")
		}
		proj := pflow.ParseProject(projJSON)
		generator.Arrange(proj, genre, structure)
		seq.Stop()
		seq.LoadPflowProject(proj)
		if len(proj.InitialMutes) > 0 {
			seq.SetInitialMutes(proj.InitialMutes)
		}
		return proj.ToJSON(), nil
	}

	hub.OnGeneratePreview = func(genre string, params map[string]interface{}) (map[string]interface{}, error) {
		proj := generator.Compose(genre, params)
		return proj.ToJSON(), nil
	}

	hub.OnShuffleInstruments = func(seed int64) (map[string]string, error) {
		result := seq.ShuffleInstruments(seed)
		if result == nil {
			return nil, fmt.Errorf("no project loaded")
		}
		return result, nil
	}
}

const dataDir = "data"

var (
	tagRe  = regexp.MustCompile(`^[A-Za-z0-9]{4}$`)
	voteMu sync.Mutex // serialize vote writes
)

// trackMeta is the sidecar metadata for a saved track.
type trackMeta struct {
	Tag     string          `json:"tag"`
	Owner   string          `json:"owner,omitempty"` // wallet address
	Genre   string          `json:"genre"`
	Name    string          `json:"name"`
	Created string          `json:"created"`
	Votes   map[string]vote `json:"votes"` // address -> vote
}

type vote struct {
	Sig       string `json:"sig"`
	Timestamp string `json:"timestamp"`
}

// handleSave stores a project JSON on disk keyed by its CID.
func (s *Server) handleSave(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Project   map[string]interface{} `json:"project"`
		Tag       string                 `json:"tag"`
		Address   string                 `json:"address,omitempty"`
		Signature string                 `json:"signature,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}
	if req.Project == nil {
		http.Error(w, "missing project", http.StatusBadRequest)
		return
	}

	// Validate tag
	tag := strings.ToUpper(req.Tag)
	if !tagRe.MatchString(tag) {
		http.Error(w, "tag must be exactly 4 alphanumeric characters", http.StatusBadRequest)
		return
	}

	// Parse to get a CID
	proj := pflow.ParseProject(req.Project)
	cid := proj.CID()
	if cid == "" {
		http.Error(w, "failed to compute CID", http.StatusInternalServerError)
		return
	}

	// Verify ownership signature if provided
	var owner string
	if req.Address != "" && req.Signature != "" {
		message := fmt.Sprintf("own:petri-note:%s", cid)
		recovered, err := verifyPersonalSign(message, req.Signature)
		if err != nil {
			http.Error(w, "invalid signature: "+err.Error(), http.StatusBadRequest)
			return
		}
		if !strings.EqualFold(recovered, req.Address) {
			http.Error(w, "signature does not match address", http.StatusForbidden)
			return
		}
		owner = strings.ToLower(req.Address)
	}

	// Ensure data directory exists
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		http.Error(w, "storage error", http.StatusInternalServerError)
		return
	}

	// Write project JSON
	data, err := json.MarshalIndent(req.Project, "", "  ")
	if err != nil {
		http.Error(w, "marshal error", http.StatusInternalServerError)
		return
	}
	projPath := filepath.Join(dataDir, cid+".jsonld")
	if err := os.WriteFile(projPath, data, 0o644); err != nil {
		http.Error(w, "write error", http.StatusInternalServerError)
		return
	}

	// Write metadata sidecar (only if it doesn't exist — don't overwrite)
	metaPath := filepath.Join(dataDir, cid+".meta.json")
	if _, err := os.Stat(metaPath); os.IsNotExist(err) {
		// Extract genre from project name
		genre := ""
		if name, ok := req.Project["name"].(string); ok {
			parts := strings.SplitN(name, " · ", 2)
			if len(parts) > 0 {
				genre = parts[0]
			}
		}
		meta := trackMeta{
			Tag:     tag,
			Owner:   owner,
			Genre:   genre,
			Name:    fmt.Sprintf("%v", req.Project["name"]),
			Created: time.Now().UTC().Format(time.RFC3339),
			Votes:   make(map[string]vote),
		}
		metaData, _ := json.MarshalIndent(meta, "", "  ")
		os.WriteFile(metaPath, metaData, 0o644)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"cid": cid, "owner": owner})
}

// handleVote processes an upvote signed with MetaMask.
func (s *Server) handleVote(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		CID       string `json:"cid"`
		Address   string `json:"address"`
		Signature string `json:"signature"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}
	if req.CID == "" || req.Address == "" || req.Signature == "" {
		http.Error(w, "missing cid, address, or signature", http.StatusBadRequest)
		return
	}

	// Verify signature
	message := fmt.Sprintf("upvote:petri-note:%s", req.CID)
	recovered, err := verifyPersonalSign(message, req.Signature)
	if err != nil {
		http.Error(w, "invalid signature: "+err.Error(), http.StatusBadRequest)
		return
	}
	if !strings.EqualFold(recovered, req.Address) {
		http.Error(w, "signature does not match address", http.StatusForbidden)
		return
	}

	addr := strings.ToLower(req.Address)
	metaPath := filepath.Join(dataDir, req.CID+".meta.json")

	voteMu.Lock()
	defer voteMu.Unlock()

	// Load existing metadata
	var meta trackMeta
	data, err := os.ReadFile(metaPath)
	if err != nil {
		http.Error(w, "track not found", http.StatusNotFound)
		return
	}
	if err := json.Unmarshal(data, &meta); err != nil {
		http.Error(w, "corrupt metadata", http.StatusInternalServerError)
		return
	}

	// Add vote (idempotent per address)
	if meta.Votes == nil {
		meta.Votes = make(map[string]vote)
	}
	meta.Votes[addr] = vote{
		Sig:       req.Signature,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
	}

	// Save
	updated, _ := json.MarshalIndent(meta, "", "  ")
	if err := os.WriteFile(metaPath, updated, 0o644); err != nil {
		http.Error(w, "write error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"ok":    true,
		"votes": len(meta.Votes),
	})
}

// handleLoadTrack loads a saved project by CID.
func (s *Server) handleLoadTrack(w http.ResponseWriter, r *http.Request) {
	cid := strings.TrimPrefix(r.URL.Path, "/api/tracks/")
	cid = strings.TrimSuffix(cid, ".jsonld")
	if cid == "" || strings.Contains(cid, "/") || strings.Contains(cid, "..") {
		http.Error(w, "invalid CID", http.StatusBadRequest)
		return
	}

	path := filepath.Join(dataDir, cid+".jsonld")
	data, err := os.ReadFile(path)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/ld+json")
	w.Write(data)
}

// handleListTracks lists all saved tracks with metadata, sorted by votes.
func (s *Server) handleListTracks(w http.ResponseWriter, r *http.Request) {
	entries, err := os.ReadDir(dataDir)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode([]interface{}{})
		return
	}

	type trackInfo struct {
		CID     string `json:"cid"`
		Name    string `json:"name"`
		Tag     string `json:"tag"`
		Owner   string `json:"owner,omitempty"`
		Genre   string `json:"genre"`
		Votes   int    `json:"votes"`
		Created string `json:"created"`
	}
	var tracks []trackInfo

	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".meta.json") {
			continue
		}
		cid := strings.TrimSuffix(e.Name(), ".meta.json")

		data, err := os.ReadFile(filepath.Join(dataDir, e.Name()))
		if err != nil {
			continue
		}
		var meta trackMeta
		if json.Unmarshal(data, &meta) != nil {
			continue
		}
		tracks = append(tracks, trackInfo{
			CID:     cid,
			Name:    meta.Name,
			Tag:     meta.Tag,
			Owner:   meta.Owner,
			Genre:   meta.Genre,
			Votes:   len(meta.Votes),
			Created: meta.Created,
		})
	}

	// Sort by votes descending
	for i := 0; i < len(tracks); i++ {
		for j := i + 1; j < len(tracks); j++ {
			if tracks[j].Votes > tracks[i].Votes {
				tracks[i], tracks[j] = tracks[j], tracks[i]
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(tracks)
}
