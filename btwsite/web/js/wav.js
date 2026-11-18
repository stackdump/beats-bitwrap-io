// A streaming WAV reader. /api/render/<cid>?format=wav answers a RIFF header whose RIFF and data sizes are
// 0xFFFFFFFF (the length is not known yet), then PCM as it renders. Chunks arrive at arbitrary byte
// boundaries (a split header, half a frame), so this keeps what it cannot use yet and hands back planar
// Float32 channels as soon as whole frames exist. 16-bit PCM and 32-bit float are read; anything else
// is refused with a message. Pure: no DOM, no Web Audio, so Node tests it.

const U32_UNKNOWN = 0xffffffff;
const MAX_SKIP = 1 << 20; // a non-data chunk (LIST ...) bigger than this is not a WAV we know

export class WavStream {
  constructor() {
    this.head = new Uint8Array(0); // bytes of the header read so far
    this.header = null; // {sampleRate, channels, bits, format, blockAlign, dataSize|null} once parsed
    this.rest = new Uint8Array(0); // bytes of a frame not yet whole
    this.framesOut = 0;
    this.dataLeft = Infinity;
  }

  /** The seconds of audio delivered so far. */
  get seconds() {
    return this.header ? this.framesOut / this.header.sampleRate : 0;
  }

  /**
   * Feed a chunk. Returns null while the header is still incomplete or the chunk holds no whole frame,
   * else {channels: [Float32Array, ...], frames}. Throws an Error with a plain message on a stream that is not WAV.
   */
  push(chunk) {
    let bytes = chunk;
    if (!this.header) {
      this.head = concat(this.head, chunk);
      const used = this._parseHeader();
      if (used < 0) return null;
      bytes = this.head.subarray(used);
      this.head = new Uint8Array(0);
    }
    return this._pcm(bytes);
  }

  /** Returns the byte count of the header (up to the first data byte), or -1 when more bytes are needed. */
  _parseHeader() {
    const b = this.head;
    if (b.length < 12) return -1;
    if (str(b, 0, 4) !== 'RIFF' || str(b, 8, 4) !== 'WAVE') throw new Error('not a WAV stream (no RIFF/WAVE header)');
    let pos = 12;
    let fmt = null;
    for (;;) {
      if (b.length < pos + 8) return -1;
      const id = str(b, pos, 4);
      const size = u32(b, pos + 4);
      if (id === 'data') {
        if (!fmt) throw new Error('WAV data before its fmt chunk');
        const bytesPer = fmt.bits / 8;
        this.header = { ...fmt, blockAlign: fmt.channels * bytesPer, bytesPer, dataSize: size === U32_UNKNOWN || size === 0 ? null : size };
        this.dataLeft = this.header.dataSize == null ? Infinity : this.header.dataSize;
        return pos + 8;
      }
      if (size > MAX_SKIP) throw new Error(`unexpected WAV chunk "${id}" of ${size} bytes`);
      const total = size + (size & 1);
      if (b.length < pos + 8 + total) return -1;
      if (id === 'fmt ') {
        if (size < 16) throw new Error('short WAV fmt chunk');
        let format = u16(b, pos + 8);
        const channels = u16(b, pos + 10);
        const sampleRate = u32(b, pos + 12);
        const bits = u16(b, pos + 22);
        if (format === 0xfffe && size >= 40) format = u16(b, pos + 8 + 24); // WAVE_FORMAT_EXTENSIBLE: the sub-format's first word
        if (!(format === 1 && bits === 16) && !(format === 3 && bits === 32)) throw new Error(`WAV format ${format}/${bits} bit is not supported (16-bit PCM or 32-bit float)`);
        if (channels < 1 || channels > 8 || !sampleRate) throw new Error('bad WAV fmt chunk');
        fmt = { format, channels, sampleRate, bits };
      }
      pos += 8 + total;
    }
  }

  _pcm(bytes) {
    const h = this.header;
    let all = this.rest.length ? concat(this.rest, bytes) : bytes;
    if (all.length > this.dataLeft) all = all.subarray(0, this.dataLeft);
    const frames = Math.floor(all.length / h.blockAlign);
    const used = frames * h.blockAlign;
    this.rest = used < all.length ? all.slice(used) : new Uint8Array(0);
    if (this.dataLeft !== Infinity) this.dataLeft -= used;
    if (!frames) return null;
    const dv = new DataView(all.buffer, all.byteOffset, used);
    const channels = Array.from({ length: h.channels }, () => new Float32Array(frames));
    let off = 0;
    if (h.format === 1) {
      for (let i = 0; i < frames; i++) for (let c = 0; c < h.channels; c++, off += 2) channels[c][i] = dv.getInt16(off, true) / 32768;
    } else {
      for (let i = 0; i < frames; i++) for (let c = 0; c < h.channels; c++, off += 4) channels[c][i] = dv.getFloat32(off, true);
    }
    this.framesOut += frames;
    return { channels, frames };
  }
}

function concat(a, b) {
  if (!a.length) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
const str = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** A streaming WAV header for tests and the mock server (sizes unknown, 0xFFFFFFFF). */
export function wavHeader({ sampleRate = 44100, channels = 2, bits = 16, format = 1, dataSize = U32_UNKNOWN } = {}) {
  const b = new Uint8Array(44);
  const dv = new DataView(b.buffer);
  b.set([0x52, 0x49, 0x46, 0x46], 0);
  dv.setUint32(4, dataSize === U32_UNKNOWN ? U32_UNKNOWN : 36 + dataSize, true);
  b.set([0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20], 8);
  dv.setUint32(16, 16, true);
  dv.setUint16(20, format, true);
  dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, (sampleRate * channels * bits) / 8, true);
  dv.setUint16(32, (channels * bits) / 8, true);
  dv.setUint16(34, bits, true);
  b.set([0x64, 0x61, 0x74, 0x61], 36);
  dv.setUint32(40, dataSize, true);
  return b;
}
