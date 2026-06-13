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
  /** Specific input device; omitted = the browser's default mic. */
  deviceId?: string;
}

export const DEFAULT_CAPTURE: CaptureOptions = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

export interface MicDevice {
  deviceId: string;
  label: string;
}

/**
 * List available microphones. Labels are only populated once mic permission has
 * been granted (browsers hide them before), so call this after `startMic`.
 */
export async function listMics(): Promise<MicDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === "audioinput" && d.deviceId)
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
}

export interface MicCapture {
  readonly track: MediaStreamTrack;
  /** Device id actually in use (from the track settings), or "" if unknown. */
  readonly deviceId: string;
  /** Instantaneous input level in 0..1, from a time-domain analyser. */
  level(): number;
  stop(): void;
}

/**
 * Request the mic and wire a level meter. MUST be called from a user gesture
 * (tap) — mobile browsers reject getUserMedia and AudioContext otherwise.
 */
export async function startMic(opts: CaptureOptions = DEFAULT_CAPTURE): Promise<MicCapture> {
  // Without a secure context (or on a browser too old for getUserMedia) the
  // media API is absent — fail with a clear message instead of a raw TypeError.
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new DOMException(
      "This browser can't capture audio here. Open the HTTPS link in a current Chrome or Safari.",
      "NotSupportedError",
    );
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: opts.echoCancellation,
      noiseSuppression: opts.noiseSuppression,
      autoGainControl: opts.autoGainControl,
      // Prefer stereo where the device offers it (two-channel capture); mono
      // phones simply return one channel. `ideal` so the request never fails.
      channelCount: { ideal: 2 },
      ...(opts.deviceId ? { deviceId: { exact: opts.deviceId } } : {}),
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
  const buf = new Float32Array(analyser.fftSize);
  // Peak meter: instant attack, exponential release per ~100ms read. Matches the
  // desktop meter's ballistics (net::session PEAK_RELEASE) so the two bars move
  // alike. Returns a linear 0..1 amplitude peak; display mapping is the caller's.
  let held = 0;

  return {
    track,
    deviceId: track.getSettings().deviceId ?? "",
    level() {
      analyser.getFloatTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) {
        const a = Math.abs(buf[i]);
        if (a > peak) peak = a;
      }
      held = Math.max(peak, held * 0.82);
      return Math.min(1, held);
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
