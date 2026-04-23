package ws

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"

	"beats-bitwrap-io/internal/pflow"

	"github.com/gorilla/websocket"
)

const (
	broadcastBufSize  = 256
	clientSendBufSize = 256
	readBufSize       = 1024
	writeBufSize      = 1024
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  readBufSize,
	WriteBufferSize: writeBufSize,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

// Hub manages WebSocket connections and message broadcasting
type Hub struct {
	clients    map[*Client]bool
	broadcast  chan []byte
	register   chan *Client
	unregister chan *Client
	seq        SequencerControl
	mu         sync.RWMutex

	// Generator function, set by main
	OnGenerate func(genre string, params map[string]interface{}) (map[string]interface{}, error)

	// Preview generator: generates without loading into sequencer
	OnGeneratePreview func(genre string, params map[string]interface{}) (map[string]interface{}, error)

	// Arrange callback: wraps current project with structure
	OnArrange func(genre, structure string) (map[string]interface{}, error)

	// Shuffle instruments callback, set by main
	OnShuffleInstruments func(seed int64) (map[string]string, error)
}

// Client represents a single WebSocket connection
type Client struct {
	hub  *Hub
	conn *websocket.Conn
	send chan []byte
}

// NewHub creates a new Hub instance
func NewHub(seq SequencerControl) *Hub {
	return &Hub{
		clients:    make(map[*Client]bool),
		broadcast:  make(chan []byte, broadcastBufSize),
		register:   make(chan *Client),
		unregister: make(chan *Client),
		seq:        seq,
	}
}

// Run starts the hub's main loop
func (h *Hub) Run() {
	for {
		select {
		case client := <-h.register:
			h.mu.Lock()
			h.clients[client] = true
			h.mu.Unlock()
			log.Printf("Client connected (%d total)", len(h.clients))

		case client := <-h.unregister:
			h.mu.Lock()
			if _, ok := h.clients[client]; ok {
				delete(h.clients, client)
				close(client.send)
			}
			h.mu.Unlock()
			log.Printf("Client disconnected (%d remaining)", len(h.clients))

		case message := <-h.broadcast:
			h.mu.RLock()
			var stale []*Client
			for client := range h.clients {
				select {
				case client.send <- message:
				default:
					stale = append(stale, client)
				}
			}
			h.mu.RUnlock()
			// The RLock→Lock gap here is safe: the buffered client.send
			// (clientSendBufSize) absorbs any in-flight messages from
			// concurrent broadcasts. A client detected as stale already
			// had a full buffer, so no new send can succeed on it.
			if len(stale) > 0 {
				h.mu.Lock()
				for _, client := range stale {
					if _, ok := h.clients[client]; ok {
						close(client.send)
						delete(h.clients, client)
					}
				}
				h.mu.Unlock()
			}
		}
	}
}

// ServeWS handles WebSocket upgrade requests
func (h *Hub) ServeWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade error: %v", err)
		return
	}

	client := &Client{
		hub:  h,
		conn: conn,
		send: make(chan []byte, clientSendBufSize),
	}

	h.register <- client

	go client.writePump()
	go client.readPump()
}

// BroadcastTransitionFired sends transition fired event to all clients
func (h *Hub) BroadcastTransitionFired(netId, transitionId string, midi *pflow.MidiBinding) {
	msg := TransitionFiredMessage{
		Type:         "transition-fired",
		NetId:        netId,
		TransitionId: transitionId,
		Midi:         midi,
	}
	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("Failed to marshal transition-fired: %v", err)
		return
	}
	h.broadcast <- data
}

// BroadcastStateSync sends state synchronization to all clients
func (h *Hub) BroadcastStateSync(state map[string]map[string]float64, tick uint64) {
	msg := StateSyncMessage{
		Type:  "state-sync",
		State: state,
		Tick:  tick,
	}
	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("Failed to marshal state-sync: %v", err)
		return
	}
	h.broadcast <- data
}

// BroadcastTempoChanged sends tempo change to all clients
func (h *Hub) BroadcastTempoChanged(tempo float64) {
	msg := TempoChangedMessage{
		Type:  "tempo-changed",
		Tempo: tempo,
	}
	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("Failed to marshal tempo-changed: %v", err)
		return
	}
	h.broadcast <- data
}

// BroadcastInstrumentsChanged sends instrument changes to all clients
func (h *Hub) BroadcastInstrumentsChanged(instruments map[string]string) {
	msg := InstrumentsChangedMessage{
		Type:        "instruments-changed",
		Instruments: instruments,
	}
	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("Failed to marshal instruments-changed: %v", err)
		return
	}
	h.broadcast <- data
}

// BroadcastProjectSync sends a full project to all clients
func (h *Hub) BroadcastProjectSync(project map[string]interface{}) {
	msg := ProjectSyncMessage{
		Type:    "project-sync",
		Project: project,
	}
	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("Failed to marshal project-sync: %v", err)
		return
	}
	h.broadcast <- data
}

// readPump pumps messages from the WebSocket connection to the hub
func (c *Client) readPump() {
	defer func() {
		c.hub.unregister <- c
		c.conn.Close()
	}()

	for {
		_, message, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("WebSocket read error: %v", err)
			}
			break
		}
		c.handleMessage(message)
	}
}

// writePump pumps messages from the hub to the WebSocket connection
func (c *Client) writePump() {
	defer c.conn.Close()

	for message := range c.send {
		if err := c.conn.WriteMessage(websocket.TextMessage, message); err != nil {
			log.Printf("WebSocket write error: %v", err)
			return
		}
	}
}

// handleMessage processes incoming messages from clients
func (c *Client) handleMessage(data []byte) {
	var base BaseMessage
	if err := json.Unmarshal(data, &base); err != nil {
		log.Printf("Message parse error: %v", err)
		return
	}

	switch base.Type {
	case "transport":
		var msg TransportMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			log.Printf("Failed to unmarshal transport: %v", err)
			return
		}
		c.handleTransport(msg)

	case "tempo":
		var msg TempoMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			log.Printf("Failed to unmarshal tempo: %v", err)
			return
		}
		c.handleTempo(msg)

	case "project-load":
		var msg ProjectLoadMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			log.Printf("Failed to unmarshal project-load: %v", err)
			return
		}
		c.handleProjectLoad(msg)

	case "transition-fire":
		var msg TransitionFireMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			log.Printf("Failed to unmarshal transition-fire: %v", err)
			return
		}
		c.handleTransitionFire(msg)

	case "generate":
		var msg GenerateMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			log.Printf("Failed to unmarshal generate: %v", err)
			return
		}
		c.handleGenerate(msg)

	case "shuffle-instruments":
		var msg ShuffleInstrumentsMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			log.Printf("Failed to unmarshal shuffle-instruments: %v", err)
			return
		}
		c.handleShuffleInstruments(msg)

	case "mute":
		var msg MuteMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			log.Printf("Failed to unmarshal mute: %v", err)
			return
		}
		c.handleMute(msg)

	case "instrument-change":
		var msg InstrumentChangeMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			log.Printf("Failed to unmarshal instrument-change: %v", err)
			return
		}
		changed := c.hub.seq.SetInstrument(msg.NetId, msg.RiffGroup, msg.Instrument)
		if len(changed) > 0 {
			c.hub.BroadcastInstrumentsChanged(changed)
		}

	case "mute-group":
		var msg MuteGroupMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			log.Printf("Failed to unmarshal mute-group: %v", err)
			return
		}
		c.hub.seq.SetGroupMuted(msg.RiffGroup, msg.Muted)

	case "seek":
		var msg SeekMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			log.Printf("Failed to unmarshal seek: %v", err)
			return
		}
		c.handleSeek(msg)

	case "crop":
		var msg CropMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			log.Printf("Failed to unmarshal crop: %v", err)
			return
		}
		wasPlaying := c.hub.seq.IsPlaying()
		if wasPlaying {
			c.hub.seq.Stop()
		}
		project := c.hub.seq.CropProject(msg.StartTick, msg.EndTick)
		if project != nil {
			c.hub.BroadcastProjectSync(project)
			c.hub.BroadcastLoopChanged(-1, -1)
		}

	case "loop":
		var msg LoopMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			log.Printf("Failed to unmarshal loop: %v", err)
			return
		}
		c.hub.seq.SetLoop(msg.StartTick, msg.EndTick)
		c.hub.BroadcastLoopChanged(msg.StartTick, msg.EndTick)

	case "arrange":
		var msg ArrangeMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			log.Printf("Failed to unmarshal arrange: %v", err)
			return
		}
		if c.hub.OnArrange == nil {
			log.Printf("No arrange handler configured")
			return
		}
		project, err := c.hub.OnArrange(msg.Genre, msg.Structure)
		if err != nil {
			log.Printf("Arrange error: %v", err)
			return
		}
		if project != nil {
			c.hub.BroadcastProjectSync(project)
		}

	case "deterministic-loop":
		var msg DeterministicLoopMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			log.Printf("Failed to unmarshal deterministic-loop: %v", err)
			return
		}
		c.hub.seq.SetDeterministicLoop(msg.Enabled)

	case "generate-preview":
		var msg GeneratePreviewMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			log.Printf("Failed to unmarshal generate-preview: %v", err)
			return
		}
		c.handleGeneratePreview(msg)

	default:
		log.Printf("Unknown message type: %s", base.Type)
	}
}

func (c *Client) handleTransport(msg TransportMessage) {
	switch msg.Action {
	case "play":
		c.hub.seq.Play()
	case "stop":
		c.hub.seq.Stop()
	case "pause":
		c.hub.seq.Pause()
	}
}

func (c *Client) handleTempo(msg TempoMessage) {
	c.hub.seq.SetTempo(msg.BPM)
	c.hub.BroadcastTempoChanged(msg.BPM)
}

func (c *Client) handleProjectLoad(msg ProjectLoadMessage) {
	c.hub.seq.LoadProject(msg.Project)
}

func (c *Client) handleTransitionFire(msg TransitionFireMessage) {
	c.hub.seq.FireTransition(msg.NetId, msg.TransitionId)
}

func (c *Client) handleGenerate(msg GenerateMessage) {
	if c.hub.OnGenerate == nil {
		log.Printf("No generator configured")
		return
	}
	project, err := c.hub.OnGenerate(msg.Genre, msg.Params)
	if err != nil {
		log.Printf("Generate error: %v", err)
		return
	}
	// project is nil when the sequencer queues a bar-boundary swap
	// (it broadcasts project-sync itself via OnProjectSwapped)
	if project != nil {
		c.hub.BroadcastProjectSync(project)
	}
}

func (c *Client) handleShuffleInstruments(msg ShuffleInstrumentsMessage) {
	if c.hub.OnShuffleInstruments == nil {
		log.Printf("No shuffle handler configured")
		return
	}
	instruments, err := c.hub.OnShuffleInstruments(msg.Seed)
	if err != nil {
		log.Printf("Shuffle error: %v", err)
		return
	}
	c.hub.BroadcastInstrumentsChanged(instruments)
}

func (c *Client) handleMute(msg MuteMessage) {
	c.hub.seq.SetMuted(msg.NetId, msg.Muted)
}

func (c *Client) handleGeneratePreview(msg GeneratePreviewMessage) {
	if c.hub.OnGenerate == nil {
		log.Printf("No generator configured")
		return
	}
	// Generate without loading into sequencer — preview only
	project, err := c.hub.OnGeneratePreview(msg.Genre, msg.Params)
	if err != nil {
		log.Printf("Generate preview error: %v", err)
		return
	}
	if project == nil {
		return
	}
	// Send only to the requesting client, not broadcast
	resp := PreviewReadyMessage{
		Type:    "preview-ready",
		Project: project,
	}
	data, err := json.Marshal(resp)
	if err != nil {
		log.Printf("Failed to marshal preview-ready: %v", err)
		return
	}
	select {
	case c.send <- data:
	default:
		log.Printf("Client send buffer full, dropping preview")
	}
}

func (c *Client) handleSeek(msg SeekMessage) {
	wasPlaying := c.hub.seq.IsPlaying()
	if wasPlaying {
		c.hub.seq.Pause()
	}
	c.hub.seq.Seek(msg.Tick)
	if wasPlaying {
		c.hub.seq.Play()
	}
}

// BroadcastControlFired sends control event to all clients
func (h *Hub) BroadcastControlFired(netId, transitionId string, ctrl *pflow.ControlBinding) {
	msg := ControlFiredMessage{
		Type:         "control-fired",
		NetId:        netId,
		TransitionId: transitionId,
		Control:      ctrl,
	}
	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("Failed to marshal control-fired: %v", err)
		return
	}
	h.broadcast <- data
}

// BroadcastPlaybackComplete notifies all clients that playback has ended
func (h *Hub) BroadcastPlaybackComplete() {
	msg := PlaybackCompleteMessage{Type: "playback-complete"}
	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("Failed to marshal playback-complete: %v", err)
		return
	}
	h.broadcast <- data
}

// BroadcastLoopChanged sends loop state to all clients
func (h *Hub) BroadcastLoopChanged(startTick, endTick int64) {
	msg := LoopChangedMessage{
		Type:      "loop-changed",
		StartTick: startTick,
		EndTick:   endTick,
	}
	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("Failed to marshal loop-changed: %v", err)
		return
	}
	h.broadcast <- data
}

// BroadcastMuteState sends mute state to all clients
func (h *Hub) BroadcastMuteState(mutedNets map[string]bool, mutedNotes map[string]map[int]bool) {
	msg := MuteStateMessage{
		Type:       "mute-state",
		MutedNets:  mutedNets,
		MutedNotes: mutedNotes,
	}
	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("Failed to marshal mute-state: %v", err)
		return
	}
	h.broadcast <- data
}
