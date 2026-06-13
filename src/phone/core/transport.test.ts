import { describe, expect, it } from "vitest";

import { enableOpusStereo } from "./transport";

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
