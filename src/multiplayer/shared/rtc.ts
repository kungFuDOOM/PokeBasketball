// A direct WebRTC data channel between the two players, so gameplay traffic stays off Supabase Realtime (whose
// message quota and per-second limit can't carry many games: every broadcast counts once sent and once received).
//
// Privacy and safety: the connection is relay-only (iceTransportPolicy 'relay', through TURN servers whose
// short-lived credentials come from the pokejam-ice Edge Function), so neither player ever learns the other's
// IP address. Without TURN credentials no direct connection is tried and the match stays on Realtime.
//
// Signalling (offer, answer, ICE candidates) rides the match's private Realtime channel: a handful of messages.
// Two negotiated channels: "fast" (unordered, no retransmits) for inputs, which lockstep resends until they're
// acknowledged anyway, and "ctl" (reliable, ordered) for snapshots and goodbyes.
import type { NetMsg } from './lockstep';

export type RtcSignal =
  | { k: 'offer'; sdp: string }
  | { k: 'answer'; sdp: string }
  | { k: 'ice'; c: RTCIceCandidateInit };

/** Biggest message either side accepts (a snapshot is a few KB). */
const MAX_BYTES = 64 * 1024;

export class RtcLink {
  readonly pc: RTCPeerConnection;
  private fast: RTCDataChannel;
  private ctl: RTCDataChannel;
  private closed = false;
  private pendingIce: RTCIceCandidateInit[] = [];
  private remoteSet = false;
  onMessage: (m: unknown) => void = () => {};
  onOpen: () => void = () => {};
  onClose: () => void = () => {};

  constructor(private side: 0 | 1, iceServers: RTCIceServer[], private signal: (s: RtcSignal) => void, policy: RTCIceTransportPolicy = 'relay') {
    this.pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: policy });
    this.fast = this.pc.createDataChannel('fast', { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 });
    this.ctl = this.pc.createDataChannel('ctl', { negotiated: true, id: 1, ordered: true });
    for (const ch of [this.fast, this.ctl]) {
      ch.onmessage = (e) => {
        if (typeof e.data !== 'string' || e.data.length > MAX_BYTES) return;
        try { this.onMessage(JSON.parse(e.data)); } catch { /* not JSON: ignored */ }
      };
    }
    let opened = 0;
    const opening = () => { if (++opened === 2) this.onOpen(); };
    this.fast.onopen = opening;
    this.ctl.onopen = opening;
    this.pc.onicecandidate = (e) => { if (e.candidate) this.signal({ k: 'ice', c: e.candidate.toJSON() }); };
    this.pc.onconnectionstatechange = () => {
      if (this.pc.connectionState === 'failed' || this.pc.connectionState === 'closed') this.close();
    };
  }

  get open(): boolean {
    return !this.closed && this.fast.readyState === 'open' && this.ctl.readyState === 'open';
  }

  /** Host: start the connection. */
  async start() {
    if (this.side !== 0) return;
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.signal({ k: 'offer', sdp: offer.sdp ?? '' });
  }

  /** A signalling message from the other player (unchecked input: anything odd closes the link). */
  async handle(raw: unknown) {
    if (this.closed || !raw || typeof raw !== 'object') return;
    const s = raw as Partial<RtcSignal> & { sdp?: unknown; c?: unknown };
    try {
      if (s.k === 'offer' && this.side === 1 && typeof s.sdp === 'string' && s.sdp.length < MAX_BYTES && !this.remoteSet) {
        await this.pc.setRemoteDescription({ type: 'offer', sdp: s.sdp });
        await this.remoteReady();
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.signal({ k: 'answer', sdp: answer.sdp ?? '' });
      } else if (s.k === 'answer' && this.side === 0 && typeof s.sdp === 'string' && s.sdp.length < MAX_BYTES && !this.remoteSet) {
        await this.pc.setRemoteDescription({ type: 'answer', sdp: s.sdp });
        await this.remoteReady();
      } else if (s.k === 'ice' && s.c && typeof s.c === 'object' && this.pendingIce.length < 50) {
        if (this.remoteSet) await this.pc.addIceCandidate(s.c as RTCIceCandidateInit);
        else this.pendingIce.push(s.c as RTCIceCandidateInit);
      }
    } catch {
      this.close();
    }
  }

  private async remoteReady() {
    this.remoteSet = true;
    for (const c of this.pendingIce.splice(0)) await this.pc.addIceCandidate(c);
  }

  send(m: NetMsg) {
    if (!this.open) return;
    const data = JSON.stringify(m);
    // Inputs and hashes can be lost (they're resent); snapshots and goodbyes must arrive.
    (m.k === 'in' || m.k === 'h' || m.k === 'ping' || m.k === 'pong' ? this.fast : this.ctl).send(data);
  }

  /** How the relay carries our traffic: 'udp', 'tcp' or 'tls' (the selected local candidate's relayProtocol), else 'unknown'. */
  async relayProtocol(): Promise<'udp' | 'tcp' | 'tls' | 'unknown'> {
    try {
      const stats = await this.pc.getStats();
      let pairId: string | undefined;
      stats.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId; });
      let local: string | undefined;
      stats.forEach((r) => { if (r.type === 'candidate-pair' && (r.id === pairId || (!pairId && r.nominated && r.state === 'succeeded'))) local = r.localCandidateId; });
      let proto: string | undefined;
      stats.forEach((r) => { if (r.type === 'local-candidate' && r.id === local) proto = r.relayProtocol; });
      return proto === 'udp' || proto === 'tcp' || proto === 'tls' ? proto : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.fast.close(); this.ctl.close(); this.pc.close(); } catch { /* already gone */ }
    this.onClose();
  }
}
