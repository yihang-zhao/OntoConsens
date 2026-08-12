import { useEffect, useRef, useState } from "react";
import { useUploadModeratorAudio } from "@workspace/api-client-react";

interface UseModeratorAudioOptions {
  projectId: number;
  /** Mic capture only runs while this is true (moderator on AND user opted in). */
  active: boolean;
  /** Called ~8x/second with a 0..1 volume level while active, for the pulsing border. */
  onVolume: (level: number) => void;
}

const VOLUME_SEND_INTERVAL_MS = 120;
// Two different thresholds (start higher than stop) avoid rapid on/off
// chatter right at the boundary of ambient room noise.
const SPEECH_START_THRESHOLD = 0.06;
const SPEECH_STOP_THRESHOLD = 0.03;
// How long volume must stay below the stop threshold before we consider the
// utterance actually over — short sub-second dips (breaths, plosives) would
// otherwise fragment one sentence into many tiny uploads.
const SPEECH_STOP_DEBOUNCE_MS = 450;
// Caps a single recorded chunk so one long monologue doesn't become one huge
// upload (or keep the server's silence timer from ever getting a chance to
// fire mid-sentence on a very long speaker).
const MAX_CHUNK_DURATION_MS = 15_000;

// Whisper only accepts a fixed set of file extensions and infers the format
// from the filename, not the Content-Type header — so the extension we hand
// it must actually match what MediaRecorder produced.
function extensionForMimeType(mimeType: string): string {
  const base = mimeType.split(";")[0]?.trim().toLowerCase();
  switch (base) {
    case "audio/webm":
      return "webm";
    case "audio/ogg":
      return "ogg";
    case "audio/mp4":
      return "mp4";
    case "audio/mpeg":
      return "mp3";
    case "audio/wav":
    case "audio/wave":
    case "audio/x-wav":
      return "wav";
    default:
      return "webm";
  }
}

// Handles the two audio jobs the AI moderator needs, both driven off one
// mic stream: (1) a continuous volume level for the pulsing border, sent to
// everyone regardless of content, and (2) speech-triggered recording
// uploaded for transcription, which is what actually resets the server's
// 5-second silence timer — raw ambient volume never should.
export function useModeratorAudio({ projectId, active, onVolume }: UseModeratorAudioOptions) {
  const [micError, setMicError] = useState<string | null>(null);
  const uploadAudio = useUploadModeratorAudio();
  const onVolumeRef = useRef(onVolume);
  onVolumeRef.current = onVolume;

  useEffect(() => {
    if (!active) return;

    let stopped = false;
    let stream: MediaStream | null = null;
    let audioCtx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let rafId: number | null = null;
    // `activeRecorder` is the sole marker of "is a recording in progress" —
    // there is deliberately no separate boolean that could disagree with it.
    // Every MediaRecorder instance owns its own `chunks` array via closure,
    // so an in-flight (stopping) recorder's dataavailable/onstop handlers
    // can never see or mutate a different segment's state. Rotating at the
    // duration cap sets `rotatePending` and calls stop() — the *next*
    // segment is only ever started from that recorder's own `onstop`, once
    // its shutdown (and final blob) is fully settled, never synchronously
    // alongside it.
    let activeRecorder: MediaRecorder | null = null;
    let rotatePending = false;
    let belowThresholdSince: number | null = null;
    let recordingStartedAt = 0;
    let lastVolumeSentAt = 0;

    function startRecording() {
      if (!stream || activeRecorder) return;
      const chunks: Blob[] = [];
      let rec: MediaRecorder;
      try {
        rec = new MediaRecorder(stream);
      } catch {
        return;
      }
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      rec.onstop = () => {
        if (chunks.length > 0) {
          const mimeType = rec.mimeType || "audio/webm";
          // The upload client appends this as a bare Blob with no filename
          // argument, so FormData falls back to the literal name "blob"
          // (no extension) unless we hand it a File instead — and Whisper's
          // transcription API rejects files whose name doesn't carry a
          // recognized extension, regardless of the actual Content-Type.
          const file = new File([new Blob(chunks, { type: mimeType })], `chunk.${extensionForMimeType(mimeType)}`, {
            type: mimeType,
          });
          uploadAudio.mutate({ id: projectId, data: { audio: file } });
        }
        if (activeRecorder === rec) activeRecorder = null;
        if (rotatePending && !stopped) {
          rotatePending = false;
          startRecording();
        }
      };
      rec.start();
      activeRecorder = rec;
      recordingStartedAt = Date.now();
      belowThresholdSince = null;
    }

    function stopRecording(rotate = false) {
      if (!activeRecorder) return;
      if (rotate) rotatePending = true;
      try {
        activeRecorder.stop();
      } catch {
        // Already stopped/inactive — its onstop won't fire, so clear the
        // marker (and honor a pending rotation) here instead.
        activeRecorder = null;
        if (rotate) {
          rotatePending = false;
          startRecording();
        }
      }
    }

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
        // the border visibly pulses instead of barely moving.
        onVolumeRef.current(Math.min(1, rms * 4));
      }

      if (rms >= SPEECH_START_THRESHOLD) {
        belowThresholdSince = null;
        if (!activeRecorder) startRecording();
        else if (now - recordingStartedAt >= MAX_CHUNK_DURATION_MS) {
          // Rotate: stop this segment and let its own onstop kick off the
          // next one once the current recorder has fully shut down.
          stopRecording(true);
        }
      } else if (rms < SPEECH_STOP_THRESHOLD && activeRecorder) {
        if (belowThresholdSince === null) {
          belowThresholdSince = now;
        } else if (now - belowThresholdSince >= SPEECH_STOP_DEBOUNCE_MS) {
          stopRecording(false);
        }
      }

      rafId = requestAnimationFrame(tick);
    }

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
      // `stopped` is checked inside onstop, so this will never trigger a
      // rotation after unmount even though a rotate could already be
      // pending from the tick loop.
      if (activeRecorder) stopRecording(false);
      stream?.getTracks().forEach((t) => t.stop());
      audioCtx?.close().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, active]);

  return { micError };
}
