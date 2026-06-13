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
    await this.pc.setLocalDescription(offer);
    return this.pc.localDescription?.sdp ?? offer.sdp ?? "";
  }

  async setAnswer(sdp: string): Promise<void> {
    await this.pc.setRemoteDescription({ type: "answer", sdp });
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
