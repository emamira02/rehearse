// Settings decided by the live accuracy checks of 2026-11-12 (see HANDOFF, sections 3c-bis/3c-ter).
//
// Speech: see SPEECH_DEFAULTS in speech.js (lip movement + the SDK's face.talking).
// Head direction (0.50-0.89 agreement) and smiles (reliable, but the extra model lowered the frame rate towards
// the SDK's 25 fps minimum) are not used in rehearsals.
export const FACE_METRICS = Object.freeze({ headUp: false, smile: false });

export const RELIABLE = 0.85;     // share of agreement for a signal to count as reliable for you
export const USE_WITH_CARE = 0.70;
