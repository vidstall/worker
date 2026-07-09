import { readIdFrame } from './distinguishable-media';

export class StreamIdentityChecker {
  private observed = 0; private matched = 0; private mismatched = 0;
  constructor(private width: number, private height: number) {}
  observe(expectedId: number, frame: Uint8Array): void {
    this.observed++;
    if (readIdFrame(frame, this.width, this.height) === expectedId) this.matched++;
    else this.mismatched++;
  }
  summary() {
    return { observed: this.observed, matched: this.matched,
             mismatched: this.mismatched, ok: this.mismatched === 0 && this.observed > 0 };
  }
}
