type Operation = 'begin' | 'exchange';
const policies = {
  begin: { window: 600_000, limit: 5 },
  exchange: { window: 60_000, limit: 30 },
};

/** Socket peers are authoritative; forwarded headers must never mint fresh quotas. */
export class PairingRateLimit {
  private peers = new Map<string, { expiresAt: number; count: number }>();
  constructor(private now = () => Date.now()) {}

  retryAfter(address: string | undefined, operation: Operation): number {
    const now = this.now();
    for (const [key, peer] of this.peers) if (peer.expiresAt <= now) this.peers.delete(key);
    const key = operation + ':' + (address || 'unknown').replace(/^::ffff:/, '');
    let peer = this.peers.get(key);
    const policy = policies[operation];
    if (!peer) {
      // Fail closed rather than evicting active quotas under a many-address flood.
      if (this.peers.size >= 1024) return 60;
      peer = { expiresAt: now + policy.window, count: 0 };
      this.peers.set(key, peer);
    }
    if (peer.count >= policy.limit) return Math.ceil((peer.expiresAt - now) / 1000);
    peer.count++;
    return 0;
  }
}
