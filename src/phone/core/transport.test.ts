import { afterEach, describe, expect, it, vi } from "vitest";

import { enableOpusStereo, PhoneTransport } from "./transport";

const OFFER = [
  "v=0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "a=rtpmap:111 opus/48000/2",
  "a=fmtp:111 minptime=10;useinbandfec=1",
  "",
].join("\r\n");

describe("enableOpusStereo", () => {
  it("adds stereo params to an existing opus fmtp line", () => {
    const out = enableOpusStereo(OFFER);
    const fmtp = out.split("\r\n").find((l) => l.startsWith("a=fmtp:111"))!;
    expect(fmtp).toContain("stereo=1");
    expect(fmtp).toContain("sprop-stereo=1");
    // Existing params are preserved, not duplicated.
    expect(fmtp).toContain("minptime=10");
    expect(fmtp.match(/useinbandfec=1/g)?.length).toBe(1);
  });

  it("is idempotent — re-running does not duplicate stereo", () => {
    const once = enableOpusStereo(OFFER);
    const twice = enableOpusStereo(once);
    expect(twice).toBe(once);
    const params = twice
      .split("\r\n")
      .find((l) => l.startsWith("a=fmtp:111"))!
      .replace("a=fmtp:111 ", "")
      .split(";");
    expect(params.filter((p) => p === "stereo=1").length).toBe(1);
    expect(params.filter((p) => p === "sprop-stereo=1").length).toBe(1);
  });

  it("synthesizes an fmtp line when opus has none", () => {
    const noFmtp = ["a=rtpmap:111 opus/48000/2", ""].join("\r\n");
    const out = enableOpusStereo(noFmtp);
    expect(out).toContain("a=fmtp:111 stereo=1;sprop-stereo=1;useinbandfec=1");
  });

  it("leaves SDP without opus untouched", () => {
    const noOpus = ["a=rtpmap:0 PCMU/8000", ""].join("\r\n");
    expect(enableOpusStereo(noOpus)).toBe(noOpus);
  });
});

// ── setLowBandwidth (sender bitrate cap) ──

class FakeSender {
  track = { kind: "audio" };
  params: RTCRtpSendParameters = { encodings: [{}] } as RTCRtpSendParameters;
  getParameters() {
    return this.params;
  }
  setParameters(p: RTCRtpSendParameters) {
    this.params = p;
    return Promise.resolve();
  }
  replaceTrack() {
    return Promise.resolve();
  }
}

class FakePC {
  sender = new FakeSender();
  createOffer = vi.fn();
  addTransceiver() {}
  getSenders() {
    return [this.sender];
  }
  setLocalDescription() {
    return Promise.resolve();
  }
  close() {}
}

describe("PhoneTransport.setLowBandwidth", () => {
  afterEach(() => {
    delete (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
  });

  function makeTransport() {
    const pc = new FakePC();
    // A real (non-arrow) function so `new RTCPeerConnection(...)` returns our pc.
    (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = function () {
      return pc;
    } as unknown;
    const t = new PhoneTransport({ kind: "audio" } as MediaStreamTrack, {
      onLocalCandidate() {},
      onConnected() {},
      onFailed() {},
    });
    return { t, pc };
  }

  it("sets and clears the sender maxBitrate without renegotiating", async () => {
    const { t, pc } = makeTransport();
    await t.setLowBandwidth(true);
    expect(pc.sender.params.encodings?.[0].maxBitrate).toBe(28_000);
    await t.setLowBandwidth(false);
    expect(pc.sender.params.encodings?.[0].maxBitrate).toBeUndefined();
    expect(pc.createOffer).not.toHaveBeenCalled();
  });

  it("re-asserts the cap after replaceTrack", async () => {
    const { t, pc } = makeTransport();
    await t.setLowBandwidth(true);
    pc.sender.params.encodings![0].maxBitrate = undefined; // simulate sender reset
    await t.replaceTrack({ kind: "audio" } as MediaStreamTrack);
    expect(pc.sender.params.encodings?.[0].maxBitrate).toBe(28_000);
  });
});
