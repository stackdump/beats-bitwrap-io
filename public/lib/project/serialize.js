// Project serialization — compact a live project snapshot into the
// `.jsonld` file format used by upload/download and the save-to-server
// flow, and apply an uploaded file back onto the element.
//
// Extracted from petri-note.js (Phase A.5). Coupling is light: reads
// mixer/FX sliders from the DOM and applies back onto `el._project`
// and `el._mixerSliderState`. Nothing here touches the worker or
// tone engine directly.

export function loadUploadedProject(el, proj) {
    // Restore FX settings before loading project.
    if (proj.fx) {
        const setFx = (name, val) => {
            const slider = el.querySelector(`.pn-fx-slider[data-fx="${name}"]`);
            if (slider && val != null) {
                slider.value = val;
                slider.dispatchEvent(new Event('input', { bubbles: true }));
            }
        };
        setFx('master-vol', proj.fx.masterVol);
        setFx('reverb-size', proj.fx.reverbSize);
        setFx('reverb-damp', proj.fx.reverbDamp);
        setFx('reverb-wet', proj.fx.reverbWet);
        setFx('delay-time', proj.fx.delayTime);
        setFx('delay-feedback', proj.fx.delayFeedback);
        setFx('delay-wet', proj.fx.delayWet);
        setFx('distortion', proj.fx.distortion);
        setFx('hp-freq', proj.fx.hpFreq);
        setFx('lp-freq', proj.fx.lpFreq);
        setFx('phaser-freq', proj.fx.phaserFreq);
        setFx('phaser-depth', proj.fx.phaserDepth);
        setFx('phaser-wet', proj.fx.phaserWet);
        setFx('crush-bits', proj.fx.crushBits);
        setFx('master-pitch', proj.fx.masterPitch);
    }

    // Extract mix settings before they get lost in project load.
    const mixSettings = new Map();
    for (const [netId, net] of Object.entries(proj.nets || {})) {
        if (net.track?.mix) {
            mixSettings.set(netId, net.track.mix);
        }
    }

    el._project = proj;
    el._normalizeProject();
    el._activeNetId = Object.keys(el._project.nets)[0] || null;
    el._renderNet();
    el._renderMixer();
    el._reapplyChannelRoutings();
    el._sendWs({ type: 'project-load', project: proj });

    // Restore mix slider state after mixer is rendered.
    for (const [netId, mix] of mixSettings) {
        el._mixerSliderState.set(netId, {
            vol: mix.volume ?? 100,
            pan: mix.pan ?? 64,
            locut: mix.loCut ?? 0,
            lores: mix.loResonance ?? 5,
            cut: mix.cutoff ?? 100,
            res: mix.resonance ?? 5,
            dec: mix.decay ?? 100,
        });
    }
    el._restoreMixerSliderState();
}

export function serializeProject(el) {
    const proj = JSON.parse(JSON.stringify(el._project));

    // Compact: strip x/y, tokens, and default values from nets.
    for (const [netId, net] of Object.entries(proj.nets)) {
        const ch = net.track?.channel || 1;
        const defVel = net.track?.defaultVelocity || 100;

        // Strip defaultVelocity if 100.
        if (net.track?.defaultVelocity === 100) delete net.track.defaultVelocity;

        // Compact places.
        for (const [, place] of Object.entries(net.places || {})) {
            delete place.x; delete place.y; delete place.tokens;
            delete place['@type'];
            const initSum = (place.initial || [0]).reduce((a, b) => a + b, 0);
            if (initSum === 0) delete place.initial;
        }

        // Compact transitions.
        for (const [, trans] of Object.entries(net.transitions || {})) {
            delete trans.x; delete trans.y;
            if (trans.midi) {
                if (trans.midi.channel === ch) delete trans.midi.channel;
                if (trans.midi.velocity === defVel) delete trans.midi.velocity;
                if (trans.midi.duration === 100) delete trans.midi.duration;
            }
        }

        // Compact arcs.
        for (const arc of (net.arcs || [])) {
            if (arc.weight && arc.weight.length === 1 && arc.weight[0] === 1) delete arc.weight;
            if (!arc.inhibit) delete arc.inhibit;
        }

        // Strip internal fields.
        delete net['@type'];
        delete net.connections;

        // Capture mix from sliders.
        if (net.track) {
            const row = el._mixerEl?.querySelector(`.pn-mixer-row[data-net-id="${netId}"]`);
            if (row) {
                const vol = row.querySelector('.pn-mixer-vol')?.value;
                const pan = row.querySelector('.pn-mixer-pan')?.value;
                const locut = row.querySelector('.pn-mixer-locut')?.value;
                const lores = row.querySelector('.pn-mixer-loreso')?.value;
                const cut = row.querySelector('.pn-mixer-cutoff')?.value;
                const res = row.querySelector('.pn-mixer-reso')?.value;
                const dec = row.querySelector('.pn-mixer-decay')?.value;
                net.track.mix = {
                    volume: parseInt(vol ?? 100),
                    pan: parseInt(pan ?? 64),
                    loCut: parseInt(locut ?? 0),
                    loResonance: parseInt(lores ?? 5),
                    cutoff: parseInt(cut ?? 100),
                    resonance: parseInt(res ?? 5),
                    decay: parseInt(dec ?? 100),
                };
            }
        }
    }

    // Strip top-level internal fields.
    delete proj['@context']; delete proj['@type']; delete proj.connections;

    const fxVal = (name) => parseInt(el.querySelector(`.pn-fx-slider[data-fx="${name}"]`)?.value ?? 0);
    proj.fx = {
        masterVol: fxVal('master-vol'),
        reverbSize: fxVal('reverb-size'),
        reverbDamp: fxVal('reverb-damp'),
        reverbWet: fxVal('reverb-wet'),
        delayTime: fxVal('delay-time'),
        delayFeedback: fxVal('delay-feedback'),
        delayWet: fxVal('delay-wet'),
        distortion: fxVal('distortion'),
        hpFreq: fxVal('hp-freq'),
        lpFreq: fxVal('lp-freq'),
        phaserFreq: fxVal('phaser-freq'),
        phaserDepth: fxVal('phaser-depth'),
        phaserWet: fxVal('phaser-wet'),
        crushBits: fxVal('crush-bits'),
        masterPitch: fxVal('master-pitch'),
    };
    return proj;
}

export function downloadProject(el) {
    const proj = serializeProject(el);
    const blob = new Blob([JSON.stringify(proj, null, 2)], { type: 'application/ld+json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${proj.name || 'petri-note'}.jsonld`;
    a.click();
    URL.revokeObjectURL(url);
}
