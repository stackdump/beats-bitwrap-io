// Cursor-anchored slider value tooltip. One document-level element,
// shared by every slider cluster (mixer rows, FX panel, anywhere else
// we want to surface a live value on hover). No inline value spans —
// the tip floats next to the pointer so row layout is never shifted
// by hover state.

let sliderTip = null;
let tipSlider = null;

function ensureSliderTip() {
    if (sliderTip) return sliderTip;
    sliderTip = document.createElement('div');
    sliderTip.className = 'pn-slider-tip';
    sliderTip.setAttribute('aria-hidden', 'true');
    document.body.appendChild(sliderTip);
    return sliderTip;
}

export function showSliderTip(slider, text, clientX, clientY) {
    const tip = ensureSliderTip();
    tipSlider = slider;
    tip.textContent = text;
    const pad = 12;
    tip.style.left = `${clientX + pad}px`;
    tip.style.top  = `${clientY - pad}px`;
    tip.style.opacity = '1';
}

export function hideSliderTip() {
    if (sliderTip) sliderTip.style.opacity = '0';
    tipSlider = null;
}

// Called when a slider's value changes via drag / wheel / keyboard.
// Updates the tip's text only if this slider is the one currently
// under the cursor — otherwise a macro or remote event would blink
// the tip on sliders the user isn't looking at.
export function syncSliderTip(slider, text) {
    if (!sliderTip || tipSlider !== slider) return;
    sliderTip.textContent = text;
}
