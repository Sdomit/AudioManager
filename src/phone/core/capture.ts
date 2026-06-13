/**
 * Microphone capture + level metering + screen wake lock.
 *
 * Framework-free (see protocol.ts): only standard browser media APIs, which a
 * Capacitor WebView provides identically. Echo cancellation / noise suppression
 * / auto gain default OFF — this is a mic input into a mixer, not a phone call.
 */

export interface CaptureOptions {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
}

export const DEFAULT_CAPTURE: CaptureOptions = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

export interface MicCapture {
  readonly track: MediaStreamTrack;
  /** Instantaneous input level in 0..1, from a time-domain analyser. */
  level(): number;
  stop(): void;
}

/**
 * Request the mic and wire a level meter. MUST be called from a user gesture
 * (tap) — mobile browsers reject getUserMedia and AudioContext otherwise.
 */
export async function startMic(opts: CaptureOptions = DEFAULT_CAPTURE): Promise<MicCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: opts.echoCancellation,
      noiseSuppression: opts.noiseSuppression,
      autoGainControl: opts.autoGainControl,
      channelCount: 1,
    },
    video: false,
  });
  const track = stream.getAudioTracks()[0];

  const AudioCtor: typeof AudioContext =
    window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtor();
  void ctx.resume();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const buf = new Uint8Array(analyser.fftSize);

  return {
    track,
    level() {
      analyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) {
        const a = Math.abs(buf[i] - 128) / 128;
        if (a > peak) peak = a;
      }
      return peak;
    },
    stop() {
      for (const t of stream.getTracks()) t.stop();
      void ctx.close();
    },
  };
}

export interface WakeLock {
  release(): void;
}

/**
 * Hold a screen wake lock and re-acquire it when the page becomes visible
 * again. A no-op (but safe) on browsers without the Wake Lock API. This does
 * NOT survive the screen being locked manually — that limit is why the native
 * app wrapper exists (docs/phone/architecture.md).
 */
export async function keepAwake(): Promise<WakeLock> {
  type Sentinel = { release(): Promise<void> };
  type WakeLockApi = { request(kind: "screen"): Promise<Sentinel> };
  const api = (navigator as unknown as { wakeLock?: WakeLockApi }).wakeLock;
  let sentinel: Sentinel | null = null;

  const acquire = async () => {
    if (!api) return;
    try {
      sentinel = await api.request("screen");
    } catch {
      sentinel = null;
    }
  };
  await acquire();

  const onVisible = () => {
    if (document.visibilityState === "visible") void acquire();
  };
  document.addEventListener("visibilitychange", onVisible);

  return {
    release() {
      document.removeEventListener("visibilitychange", onVisible);
      void sentinel?.release().catch(() => {});
      sentinel = null;
    },
  };
}
