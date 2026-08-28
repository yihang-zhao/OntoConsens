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

// The browser's recognizer can fire onresult many times a second while
// someone is actively talking (interim results refine on almost every
// syllable) -- with no throttle at all, EVERY one of those immediately
// went out over the websocket, got broadcast to every connected client,
// and forced a full re-render of everyone's chat panel. That's cheap with
// one speaker; with several people talking at once (exactly the
// multi-speaker scenario this exists to support), it multiplies into a
// steady flood of renders and messages on every single participant's tab,
// competing for the same main thread the local recognizer's own event
// handling runs on -- the more it's starved, the more likely a stuck
// recognizer or a dropped/delayed result looks like "recognition missed
// what was said". Coalescing to a fixed cadence (leading edge fires
// immediately so the very first word of a new utterance is never delayed,
// trailing edge guarantees the latest text is never left stuck mid-word)
// cuts that traffic by an order of magnitude without making captions feel
// less live than the volume meter above, which already samples at a
// similar rate.
const CAPTION_SEND_INTERVAL_MS = 150;

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

// Chrome (the only real-world implementation of this API) has a
// long-standing bug where, after a pause of varying length, the recognizer
// can silently stop delivering ANY results -- no onresult, no onerror, no
// onend -- while otherwise looking like it's still running. Because nothing
// fires, the existing onend-triggered restart above never kicks in, and the
// user's next speech is simply never recognized until the mic is toggled
// off and back on. This watchdog is the fix: it cross-checks the
// recognizer's own activity against ACTUAL mic audio energy (measured
// independently by the volume-metering effect below, via lastLoudAtRef) --
// if there has clearly been audible sound very recently but the recognizer
// hasn't produced a single result in far longer than that ever takes when
// it's working, it's stuck, so it's force-aborted (which reliably fires
// onend and hands off to the normal carry-forward restart path) rather than
// waited on indefinitely. Genuine silence never trips this -- with no
// audio energy, "no results" is just correctly recognizing nothing was
// said.
const RECOGNIZER_STUCK_AUDIO_GRACE_MS = 900;
const RECOGNIZER_STUCK_NO_RESULT_MS = 1_800;
// The moment most likely to trigger the above bug is exactly the pause that
// our OWN silence timer just used to finalize an utterance into its own
// message box -- that pause is precisely the "pause of varying length"
// Chrome's bug is keyed on, so the recognizer going silently stuck right as
// the user resumes talking for a brand-new utterance is common, not rare.
// Waiting out the general-purpose thresholds above before recovering means
// losing up to ~2.7s of the new utterance's opening words every time this
// hits -- exactly the "first few words of the new message aren't
// recognized" complaint. Rather than widen the general thresholds (which
// would make the watchdog fire too eagerly on normal recognizer latency
// during genuine mid-utterance pauses, where a false trigger costs a real
// restart gap for no reason), a separate, tighter pair applies ONLY in the
// narrow window between "an utterance was just finalized" and "the new
// utterance's first result has arrived" -- see awaitingFirstResultOfNewUtterance
// below.
const RECOGNIZER_STUCK_AUDIO_GRACE_MS_AFTER_FINALIZE = 400;
const RECOGNIZER_STUCK_NO_RESULT_MS_AFTER_FINALIZE = 700;
const MIN_SESSION_AGE_BEFORE_FORCED_RESTART_MS = 1_000;
// Raw (unscaled) RMS floor above which incoming audio counts as "someone is
// plausibly making speech-level sound right now" for the watchdog above --
// deliberately above typical room-noise/hiss RMS so it doesn't fire on
// ambient noise alone, but well below what normal speech volume reaches.
const SPEECH_ENERGY_RMS_THRESHOLD = 0.03;

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

  // Timestamp of the last audio sample loud enough to plausibly be speech,
  // set by the volume-metering effect below and read by the speech
  // recognizer's stuck-watchdog above -- shared via a ref (not effect
  // dependencies) since the two effects run and re-run independently of
  // each other, and this only ever needs to be read as of "right now", not
  // reacted to.
  const lastLoudAtRef = useRef(0);

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
    // When the CURRENT recognition session actually started -- used by the
    // stuck-recognizer watchdog below to (a) give a freshly (re)started
    // session a moment before judging it unresponsive, and (b) naturally
    // rate-limit repeated forced restarts, since it's reset every time
    // start() runs.
    let sessionStartedAt = 0;
    // Set the moment the watchdog force-aborts a session it believes is
    // stuck, and cleared once that abort's own onend/fallback handoff has
    // actually started a fresh session -- this keeps the watchdog from
    // calling abort() again on every tick while it waits for that abort to
    // actually take effect and hand off to onend.
    let forcedRestartPending = false;
    // True from the instant an utterance is finalized on silence until the
    // new utterance's first onresult actually arrives -- narrows down
    // exactly the window where the tighter *_AFTER_FINALIZE watchdog
    // thresholds above apply (see their comment for why this window in
    // particular needs faster stuck-recognizer recovery than the general
    // case).
    let awaitingFirstResultOfNewUtterance = false;
    // Index into the CURRENT recognition session's `results` array from
    // which words belong to the utterance-in-progress. Advanced (not the
    // recognizer restarted) every time an utterance is finalized on silence
    // -- see the silence timer below for why: restarting the recognizer
    // stops and restarts mic capture, which swallows the first word or two
    // of whatever's said right after. The browser's results array only ever
    // grows within one session, so everything before this offset is simply
    // ignored by textFromResults from then on; it's reset to 0 only when a
    // brand-new recognition session actually starts (see start()).
    //
    // This offset can only safely skip a results[] entry the browser has
    // itself marked `isFinal` -- that entry is locked in and will never
    // change again. Our own SILENCE_FINALIZE_MS pause detector runs on a
    // fixed wall-clock timer that is completely independent of (and, in
    // practice, usually a bit faster than) the browser's OWN internal
    // endpointing, which decides isFinal on its own schedule. That means at
    // the moment WE decide to finalize, the last results[] entry is very
    // often STILL interim -- the browser hasn't yet decided that phrase is
    // over, and will keep growing that SAME entry (not start a new one) with
    // whatever the user says as they resume talking. Naively setting
    // resultsOffset past that still-mutable entry (e.g. to `results.length`
    // as of the finalize instant) makes every word the browser goes on to
    // append to it invisible to textFromResults from then on -- this is
    // what was silently swallowing the first few words of every new
    // utterance, deterministically, since our timer being faster than the
    // browser's own is the common case, not a rare race.
    //
    // The fix: never skip past a still-interim entry. If the boundary entry
    // is interim at finalize time, remember its current text as
    // `resultsOffsetPrefix` and keep reading from that same index -- but
    // strip that remembered prefix back off its (possibly still-growing)
    // text first, so only whatever the browser appends AFTER this point
    // counts as the new utterance. Once the browser marks that entry final
    // or starts a genuinely new one, the prefix naturally stops applying.
    let resultsOffset = 0;
    let resultsOffsetPrefix = "";

    // Coalesces onCaption dispatches to CAPTION_SEND_INTERVAL_MS (see its
    // comment above) instead of firing on every single onresult. Leading
    // edge: if enough time has passed since the last dispatch, send right
    // away -- the first word of a fresh utterance is never held back.
    // Trailing edge: otherwise remember the latest text and schedule exactly
    // one more send for whenever the interval is up, so the box never gets
    // stuck showing stale text while the browser keeps refining the same
    // phrase faster than the interval allows.
    let lastCaptionSentAt = 0;
    let pendingCaptionTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingCaptionText: string | null = null;
    let pendingCaptionUtteranceId = 0;
    function sendCaptionThrottled(text: string, id: number) {
      const now = Date.now();
      const elapsed = now - lastCaptionSentAt;
      if (elapsed >= CAPTION_SEND_INTERVAL_MS) {
        lastCaptionSentAt = now;
        pendingCaptionText = null;
        if (pendingCaptionTimer) {
          clearTimeout(pendingCaptionTimer);
          pendingCaptionTimer = null;
        }
        onCaptionRef.current?.(text, id);
        return;
      }
      pendingCaptionText = text;
      pendingCaptionUtteranceId = id;
      if (!pendingCaptionTimer) {
        pendingCaptionTimer = setTimeout(() => {
          pendingCaptionTimer = null;
          lastCaptionSentAt = Date.now();
          if (pendingCaptionText !== null) {
            onCaptionRef.current?.(pendingCaptionText, pendingCaptionUtteranceId);
            pendingCaptionText = null;
          }
        }, CAPTION_SEND_INTERVAL_MS - elapsed);
      }
    }

    function textFromResults(results: any, offset = 0, stripPrefixAtOffset = ""): string {
      const parts: string[] = [];
      for (let i = offset; i < results.length; i++) {
        let text = results[i]?.[0]?.transcript?.trim() ?? "";
        if (i === offset && stripPrefixAtOffset) {
          // The common case: the browser is still growing the same entry
          // that was already partly accounted for by the utterance just
          // finalized -- only the growth beyond that snapshot is new.
          // If the browser instead revised/replaced that entry's text
          // outright (observed for some languages, see priorSessionsText's
          // comment above) rather than simply appending to it, the prefix
          // no longer matches -- fall back to the full text rather than
          // silently dropping it again; an occasional duplicated word here
          // is far preferable to the guaranteed word loss this replaces.
          text = text.startsWith(stripPrefixAtOffset) ? text.slice(stripPrefixAtOffset.length).trim() : text;
        }
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
      // The new utterance officially starts here -- arm the tighter
      // stuck-recognizer thresholds until its first word actually comes
      // back through onresult.
      awaitingFirstResultOfNewUtterance = true;
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
      const text = currentText(lastResults ? textFromResults(lastResults, resultsOffset, resultsOffsetPrefix) : "");
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
      // array from the browser's side -- the offset (and any pending
      // boundary prefix, which only makes sense relative to an entry in the
      // OLD session's array) only ever makes sense relative to the session
      // it was measured against.
      resultsOffset = 0;
      resultsOffsetPrefix = "";
      sessionStartedAt = Date.now();
      forcedRestartPending = false;
      const rec = new Ctor();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = lang;
      rec.onresult = (event: any) => {
        lastResults = event.results;
        const sessionText = textFromResults(event.results, resultsOffset, resultsOffsetPrefix);
        lastSpeechAt = Date.now();
        // The new utterance has now produced real output -- the tighter
        // post-finalize watchdog window (see its constants above) is over;
        // fall back to the general-purpose thresholds for the rest of it.
        awaitingFirstResultOfNewUtterance = false;
        sendCaptionThrottled(currentText(sessionText), utteranceId);
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
        if (lastResults) priorSessionsText = currentText(textFromResults(lastResults, resultsOffset, resultsOffsetPrefix));
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
        finalizeIfAny(lastResults ? textFromResults(lastResults, resultsOffset, resultsOffsetPrefix) : "");
        // The browser's own results array for this recognition session keeps
        // growing for as long as the session runs -- it never forgets what
        // was already recognized. Left alone, the NEXT onresult would rebuild
        // its text from that same array and drag the just-finalized words
        // back into the new message box. This used to be solved by
        // restarting the recognizer here, but stopping and restarting the
        // browser's recognizer briefly drops mic capture -- swallowing the
        // first word or two of whatever's said right after the pause.
        // Instead, just move the offset forward -- but ONLY past entries the
        // browser has itself already marked final. Our wall-clock silence
        // timer routinely fires before the browser's own (independent, and
        // usually slower) endpointing has decided the trailing phrase is
        // over, so that last entry is very often still interim and will
        // keep growing with whatever the user says next -- skipping past it
        // outright (the old behavior) made that growth invisible, which is
        // what was silently dropping the first few words of every new
        // utterance. If it's still interim, stay at that same index and
        // remember its current text so it can be subtracted back out (see
        // textFromResults) -- only growth beyond this snapshot counts as the
        // new utterance.
        if (lastResults) {
          const results = lastResults;
          let newOffset = resultsOffset;
          while (newOffset < results.length && results[newOffset]?.isFinal) {
            newOffset++;
          }
          resultsOffsetPrefix = newOffset < results.length ? (results[newOffset]?.[0]?.transcript?.trim() ?? "") : "";
          resultsOffset = newOffset;
        } else {
          resultsOffsetPrefix = "";
        }
        lastResults = null;
      }

      // Stuck-recognizer watchdog (see RECOGNIZER_STUCK_* docs above): fires
      // independently of the finalize check above, since a stuck recognizer
      // can just as easily be discovered right after a finalize (lastSpeechAt
      // reset to 0) as mid-utterance. "Last known activity" falls back to
      // when this session started if it hasn't produced a single result yet.
      if (!forcedRestartPending && recognition) {
        const lastActivityAt = lastSpeechAt || sessionStartedAt;
        // Right after a finalize, use the tighter pair (see their comment)
        // since that's exactly the moment Chrome's silent-stuck bug tends to
        // hit -- once the new utterance has produced any real output, fall
        // back to the general-purpose thresholds for the remainder of it.
        const audioGraceMs = awaitingFirstResultOfNewUtterance
          ? RECOGNIZER_STUCK_AUDIO_GRACE_MS_AFTER_FINALIZE
          : RECOGNIZER_STUCK_AUDIO_GRACE_MS;
        const noResultMs = awaitingFirstResultOfNewUtterance
          ? RECOGNIZER_STUCK_NO_RESULT_MS_AFTER_FINALIZE
          : RECOGNIZER_STUCK_NO_RESULT_MS;
        const audioActiveRecently = now - lastLoudAtRef.current < audioGraceMs;
        const sessionOldEnough = now - sessionStartedAt >= MIN_SESSION_AGE_BEFORE_FORCED_RESTART_MS;
        const recognizerUnresponsive = now - lastActivityAt >= noResultMs;
        if (audioActiveRecently && sessionOldEnough && recognizerUnresponsive) {
          forcedRestartPending = true;
          const staleRecognition = recognition;
          try {
            staleRecognition.abort();
          } catch {
            // Already stopped -- the fallback timer below covers this too.
          }
          // Belt-and-suspenders: the whole reason this watchdog exists is
          // that this exact recognizer can go quiet without firing ANY
          // event, including possibly onend after an abort() call. If
          // onend hasn't fired shortly after we asked it to stop, don't
          // keep waiting on it -- tear the dead object down and start a
          // fresh session directly.
          setTimeout(() => {
            if (!forcedRestartPending || stopped) return;
            forcedRestartPending = false;
            staleRecognition.onend = null;
            staleRecognition.onerror = null;
            staleRecognition.onresult = null;
            if (lastResults) priorSessionsText = currentText(textFromResults(lastResults, resultsOffset, resultsOffsetPrefix));
            lastResults = null;
            recognition = null;
            start();
          }, RECOGNITION_RESTART_DELAY_MS + 800);
        }
      }
    }, SILENCE_CHECK_INTERVAL_MS);

    return () => {
      stopped = true;
      if (restartTimer) clearTimeout(restartTimer);
      if (silenceTimer) clearInterval(silenceTimer);
      if (pendingCaptionTimer) clearTimeout(pendingCaptionTimer);
      // Flush whatever's in progress immediately -- e.g. the mic was turned
      // off mid-sentence, which shouldn't silently drop that utterance.
      finalizeIfAny(lastResults ? textFromResults(lastResults, resultsOffset, resultsOffsetPrefix) : "");
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
      // Ground truth for the speech-recognition effect's stuck-recognizer
      // watchdog above: independent of whatever the recognizer itself is
      // doing, this is measured straight off the mic, so it still reflects
      // reality even in exactly the failure mode being guarded against.
      if (rms > SPEECH_ENERGY_RMS_THRESHOLD) lastLoudAtRef.current = now;
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
