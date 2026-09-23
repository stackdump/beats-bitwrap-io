// A stand-in for navigator.requestMIDIAccess() that hands back objects shaped
// like MIDIAccess / MIDIInput / MIDIMessageEvent, so consumer code cannot tell
// the difference:
//
//   const access = await requestMockMIDIAccess({ inputs: [{ name: '...' }] });
//   for (const input of access.inputs.values()) input.onmidimessage = (e) => {
//       e.data       // Uint8Array, e.g. [0xB1, 0x0A, 0x01]
//       e.timeStamp  // DOMHighResTimeStamp on the performance.now() timeline
//       e.target     // the input
//   };
//
// Both delivery styles the real API supports work here: the `onmidimessage`
// handler property and addEventListener('midimessage', ...).
//
// The one method that is NOT part of Web MIDI is MockMIDIInput.receive(),
// which is how a simulator pushes bytes "down the cable".

class MockMIDIPort extends EventTarget {
    constructor({ id, name, manufacturer = '', version = '1.0', type }) {
        super();
        this.id = id;
        this.name = name;
        this.manufacturer = manufacturer;
        this.version = version;
        this.type = type;
        this.state = 'connected';
        this.connection = 'open';
        this.onstatechange = null;
    }
    async open() { this.connection = 'open'; return this; }
    async close() { this.connection = 'closed'; return this; }
}

export class MockMIDIInput extends MockMIDIPort {
    #handler = null;

    constructor(opts) {
        super({ ...opts, type: 'input' });
    }

    get onmidimessage() { return this.#handler; }
    set onmidimessage(fn) {
        if (this.#handler) this.removeEventListener('midimessage', this.#handler);
        this.#handler = typeof fn === 'function' ? fn : null;
        if (this.#handler) this.addEventListener('midimessage', this.#handler);
    }

    // Deliver one MIDI message. `timeStamp` is when the message "arrived at
    // the host"; like the real API it may be slightly in the past by the time
    // a handler runs, because delivery waits for the event loop. Consumers
    // that estimate speed should use e.timeStamp, never performance.now().
    receive(bytes, timeStamp = performance.now()) {
        if (this.connection !== 'open') return;
        const data = Uint8Array.from(bytes);
        const ev = typeof MIDIMessageEvent === 'function'
            ? new MIDIMessageEvent('midimessage', { data })
            : Object.assign(new Event('midimessage'), { data });
        // Event.timeStamp is fixed at construction; shadow it so interpolated
        // arrival times survive.
        Object.defineProperty(ev, 'timeStamp', { value: timeStamp });
        this.dispatchEvent(ev);
    }
}

export class MockMIDIAccess extends EventTarget {
    constructor(inputs) {
        super();
        this.inputs = new Map(inputs.map((i) => [i.id, i]));
        this.outputs = new Map();
        this.sysexEnabled = false;
        this.onstatechange = null;
    }
}

// Same call shape as navigator.requestMIDIAccess(options).
export async function requestMockMIDIAccess({ inputs = [] } = {}) {
    return new MockMIDIAccess(inputs.map((spec, n) => new MockMIDIInput({
        id: spec.id || `mock-input-${n}`,
        name: spec.name,
        manufacturer: spec.manufacturer,
    })));
}
