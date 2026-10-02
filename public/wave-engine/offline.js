/**
 * offline.js — render a (genre, seed, structure) to PCM with the same
 * WaveRunner the AudioWorklet uses, in the same 128-frame blocks. Pure ES
 * module with no Node or DOM APIs, so it runs in Node, a Worker, or the page.
 */

import { compose } from '../lib/generator/composer.js?v=6';
import { projectToJSON } from '../lib/pflow.js';
import { WaveRunner } from './runner.js';

export const BLOCK = 128;

/** The project JSON a (genre, seed, structure) composes to. */
export function composeProject(genre, seed, structure) {
    const params = { seed };
    if (structure && structure !== 'loop') params.structure = structure;
    return projectToJSON(compose(genre, params));
}

/**
 * renderOffline({ genre, seed, structure, seconds, sampleRate, project, runner })
 * → { left: Float32Array, right: Float32Array, runner, project }.
 * Pass `project` to render a hand-built project instead of composing one;
 * `runner` options are forwarded to WaveRunner.
 */
export function renderOffline(o) {
    const sr = o.sampleRate || 48000;
    const project = o.project || composeProject(o.genre || 'techno', o.seed ?? 42, o.structure);
    const runner = new WaveRunner(sr, o.runner || {});
    runner.load(project);
    if (o.tempo) runner.setTempo(o.tempo);
    runner.play();
    const frames = Math.round((o.seconds ?? 10) * sr);
    const left = new Float32Array(frames), right = new Float32Array(frames);
    for (let off = 0; off < frames; off += BLOCK) {
        const n = Math.min(BLOCK, frames - off);
        runner.process(left.subarray(off, off + n), right.subarray(off, off + n), n);
    }
    return { left, right, runner, project };
}

/** 16-bit PCM WAV (RIFF) bytes for one or two channels. */
export function encodeWav(channels, sampleRate) {
    const ch = channels.length, frames = channels[0].length;
    const bytes = new Uint8Array(44 + frames * ch * 2);
    const dv = new DataView(bytes.buffer);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i); };
    str(0, 'RIFF'); dv.setUint32(4, 36 + frames * ch * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, ch, true);
    dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * ch * 2, true);
    dv.setUint16(32, ch * 2, true); dv.setUint16(34, 16, true);
    str(36, 'data'); dv.setUint32(40, frames * ch * 2, true);
    let o = 44;
    for (let i = 0; i < frames; i++) {
        for (let c = 0; c < ch; c++) {
            const x = Math.max(-1, Math.min(1, channels[c][i]));
            dv.setInt16(o, x < 0 ? Math.round(x * 32768) : Math.round(x * 32767), true);
            o += 2;
        }
    }
    return bytes;
}
