/**
 * WebRTC transport: send one mic track to AudioManager.
 *
 * Framework-free. The phone is always the offerer (it owns the mic track);
 * the desktop answers. iceServers is empty — LAN only, host candidates
 * (decision D6). The owner relays SDP/candidates over the signaling socket.
 */

export interface TransportCallbacks {
  onLocalCandidate(candidate: RTCIceCandidateInit): void;
  onConnected(): void;
  onFailed(): void;
}

export class PhoneTransport {
  private readonly pc: RTCPeerConnection;
  private lowBandwidth = false;

  constructor(track: MediaStreamTrack, cb: TransportCallbacks) {
    this.pc = new RTCPeerConnection({ iceServers: [] });
    this.pc.addTransceiver(track, { direction: "sendonly" });

    this.pc.onicecandidate = (ev) => {
      if (ev.candidate) cb.onLocalCandidate(ev.candidate.toJSON());
    };
    this.pc.oniceconnectionstatechange = () => {
      const s = this.pc.iceConnectionState;
      if (s === "connected" || s === "completed") cb.onConnected();
      else if (s === "failed") cb.onFailed();
    };
  }

  async createOffer(): Promise<string> {
    const offer = await this.pc.createOffer();
    offer.sdp = enableOpusStereo(offer.sdp ?? "");
    await this.pc.setLocalDescription(offer);
    return this.pc.localDescription?.sdp ?? offer.sdp ?? "";
  }

  async setAnswer(sdp: string): Promise<void> {
    await this.pc.setRemoteDescription({ type: "answer", sdp });
  }

  /**
   * Swap the outgoing mic track in place (mic picker / processing-toggle
   * re-acquire) without renegotiating — replaceTrack keeps the same sender.
   */
  async replaceTrack(track: MediaStreamTrack): Promise<void> {
    const sender = this.pc.getSenders().find((s) => s.track?.kind === "audio");
    if (sender) await sender.replaceTrack(track);
    await this.applyEncodings(); // re-assert the bitrate cap on the (same) sender
  }

  /**
   * Cap the Opus send bitrate for slow WiFi (~28 kb/s, still fine for speech).
   * Pure sender-side via setParameters — NO renegotiation. Off = WebRTC default.
   */
  async setLowBandwidth(on: boolean): Promise<void> {
    this.lowBandwidth = on;
    await this.applyEncodings();
  }

  private async applyEncodings(): Promise<void> {
    const sender = this.pc.getSenders().find((s) => s.track?.kind === "audio");
    if (!sender) return;
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    params.encodings[0].maxBitrate = this.lowBandwidth ? 28_000 : undefined;
    try {
      await sender.setParameters(params);
    } catch {
      // Some browsers reject setParameters before the first negotiation; the
      // next replaceTrack/toggle re-applies it harmlessly.
    }
  }

  async addCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    try {
      await this.pc.addIceCandidate(candidate);
    } catch {
      // A candidate arriving before the answer is applied is harmless to drop;
      // connectivity still forms from the remaining candidates.
    }
  }

  close(): void {
    this.pc.onicecandidate = null;
    this.pc.oniceconnectionstatechange = null;
    this.pc.close();
  }
}

/**
 * Add Opus `stereo=1;sprop-stereo=1` to the offer so a two-channel mic is
 * encoded as stereo (Chrome/Firefox default Opus to mono otherwise). Harmless
 * for a mono mic — the encoder still sends one channel. Leaves the SDP untouched
 * if no Opus codec is present.
 */
export function enableOpusStereo(sdp: string): string {
  const rtpmap = sdp.match(/a=rtpmap:(\d+)\s+opus\/48000/i);
  if (!rtpmap) return sdp;
  const pt = rtpmap[1];
  const fmtp = new RegExp(`a=fmtp:${pt} (.*)`, "i");
  if (fmtp.test(sdp)) {
    return sdp.replace(fmtp, (_m, params: string) => {
      let p = params;
      if (!/(^|;)\s*stereo=/.test(p)) p += ";stereo=1";
      if (!/(^|;)\s*sprop-stereo=/.test(p)) p += ";sprop-stereo=1";
      if (!/(^|;)\s*useinbandfec=/.test(p)) p += ";useinbandfec=1";
      return `a=fmtp:${pt} ${p}`;
    });
  }
  return sdp.replace(
    new RegExp(`(a=rtpmap:${pt} opus/48000[^\\r\\n]*\\r?\\n)`, "i"),
    `$1a=fmtp:${pt} stereo=1;sprop-stereo=1;useinbandfec=1\r\n`,
  );
}
