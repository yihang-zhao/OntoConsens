import { useEffect, useRef, useState } from "react";

interface UseModeratorAudioOptions {
  projectId: number;
  /** Mic capture only runs while this is true (moderator on AND user opted in). */
  active: boolean;
  /** BCP-47 language tag passed straight to the recognizer (e.g. "en-US",
   *  "zh-CN") -- lets each member recognize their own spoken language
   *  independently of everyone else's. */
  lang: string;
  /** Called ~8x/second with a 0..1 volume level while active, for the
   *  per-member "speaking" fallback indicator (used when the browser has no
   *  speech recognizer, so there's at least a visible sign someone's talking). */
  onVolume: (level: number) => void;
  /** Called with the current in-progress utterance's text as the browser's
   *  speech recognizer refines it, live -- this IS the transcript now (there
   *  is no separate server-side transcription step). Called with an empty
   *  string when there's no utterance in progress. Only fires in browsers
   *  that support the Web Speech API (Chrome/Edge); Firefox/Safari have no
   *  implementation, so live transcription is simply unavailable there.
   *  The second argument identifies WHICH utterance this text belongs to
   *  (see onFinalize) -- the caller needs it to tell apart "this is still
   *  growing text for the utterance that's currently being persisted" from
   *  "this is a brand-new utterance that started while the previous one's
   *  storage round trip is still in flight". */
  onCaption?: (text: string, utteranceId: number) => void;
  /** Called once per utterance, with its full recognized text, the moment
   *  1 second passes with no further speech (or the mic is turned off mid-
   *  utterance) -- this is the point where the text should be persisted as
   *  a real, permanent chat message. While the user keeps talking with less
   *  than 1s of silence between words, onCaption keeps growing the SAME
   *  in-progress utterance instead of this firing.
   *  Persisting this text (a network round trip) and capturing whatever the
   *  user says next are two fully independent processes: this call returns
   *  immediately (it never awaits the caller's own persistence), and the
   *  recognizer keeps running uninterrupted so the very next onCaption can
   *  fire before this utterance has finished being stored. utteranceId is a
   *  simple per-session counter, incremented the instant this utterance is
   *  handed off -- everything onCaption reports afterward belongs to
   *  utteranceId + 1, letting the caller distinguish a late-arriving
   *  "stored" confirmation for THIS utterance from a next utterance that's
   *  already begun. */
  onFinalize?: (text: string, utteranceId: number) => void;
}

// Chrome/Edge ship this as the prefixed webkitSpeechRecognition; Firefox and
// Safari currently have no implementation at all, so this is always
// feature-detected and captions are simply skipped where unsupported.
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;
interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: any) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: any) => void) | null;
}
function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as any;
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

const VOLUME_SEND_INTERVAL_MS = 120;

// How long an utterance can go without any new recognized word before it's
// considered over and gets finalized into its own permanent message.
const SILENCE_FINALIZE_MS = 1_000;
const SILENCE_CHECK_INTERVAL_MS = 300;
// Browsers periodically end a "continuous" recognition session on their own
// even while the user keeps talking -- this restarts it quickly so that
// technical hiccup is invisible and never itself counts as the silence that
// closes out a message (only wall-clock time since the last recognized word
// does that; see lastSpeechAt below).
const RECOGNITION_RESTART_DELAY_MS = 250;

// Deliberate design invariant: this hook must NEVER call recognition.stop()
// or recognition.abort() on its own initiative while `active` is true, for
// ANY reason -- not to finalize an utterance, not in reaction to how long
// storage/persistence of a previous message is taking, not as a "recovery"
// heuristic. Message storage and utterance-boundary (pause-threshold)
// decisions are handled entirely by the caller, downstream of the raw
// recognized text this hook hands it via onCaption/onFinalize -- they must
// never reach back in and interrupt capture. Every interruption test tried
// here (an artificial restart delay, restarting the recognizer at finalize
// time, a "stuck recognizer" watchdog that force-aborts after a timeout)
// reliably swallowed the first word or two of whatever was said right after,
// because ANY stop/start cycle drops real mic capture for a moment no matter
// how it's triggered or how short the timeout is tuned to be -- and that
// moment lands squarely on the start of the next utterance, which is
// exactly the words that must never be lost. So the ONLY thing that ever
// restarts the recognizer while active is its own onend firing (the browser
// unilaterally ending the session on its own -- entirely outside this
// hook's control, so reacting to it isn't "pausing" it, it's recovering
// from the browser already having stopped it) -- and that restart happens
// with zero added delay. If Chrome's known bug where a session goes
// silently unresponsive (no onresult, no onerror, no onend at all) is ever
// hit, this hook will not detect or recover from it on its own; the member
// would need to toggle their mic off and on. That tradeoff is intentional:
// a rare, manually-recoverable full stall is preferable to routinely losing
// the first words of every single new message, which is guaranteed the
// moment any watchdog/heuristic is allowed to touch the recognizer's
// lifecycle.

// Handles the two audio jobs the AI moderator needs, both driven off the
// mic: (1) a continuous volume level, sent to everyone as a fallback
// "someone is speaking" signal, and (2) live speech-to-text via the
// browser's own recognizer, which is now the transcript itself.
export function useModeratorAudio({ projectId, active, lang, onVolume, onCaption, onFinalize }: UseModeratorAudioOptions) {
  const [micError, setMicError] = useState<string | null>(null);
  const [speechSupported, setSpeechSupported] = useState(true);
  const onVolumeRef = useRef(onVolume);
  onVolumeRef.current = onVolume;
  const onCaptionRef = useRef(onCaption);
  onCaptionRef.current = onCaption;
  const onFinalizeRef = useRef(onFinalize);
  onFinalizeRef.current = onFinalize;

  // Lets a caller (e.g. "turn the mic off" button) synchronously pull out
  // whatever's been recognized so far -- mid-utterance and all -- instead of
  // relying on the effect-teardown flush below. That flush only runs once
  // `active` actually flips to false, which can happen well after this
  // member has already been marked inactive server-side (see the race this
  // is guarding against in ModeratorChatPanel's handleToggleClick), so its
  // transcript submission can arrive too late to be accepted. Calling this
  // first lets the caller submit the text and wait for that to be accepted
  // BEFORE deactivating, closing that race.
  const flushRef = useRef<() => { text: string; utteranceId: number }>(() => ({ text: "", utteranceId: 0 }));

  // Live speech-to-text runs as its own consumer of the microphone via the
  // browser's speech recognizer -- it manages its own mic access separately
  // from the volume-metering effect below, so the two don't interfere.
  useEffect(() => {
    if (!active) {
      flushRef.current = () => ({ text: "", utteranceId: 0 });
      return;
    }
    const maybeCtor = getSpeechRecognitionCtor();
    if (!maybeCtor) {
      setSpeechSupported(false);
      return; // unsupported browser -- no live transcript is possible here
    }
    setSpeechSupported(true);
    const Ctor = maybeCtor;

    let stopped = false;
    let recognition: SpeechRecognitionLike | null = null;
    let restartTimer: ReturnType<typeof setTimeout> | null = null;
    let silenceTimer: ReturnType<typeof setInterval> | null = null;

    // Utterance state is bridged across recognizer restarts (see
    // RECOGNITION_RESTART_DELAY_MS above) -- only wall-clock silence since
    // the last recognized word can end an utterance, never the recognizer's
    // own start/stop lifecycle. `priorSessionsText` holds everything already
    // recognized in earlier recognizer sessions of this SAME utterance;
    // within the current session, the full text-so-far is recomputed from
    // scratch on every onresult (see below) instead of being built up
    // incrementally, which is what caused words to vanish -- some
    // recognizers (notably for Chinese and other non-English languages)
    // deliver interim results as short growing/shrinking fragments rather
    // than one steadily-growing phrase, and incrementally appending each
    // fragment onto the previous one duplicated or dropped words. Reading
    // the browser's own results array fresh each time is the only
    // representation that's always correct, regardless of language.
    let priorSessionsText = "";
    let lastSpeechAt = 0;
    let lastResults: any = null;
    // Identifies the utterance currently being accumulated by onCaption.
    // Bumped the instant an utterance is handed off to onFinalize, so
    // anything reported afterward (even a millisecond later) is correctly
    // tagged as belonging to the NEXT utterance -- this is what lets the
    // caller tell a delayed "your previous message finished storing"
    // confirmation apart from "the user already started talking again".
    let utteranceId = 0;
    // Index into the CURRENT recognition session's `results` array from
    // which words belong to the utterance-in-progress. Advanced (not the
    // recognizer restarted) every time an utterance is finalized on silence
    // -- see the silence timer below for why: restarting the recognizer
    // stops and restarts mic capture, which swallows the first word or two
    // of whatever's said right after. The browser's results array only ever
    // grows within one session, so everything before this offset is simply
    // ignored by textFromResults from then on; it's reset to 0 only when a
    // brand-new recognition session actually starts (see start()).
    let resultsOffset = 0;

    function textFromResults(results: any, offset = 0): string {
      const parts: string[] = [];
      for (let i = offset; i < results.length; i++) {
        const text = results[i]?.[0]?.transcript?.trim();
        if (text) parts.push(text);
      }
      return parts.join(" ").trim();
    }

    function currentText(sessionText: string) {
      return [priorSessionsText, sessionText].filter(Boolean).join(" ").trim();
    }

    function finalizeIfAny(sessionText = "") {
      const text = currentText(sessionText);
      priorSessionsText = "";
      // Hand this utterance's id to the finalize callback, then immediately
      // move on to the next one -- from this point on, any further
      // recognized speech (the user resuming right away) is a NEW utterance
      // and must never be confused with the one just handed off, no matter
      // how long its own persistence round trip takes.
      const finalizedId = utteranceId;
      utteranceId += 1;
      // Deliberately NOT calling onCaption("") here. That would broadcast an
      // empty caption immediately, racing the onFinalize round trip below
      // (which persists the same text as a real message) over two entirely
      // separate network paths -- whichever lands first either blanks the
      // box before the real message shows up, or leaves both visible at
      // once. The box should keep showing this same finalized text right up
      // until the permanent message actually replaces it; that swap is the
      // sole responsibility of the caller's "message arrived" handling.
      // Note this call is fire-and-forget from here on: nothing below in
      // this closure waits on whatever the caller does with it (e.g. a
      // network request to persist it), so the recognizer keeps running and
      // the very next onresult can fire before this one's storage settles.
      if (text) onFinalizeRef.current?.(text, finalizedId);
    }

    // Exposed to the caller via the hook's returned `flush()`. Pulls
    // whatever's been recognized so far out of this closure's own state
    // (bypassing the silence timer entirely) and hands it back directly
    // instead of going through onFinalize, so the caller can await its own
    // submission before doing anything else (like deactivating this
    // member). Also stops the recognizer immediately so it can't keep
    // growing the buffer this already pulled text out of, and clears local
    // state so the effect-teardown flush below finds nothing left to
    // (redundantly) finalize once `active` actually flips to false.
    flushRef.current = () => {
      const text = currentText(lastResults ? textFromResults(lastResults, resultsOffset) : "");
      const flushedId = utteranceId;
      priorSessionsText = "";
      lastResults = null;
      lastSpeechAt = 0;
      if (recognition) {
        try {
          recognition.abort();
        } catch {
          // already stopped
        }
      }
      return { text, utteranceId: flushedId };
    };

    function start() {
      if (stopped) return;
      // A brand-new recognition session means a brand-new, empty `results`
      // array from the browser's side -- the offset only ever makes sense
      // relative to the session it was measured against.
      resultsOffset = 0;
      const rec = new Ctor();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = lang;
      rec.onresult = (event: any) => {
        lastResults = event.results;
        const sessionText = textFromResults(event.results, resultsOffset);
        lastSpeechAt = Date.now();
        onCaptionRef.current?.(currentText(sessionText), utteranceId);
      };
      rec.onerror = () => {
        // "no-speech"/"aborted" etc. — just let onend's restart handle it.
      };
      rec.onend = () => {
        if (stopped) return;
        // The session that just ended may have recognized more words that
        // never got folded into priorSessionsText -- carry them forward so
        // the restart below is invisible rather than dropping the tail end
        // of what was just said.
        if (lastResults) priorSessionsText = currentText(textFromResults(lastResults, resultsOffset));
        lastResults = null;
        // Restart IMMEDIATELY, not after an artificial delay. The browser
        // stops delivering audio to this session the instant onend fires --
        // that mic-capture gap is real and unavoidable (re-acquiring the
        // recognizer takes the browser some inherent setup time on its own),
        // but any extra delay WE add on top of that is pure lost listening
        // time, and it's exactly what was swallowing the first word or two
        // of whatever the user said right as they resumed talking. start()
        // already falls back to a delayed retry via its own catch block if
        // calling it this soon genuinely throws (the underlying session
        // hasn't fully released yet), so trying immediately first can only
        // help, never hurt.
        start();
      };
      try {
        rec.start();
      } catch {
        if (!stopped) restartTimer = setTimeout(start, RECOGNITION_RESTART_DELAY_MS);
        return;
      }
      recognition = rec;
    }

    start();

    silenceTimer = setInterval(() => {
      const now = Date.now();

      if (lastSpeechAt && now - lastSpeechAt >= SILENCE_FINALIZE_MS) {
        lastSpeechAt = 0;
        finalizeIfAny(lastResults ? textFromResults(lastResults, resultsOffset) : "");
        // The browser's own results array for this recognition session keeps
        // growing for as long as the session runs -- it never forgets what
        // was already recognized. Left alone, the NEXT onresult would rebuild
        // its text from that same array and drag the just-finalized words
        // back into the new message box. This used to be solved by
        // restarting the recognizer here, but stopping and restarting the
        // browser's recognizer briefly drops mic capture -- swallowing the
        // first word or two of whatever's said right after the pause.
        // Instead, just move the offset forward: the recognizer keeps
        // running uninterrupted, and everything before this point in its
        // results array is simply ignored from now on.
        resultsOffset = lastResults ? lastResults.length : resultsOffset;
        lastResults = null;
      }
      // Deliberately nothing else runs in this interval. See the design
      // invariant documented above SPEECH_ENERGY_RMS_THRESHOLD: no
      // heuristic here is allowed to stop/restart the recognizer itself --
      // only the finalize bookkeeping above (which never touches the
      // recognizer) and the browser's own onend (handled in start()) do.
    }, SILENCE_CHECK_INTERVAL_MS);

    return () => {
      stopped = true;
      if (restartTimer) clearTimeout(restartTimer);
      if (silenceTimer) clearInterval(silenceTimer);
      // Flush whatever's in progress immediately -- e.g. the mic was turned
      // off mid-sentence, which shouldn't silently drop that utterance.
      finalizeIfAny(lastResults ? textFromResults(lastResults, resultsOffset) : "");
      if (recognition) {
        recognition.onend = null;
        recognition.onerror = null;
        recognition.onresult = null;
        try {
          recognition.abort();
        } catch {
          // already stopped
        }
      }
    };
    // Restart the recognizer on a language change too, not just on/off --
    // otherwise switching languages mid-session keeps recognizing in the
    // old one until the mic is toggled off and back on.
  }, [active, lang]);

  useEffect(() => {
    if (!active) return;

    let stopped = false;
    let stream: MediaStream | null = null;
    let audioCtx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let rafId: number | null = null;
    let lastVolumeSentAt = 0;

    function tick() {
      if (stopped || !analyser) return;
      const data = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteTimeDomainData(data);
      let sumSquares = 0;
      for (let i = 0; i < data.length; i++) {
        const normalized = (data[i]! - 128) / 128;
        sumSquares += normalized * normalized;
      }
      const rms = Math.sqrt(sumSquares / data.length);

      const now = Date.now();
      if (now - lastVolumeSentAt >= VOLUME_SEND_INTERVAL_MS) {
        lastVolumeSentAt = now;
        // Normal speech RMS is a small fraction of full scale — scale up so
        // the fallback indicator visibly pulses instead of barely moving.
        onVolumeRef.current(Math.min(1, rms * 4));
      }

      rafId = requestAnimationFrame(tick);
    }

    (async () => {
      try {
        // Explicit (not just relying on browser defaults) so the mic capture
        // reliably cancels echo from whatever's playing on this machine's
        // speakers -- e.g. a separate voice call (Zoom/Meet/Discord) running
        // alongside this app -- rather than transcribing it back as if the
        // local member had said it themselves.
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        });
      } catch {
        if (!stopped) setMicError("Microphone access was denied or unavailable.");
        return;
      }
      if (stopped) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      setMicError(null);
      audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      rafId = requestAnimationFrame(tick);
    })();

    return () => {
      stopped = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      stream?.getTracks().forEach((t) => t.stop());
      audioCtx?.close().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, active]);

  // Imperative escape hatch for "flush whatever's mid-utterance right now" --
  // see flushRef's own comment above for why this exists alongside the
  // automatic effect-teardown flush.
  const flush = () => flushRef.current();

  return { micError, speechSupported, flush };
}
