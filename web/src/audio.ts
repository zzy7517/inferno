/** WebAudio 合成音效（零素材）：所有打击反馈声音的同帧来源（ADR-0004 六通道之"音效"） */

class AudioSys {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  muted = false;

  init(): void {
    if (this.ctx) { void this.ctx.resume(); return; }
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.55;
    this.master.connect(this.ctx.destination);
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.55;
    return this.muted;
  }

  private tone(f0: number, f1: number, dur: number, type: OscillatorType, vol: number, delay = 0): void {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + dur + 0.05);
  }

  private noise(dur: number, freq: number, vol: number, type: BiquadFilterType = "lowpass", delay = 0, q = 1): void {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime + delay;
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
  }

  // ---- 战斗 ----
  whoosh(pitch = 1): void { this.noise(0.16 * pitch, 900 * pitch, 0.16, "bandpass", 0, 2.5); }
  swingHeavy(): void { this.noise(0.28, 500, 0.28, "bandpass", 0, 2); this.tone(180, 90, 0.22, "sine", 0.12); }
  hitLight(): void { this.tone(170, 85, 0.09, "sine", 0.4); this.noise(0.08, 1100, 0.25); }
  hitHeavy(): void { this.tone(120, 55, 0.16, "sine", 0.55); this.noise(0.13, 500, 0.35); this.tone(260, 140, 0.05, "square", 0.1); }
  hitStone(): void { this.tone(95, 45, 0.14, "sine", 0.5); this.noise(0.1, 380, 0.4); }
  blockHit(): void { this.tone(320, 180, 0.1, "square", 0.2); this.noise(0.09, 1600, 0.2, "highpass"); }
  parry(): void {
    this.tone(1500, 900, 0.28, "triangle", 0.4);
    this.tone(2300, 1500, 0.18, "sine", 0.25);
    this.noise(0.06, 3000, 0.15, "highpass");
  }
  riposte(): void { this.hitHeavy(); this.tone(700, 200, 0.3, "sawtooth", 0.2, 0.05); }
  hurt(): void { this.tone(280, 130, 0.18, "sawtooth", 0.3); }
  guardBreak(): void { this.tone(400, 100, 0.4, "square", 0.3); this.noise(0.3, 700, 0.3); }

  // ---- Boss / 流程 ----
  roar(): void { this.tone(90, 48, 0.8, "sawtooth", 0.5); this.noise(0.7, 240, 0.4); }
  rise(): void { this.noise(1.6, 120, 0.5); this.tone(50, 80, 1.4, "sine", 0.35); }
  telegraph(): void { this.noise(0.2, 2200, 0.1, "highpass"); this.tone(500, 700, 0.1, "triangle", 0.06); }
  transform(): void { this.roar(); this.noise(0.9, 900, 0.4, "bandpass", 0.2, 1.5); }
  slamShock(): void { this.tone(70, 30, 0.35, "sine", 0.6); this.noise(0.3, 300, 0.5); }
  estus(): void { this.tone(480, 660, 0.12, "sine", 0.2); this.tone(520, 720, 0.12, "sine", 0.2, 0.14); }
  deathSting(): void { this.tone(160, 60, 1.2, "sine", 0.4); this.tone(110, 45, 1.5, "triangle", 0.25, 0.1); }
  victoryBell(): void { this.tone(660, 655, 1.4, "sine", 0.3); this.tone(880, 875, 1.6, "sine", 0.2, 0.25); this.tone(1320, 1310, 1.2, "sine", 0.1, 0.25); }
  soulGain(): void { this.tone(900, 1400, 0.25, "sine", 0.15); }
  fogGate(): void { this.noise(0.8, 600, 0.2, "bandpass", 0, 0.8); }
  bonfireRest(): void { this.tone(520, 515, 1.2, "sine", 0.2); this.noise(0.6, 1400, 0.08, "highpass"); }
}

export const AU = new AudioSys();
