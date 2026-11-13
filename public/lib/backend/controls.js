// Control-net actions djrust does not run itself: `fire-macro` (arrange's macroCurve, a
// hand-authored macro-orchestrated share), `set-feel` (arrange's feelCurve) and
// `set-visualizer`. djrust plays the project's control nets (mutes, slots, stop) but reports no
// fire for these, so the studio works out when they fire and runs them as djrust's clock
// passes that tick.
//
// The control nets are deterministic: the same executor as the worker and djrust (lib/net.js,
// deterministicRand conflicts) ticked offline from the top gives every control fire's tick. A
// user mute changes what sounds, not when a control net fires, so the plan holds for the whole
// play. It is rebuilt on every project load.

import { compileProject, tick } from '../net.js';

const ACTIONS = new Set(['fire-macro', 'set-feel', 'set-visualizer']);
const MAX_TICKS = 20000;   // ~40 minutes at 120 BPM; a song's stop-transport ends it sooner
const MAX_JUMP = 64;       // a tick jump larger than this is a seek: skip, do not replay

function hasActions(project) {
    for (const n of Object.values(project?.nets || {})) {
        if (n?.role !== 'control') continue;
        for (const t of Object.values(n.transitions || {})) {
            if (ACTIONS.has(t?.control?.action)) return true;
        }
    }
    return false;
}

/** The ticks at which `project`'s fire-macro / set-feel / set-visualizer controls fire. */
export function planControls(project) {
    if (!hasActions(project)) return [];
    const g = compileProject(project);
    const out = [];
    while (g.tick < MAX_TICKS && !g.stopRequested) {
        tick(g, null);
        for (let i = 0; i < g.controlCount; i += 2) {
            const n = g.nets[g.controls[i]];
            const tid = n.transIds[g.controls[i + 1]];
            const c = n.bundle.controlBindings[tid];
            if (c && ACTIONS.has(c.action)) out.push({ tick: g.tick, netId: n.id, transitionId: tid, control: c });
        }
    }
    return out;
}

/** project-sync: plan the new project's controls (off the sync path; it can take a few ms). */
export function planProjectControls(el, project) {
    const serial = (el._controlPlanSerial = (el._controlPlanSerial || 0) + 1);
    el._controlPlan = null;
    if (!hasActions(project)) return;
    setTimeout(() => {
        if (serial !== el._controlPlanSerial) return;
        try {
            el._controlPlan = { fires: planControls(project), i: 0 };
        } catch (err) {
            console.warn('control plan failed:', err);
        }
    }, 0);
}

/**
 * state-sync: run the planned controls whose tick djrust's clock passed since the last sync,
 * as the worker's `control-fired` did.
 */
export function runControls(el, prevTick, curTick) {
    const plan = el._controlPlan;
    if (!plan || !plan.fires.length) return;
    const fires = plan.fires;
    const seek = curTick < prevTick || curTick - prevTick > MAX_JUMP;
    if (seek) {
        // back to the top, a loop wrap, or a seek: line up with where the clock is now
        let i = 0;
        while (i < fires.length && fires[i].tick <= curTick) i++;
        plan.i = i;
        return;
    }
    while (plan.i < fires.length && fires[plan.i].tick <= curTick) {
        const f = fires[plan.i++];
        if (f.tick > prevTick) {
            el._handleWsMessage?.({ type: 'control-fired', netId: f.netId, transitionId: f.transitionId, control: f.control });
        }
    }
}
