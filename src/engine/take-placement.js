// Placing a natively recorded take in the song (see native-audio.js). Each recorded frame has a
// device-clock time; that maps to performance.now() (by pinging the helper), which maps to the
// AudioContext time being heard at that moment (getOutputTimestamp), which maps to a beat.

import { secAt, beatAt } from '../music/tempo.js';

// clock: {offset} where helper time = performance seconds + offset
// chunk: {first, frameTime, frame} from the helper; device: {rate, buffer, inputLatency}
// output: {contextTime, performanceTime} from AudioContext.getOutputTimestamp()
// Returns the AudioContext time that was being heard when the take's first sample was played.
export function heardContextTime({ first, frameTime, frame }, device, clock, output) {
  // The callback at frameTime delivered input frames [frame, frame + buffer), captured over the
  // buffer before it, after the converter's own input latency.
  const hit = frameTime + (first - frame - device.buffer - (device.inputLatency || 0)) / device.rate;
  const perfMs = (hit - clock.offset) * 1000;
  return output.contextTime + (perfMs - output.performanceTime) / 1000;
}

// Native playback: the song and the input run on the same device clock. What you play reaches input
// frame F after the output and input latencies, so it answers the song at frame F − latency.
//   started: {frame, beat} where the song started rolling (after any count-in)
export function placeNativeTake({ first }, device, started, project, nudgeMs = 0) {
  const latency = (device.inputLatency || 0) + (device.outputLatency || 0);
  const songFrame = first - latency + (nudgeMs / 1000) * device.rate;
  const skip = Math.max(0, Math.round(started.frame - songFrame));
  const startBeat = beatAt(project, secAt(project, started.beat) + Math.max(0, songFrame - started.frame) / device.rate);
  return { skip, startBeat };
}

// Where a take starts in the song, and how many of its frames came before playback started (the
// count-in), given where playback started on the context clock.
export function placeTake(heardTime, startedAt, project, rate, nudgeMs = 0) {
  const t = heardTime + nudgeMs / 1000;
  const skip = Math.max(0, Math.round((startedAt.time - t) * rate));
  const startBeat = beatAt(project, secAt(project, startedAt.beat) + Math.max(0, t - startedAt.time));
  return { skip, startBeat };
}
