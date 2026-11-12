// Plain-language notes for a rehearsal report. Rule-based and deterministic (no AI service involved).
// They describe pacing, pauses and breathing in pauses as speaking technique; they never interpret the pulse
// reading or any other signal as a health state.

export function fmtClock(s) {
  if (typeof s !== 'number' || !Number.isFinite(s) || s < 0) return '–';
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}

export function fmtSeconds(s) {
  if (typeof s !== 'number' || !Number.isFinite(s)) return '–';
  return s >= 60 ? fmtClock(s) : `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
}

const pct = (x) => `${Math.round(x * 100)}%`;

export const LIMITS = Object.freeze({
  longRunS: 40,          // a stretch of speech without a pause this long is worth a note
  fewPausesPerMin: 3,
  manyPausesPerMin: 14,
  lowBreathShare: 0.5,
  goodBreathShare: 0.75,
  minPausesForShare: 3,
});

// summary: output of analyzeRehearsal. previous: summary of an earlier rehearsal (optional).
export function rehearsalNotes(summary, previous = null) {
  const notes = [];
  if (!summary || !(summary.durationS > 0)) return notes;
  const s = summary;
  if (s.speakingS < 5) {
    notes.push({ kind: 'info', text: 'Hardly any speech was detected. Face the camera with your mouth visible and speak as you would to an audience.' });
    return notes;
  }

  if (s.longestRunS !== null && s.longestRunS >= LIMITS.longRunS) {
    notes.push({ kind: 'try', text: `Your longest stretch without a pause was ${fmtSeconds(s.longestRunS)} (from ${fmtClock(s.longestRunStartS)}). Try a short pause after each key point there.` });
  } else if (s.longestRunS !== null && s.pauseCount >= 2) {
    notes.push({ kind: 'good', text: `You never spoke for more than ${fmtSeconds(s.longestRunS)} without a pause.` });
  }

  if (s.pausesWithBreathData >= LIMITS.minPausesForShare && s.breathAnchoredPauses !== null) {
    const line = `Experimental: you breathed in during ${s.breathsInPauses} of ${s.pausesWithBreathData} pauses (${pct(s.breathAnchoredPauses)}).`;
    if (s.breathAnchoredPauses < LIMITS.lowBreathShare) {
      notes.push({ kind: 'try', text: `${line} Taking the breath in the pause, not mid-sentence, helps sentences finish strongly.` });
    } else if (s.breathAnchoredPauses >= LIMITS.goodBreathShare) {
      notes.push({ kind: 'good', text: `${line} Your pauses are doing double duty.` });
    } else {
      notes.push({ kind: 'info', text: line });
    }
  }

  if (s.pausesPerMin !== null) {
    if (s.pausesPerMin < LIMITS.fewPausesPerMin) {
      notes.push({ kind: 'try', text: `${s.pausesPerMin.toFixed(1)} pauses per minute. Pausing more often gives listeners time to absorb each point.` });
    } else if (s.pausesPerMin > LIMITS.manyPausesPerMin) {
      notes.push({ kind: 'try', text: `${s.pausesPerMin.toFixed(1)} pauses per minute, many of them short. If some were hesitations, a rehearsal with notes may smooth them out.` });
    }
  }

  if (s.longPauses > 0) {
    notes.push({ kind: 'info', text: `${s.longPauses} pause${s.longPauses > 1 ? 's' : ''} of 4 seconds or more. Deliberate long pauses work well before a key message.` });
  }

  if (previous && previous.durationS > 0) {
    const diffs = [];
    if (s.longestRunS !== null && previous.longestRunS !== null) {
      diffs.push(`longest stretch ${fmtSeconds(previous.longestRunS)} → ${fmtSeconds(s.longestRunS)}`);
    }
    if (s.breathAnchoredPauses !== null && previous.breathAnchoredPauses !== null) {
      diffs.push(`breaths in pauses ${pct(previous.breathAnchoredPauses)} → ${pct(s.breathAnchoredPauses)}`);
    }
    if (s.pausesPerMin !== null && previous.pausesPerMin !== null) {
      diffs.push(`pauses per minute ${previous.pausesPerMin.toFixed(1)} → ${s.pausesPerMin.toFixed(1)}`);
    }
    if (diffs.length) notes.push({ kind: 'info', text: `Since your previous run of this talk: ${diffs.join('; ')}.` });
  }

  if (s.pulse && Number.isFinite(s.pulse.opening)) {
    const p = s.pulse;
    const text = Number.isFinite(p.closing)
      ? `Pulse reading: about ${Math.round(p.opening)} bpm in the first 30 s and ${Math.round(p.closing)} bpm in the last 30 s.`
      : `Pulse reading: about ${Math.round(p.opening)} bpm (too short a run to compare start and end).`;
    notes.push({ kind: 'info', text: `${text} Shown as information only; it is not a health measurement.` });
  }
  return notes;
}
