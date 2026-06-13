import { describe, expect, it } from "vitest";

import {
  candidateMessage,
  isFatalErrorCode,
  offerMessage,
  pairingFromHash,
  parseServerMessage,
  PROTOCOL_VERSION,
  statsMessage,
} from "./protocol";

describe("pairingFromHash", () => {
  it("parses session and token from the fragment", () => {
    expect(pairingFromHash("#s=abc&t=xyz")).toEqual({ session: "abc", token: "xyz" });
  });
  it("returns null when either field is missing", () => {
    expect(pairingFromHash("#s=abc")).toBeNull();
    expect(pairingFromHash("#t=xyz")).toBeNull();
    expect(pairingFromHash("")).toBeNull();
  });
});

describe("client message builders", () => {
  it("offerMessage carries the version and sdp", () => {
    expect(offerMessage("v=0...")).toEqual({ v: PROTOCOL_VERSION, type: "offer", sdp: "v=0..." });
  });
  it("candidateMessage normalizes nullable fields", () => {
    expect(candidateMessage({ candidate: "cand", sdpMid: "0", sdpMLineIndex: 0 })).toEqual({
      v: PROTOCOL_VERSION,
      type: "candidate",
      candidate: "cand",
      sdpMid: "0",
      sdpMLineIndex: 0,
    });
    expect(candidateMessage({})).toEqual({
      v: PROTOCOL_VERSION,
      type: "candidate",
      candidate: "",
      sdpMid: null,
      sdpMLineIndex: null,
    });
  });
  it("statsMessage carries level, visibility, and mute state", () => {
    expect(statsMessage(0.5, true)).toEqual({
      v: PROTOCOL_VERSION,
      type: "stats",
      micLevel: 0.5,
      visible: true,
      muted: false,
    });
    expect(statsMessage(0, true, true).muted).toBe(true);
  });
});

describe("parseServerMessage", () => {
  it("parses a known message with the right version", () => {
    const msg = parseServerMessage(JSON.stringify({ v: 1, type: "accepted" }));
    expect(msg).toEqual({ v: 1, type: "accepted" });
  });
  it("rejects a wrong major version", () => {
    expect(parseServerMessage(JSON.stringify({ v: 2, type: "accepted" }))).toBeNull();
  });
  it("rejects malformed JSON and non-objects", () => {
    expect(parseServerMessage("not json")).toBeNull();
    expect(parseServerMessage("42")).toBeNull();
  });
  it("ignores unknown message types (forward compatibility)", () => {
    expect(parseServerMessage(JSON.stringify({ v: 1, type: "warp-drive" }))).toBeNull();
  });
});

describe("isFatalErrorCode", () => {
  it("marks the documented fatal codes", () => {
    for (const code of ["version", "bad-token", "unknown-session", "busy", "rejected", "malformed"]) {
      expect(isFatalErrorCode(code)).toBe(true);
    }
  });
  it("treats unknown / non-fatal codes as recoverable", () => {
    expect(isFatalErrorCode("unsupported")).toBe(false);
    expect(isFatalErrorCode("webrtc")).toBe(false);
  });
});
