'use strict';
/**
 * The orb: a translucent sphere with a river of particles flowing through it.
 *
 * The sphere is drawn with limb brightening — dark in the middle, luminous at
 * the rim — so it reads as a volume of glass rather than a filled disc. Through
 * it runs a waveform made of a few hundred particles on three strands, drifting
 * sideways and displaced vertically by the audio spectrum. The wave extends past
 * the sphere on both sides and fades out, so the sphere looks like it is sitting
 * in the middle of something larger.
 *
 * Amplitude comes from real audio: your voice while it listens, its own while it
 * speaks. With no audio, each state gets its own motion so it is never static.
 */

(function () {
  const STATES = {
    idle:      { rgb: [198, 158, 100], rim: 0.30, amp: 0.16, flow: 0.028, glow: 0.26 },
    listening: { rgb: [150, 196, 240], rim: 0.72, amp: 1.00, flow: 0.060, glow: 0.62 },
    thinking:  { rgb: [233, 169, 77],  rim: 0.52, amp: 0.42, flow: 0.115, glow: 0.50 },
    speaking:  { rgb: [247, 194, 115], rim: 0.85, amp: 1.00, flow: 0.052, glow: 0.92 },
    error:     { rgb: [224, 96, 95],   rim: 0.34, amp: 0.18, flow: 0.026, glow: 0.40 },
  };

  const PARTICLES = 440;
  const STRANDS = [
    { freq: 2.0, speed: 0.75, phase: 0.0, weight: 1.00 },
    { freq: 3.1, speed: -0.55, phase: 1.9, weight: 0.62 },
    { freq: 1.4, speed: 0.42, phase: 3.7, weight: 0.78 },
  ];
  const TAU = Math.PI * 2;

  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp01 = (v) => Math.max(0, Math.min(1, v));

  class Orb {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.state = 'idle';
      this.level = 0;
      this.smoothLevel = 0;
      this.spectrum = null;
      this.t = 0;

      const s = STATES.idle;
      this.rgb = [...s.rgb];
      this.rim = s.rim;
      this.amp = s.amp;
      this.glow = s.glow;

      // Fixed per-particle character, so the scatter is stable rather than
      // reshuffling every frame.
      this.particles = Array.from({ length: PARTICLES }, () => ({
        u: Math.random(),
        strand: Math.floor(Math.random() * STRANDS.length),
        jitter: (Math.random() * 2 - 1) ** 3, // cubed: most sit near the strand
        drift: 0.6 + Math.random() * 0.8,
        size: 0.28 + Math.random() * 0.72,
        twinkle: Math.random() * TAU,
      }));

      this.running = false;
      this.resize();
      window.addEventListener('resize', () => this.resize());
      // CSS resizes the canvas when a conversation starts, with no window resize
      // event to accompany it.
      if (window.ResizeObserver) new ResizeObserver(() => this.resize()).observe(canvas);
    }

    resize() {
      const dpr = window.devicePixelRatio || 1;
      const rect = this.canvas.getBoundingClientRect();
      this.w = rect.width || 168;
      this.h = rect.height || 168;
      this.canvas.width = Math.round(this.w * dpr);
      this.canvas.height = Math.round(this.h * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    setState(state) {
      if (STATES[state]) this.state = state;
    }

    /**
     * Recolour the orb for a persona. Only the base colours change; the motion,
     * glow and amplitude response are what make it read as the same object.
     * Colours are eased toward, so switching persona is a fade rather than a jump.
     */
    setPalette(palette) {
      if (!palette) return;
      for (const [state, rgb] of Object.entries(palette)) {
        if (STATES[state] && Array.isArray(rgb) && rgb.length === 3) {
          STATES[state].rgb = rgb.slice();
        }
      }
    }

    setLevel(value) {
      this.level = clamp01(value || 0);
    }

    setSpectrum(data) {
      this.spectrum = data && data.length ? data : null;
    }

    start() {
      if (this.running) return;
      this.running = true;
      let last = performance.now();
      const frame = (now) => {
        if (!this.running) return;
        const dt = Math.min((now - last) / 1000, 0.05);
        last = now;
        this.draw(dt);
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    }

    stop() {
      this.running = false;
    }

    /** Local wave energy at horizontal position `u` (0..1), returned 0..1. */
    energyAt(u) {
      // Mirror around the centre so the wave is symmetric left to right.
      const phase = Math.abs(u - 0.5) * 2;

      if (this.spectrum && (this.state === 'listening' || this.state === 'speaking')) {
        const bins = Math.floor(this.spectrum.length * 0.34);
        const idx = Math.floor(Math.pow(phase, 1.3) * bins);
        let sum = 0;
        let n = 0;
        for (let k = idx; k < Math.min(idx + 3, bins); k++) {
          sum += this.spectrum[k];
          n++;
        }
        return Math.pow(n ? sum / n / 255 : 0, 0.7);
      }

      if (this.state === 'thinking') {
        // A swell travelling along the wave, so waiting has a pulse.
        const head = (this.t * 0.5) % 1;
        let d = Math.abs(u - head);
        d = Math.min(d, 1 - d);
        return Math.exp(-Math.pow(d * 4.5, 2)) * 0.9 + 0.14;
      }

      return 0.42 + 0.32 * Math.sin(u * Math.PI * 3 + this.t * 0.7);
    }

    draw(dt) {
      const ctx = this.ctx;
      const target = STATES[this.state] || STATES.idle;

      for (let i = 0; i < 3; i++) this.rgb[i] = lerp(this.rgb[i], target.rgb[i], 0.07);
      this.rim = lerp(this.rim, target.rim, 0.07);
      this.amp = lerp(this.amp, target.amp, 0.07);
      this.glow = lerp(this.glow, target.glow, 0.07);
      this.smoothLevel = lerp(this.smoothLevel, this.level, this.level > this.smoothLevel ? 0.4 : 0.09);

      this.t += dt;

      const { w, h } = this;
      const cx = w / 2;
      const cy = h / 2;
      const [r, g, b] = this.rgb.map(Math.round);
      const unit = Math.min(w, h);
      const R = unit * 0.30 * (1 + this.smoothLevel * 0.03);
      const amp = this.smoothLevel;
      const span = R * 3.9;          // the wave runs well past the sphere
      const waveHeight = R * 0.62;

      ctx.clearRect(0, 0, w, h);
      ctx.save();

      // Outer atmosphere.
      const halo = ctx.createRadialGradient(cx, cy, R * 0.4, cx, cy, unit * 0.5);
      halo.addColorStop(0, `rgba(${r},${g},${b},${0.13 * this.glow + amp * 0.1})`);
      halo.addColorStop(0.6, `rgba(${r},${g},${b},${0.04 * this.glow})`);
      halo.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, w, h);

      // The sphere's body: nearly hollow, so the particles show through it.
      const body = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
      body.addColorStop(0, `rgba(${r},${g},${b},${0.03 + amp * 0.03})`);
      body.addColorStop(0.72, `rgba(${r},${g},${b},${0.05 + amp * 0.04})`);
      body.addColorStop(1, `rgba(${r},${g},${b},${0.14 * this.rim})`);
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, TAU);
      ctx.fillStyle = body;
      ctx.fill();

      // Limb brightening: a bright band just inside the edge is what makes it
      // read as glass rather than a flat disc.
      const limb = ctx.createRadialGradient(cx, cy, R * 0.78, cx, cy, R * 1.02);
      limb.addColorStop(0, `rgba(${r},${g},${b},0)`);
      limb.addColorStop(0.72, `rgba(${Math.min(255, r + 30)},${Math.min(255, g + 30)},${Math.min(255, b + 30)},${0.30 * this.rim + amp * 0.15})`);
      limb.addColorStop(1, `rgba(${r},${g},${b},0)`);
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.02, 0, TAU);
      ctx.fillStyle = limb;
      ctx.fill();

      // A crisp hairline holds the silhouette together at small sizes.
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, TAU);
      ctx.strokeStyle = `rgba(${Math.min(255, r + 40)},${Math.min(255, g + 36)},${Math.min(255, b + 28)},${0.34 * this.rim + amp * 0.2})`;
      ctx.lineWidth = 1;
      ctx.stroke();

      // The particle river. Additive blending makes overlapping particles bloom
      // on their own, and costs a fraction of a shadow blur on 440 arcs a frame.
      ctx.globalCompositeOperation = 'lighter';
      for (const p of this.particles) {
        const strand = STRANDS[p.strand];
        // Drift sideways and wrap, which is what gives it flow.
        const u = (p.u + this.t * target.flow * p.drift) % 1;
        const x = cx + (u - 0.5) * span;

        // Taper the wave towards its ends so it dissolves instead of stopping.
        // A gentle exponent keeps particles alive well outside the sphere.
        const envelope = Math.pow(Math.sin(clamp01(u) * Math.PI), 0.85);
        const energy = this.energyAt(u);
        const swing =
          Math.sin(u * strand.freq * TAU + this.t * strand.speed * 2.2 + strand.phase) *
          waveHeight * strand.weight * envelope * (0.22 + energy * this.amp);

        const y = cy + swing + p.jitter * waveHeight * 0.42 * envelope * (0.3 + energy * 0.7);

        // Particles inside the sphere glow harder — it looks lit from within.
        const inside = Math.hypot(x - cx, y - cy) < R;
        const twinkle = 0.72 + 0.28 * Math.sin(this.t * 3 + p.twinkle);
        const alpha = envelope * twinkle * (inside ? 0.95 : 0.5) * (0.35 + energy * 0.65);
        if (alpha <= 0.01) continue;

        const size = p.size * (inside ? 1.15 : 1) * (0.85 + amp * 0.4);
        ctx.fillStyle = inside
          ? `rgba(${Math.min(255, r + 34)},${Math.min(255, g + 30)},${Math.min(255, b + 24)},${alpha})`
          : `rgba(${r},${g},${b},${alpha * 0.8})`;
        ctx.beginPath();
        ctx.arc(x, y, size, 0, TAU);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';

      ctx.restore();
    }
  }

  window.VerityOrb = Orb;
})();
