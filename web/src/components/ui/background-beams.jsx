import { useEffect, useRef } from 'react';
import { cn, prefersReducedMotion } from '../../lib/utils.js';

/**
 * Aceternity UI「Background Beams」移植版（canvas 实现，性能友好）。
 * 依据官方组件语义：多条光束沿路径流动 + 发光束头，用于 Hero 背景。
 * 优化：标签页隐藏自动暂停、尊重 prefers-reduced-motion、光束数随宽度自适应。
 */
export function BackgroundBeams({ className, intensity = 1 }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let raf = 0;
    let running = true;
    const reduced = prefersReducedMotion();

    const size = () => {
      const r = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, r.width * dpr);
      canvas.height = Math.max(1, r.height * dpr);
    };
    size();

    const rand = (a, b) => a + Math.random() * (b - a);

    class Beam {
      constructor(seed = false) {
        this.reset();
        if (seed) this.y = rand(0, canvas.height);
      }
      reset() {
        this.w = canvas.width;
        this.h = canvas.height;
        this.x = rand(-40 * dpr, this.w + 40 * dpr);
        this.y = -30 * dpr;
        this.angle = Math.PI / 2 + rand(-0.32, 0.32);
        this.speed = rand(0.5, 1.9) * dpr * intensity;
        this.len = rand(70, 240) * dpr;
        this.width = rand(0.6, 1.5) * dpr;
        this.opacity = rand(0.12, 0.42);
        this.hue = Math.random() < 0.32 ? 258 : 189; // 紫罗兰 or 青电光
      }
      step() {
        this.x += Math.cos(this.angle) * this.speed;
        this.y += Math.sin(this.angle) * this.speed;
        if (this.y - this.len > this.h || this.x < -80 * dpr || this.x > this.w + 80 * dpr) this.reset();
      }
      draw() {
        const tx = this.x - Math.cos(this.angle) * this.len;
        const ty = this.y - Math.sin(this.angle) * this.len;
        const g = ctx.createLinearGradient(tx, ty, this.x, this.y);
        g.addColorStop(0, `hsla(${this.hue},92%,62%,0)`);
        g.addColorStop(1, `hsla(${this.hue},92%,66%,${this.opacity})`);
        ctx.strokeStyle = g;
        ctx.lineWidth = this.width;
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(this.x, this.y);
        ctx.stroke();
        ctx.fillStyle = `hsla(${this.hue},96%,78%,${Math.min(1, this.opacity + 0.28)})`;
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.width * 1.15, 0, 6.2832);
        ctx.fill();
      }
    }

    const count = Math.max(12, Math.min(30, Math.round(canvas.width / (70 * dpr))));
    const beams = Array.from({ length: count }, () => new Beam(true));

    const loop = () => {
      if (!running) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const b of beams) {
        if (!reduced) b.step();
        b.draw();
      }
      if (!reduced) raf = requestAnimationFrame(loop);
    };
    loop(); // reduced-motion 下只画一帧静态光束

    const onVis = () => {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(raf);
      } else if (!running && !reduced) {
        running = true;
        loop();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    const ro = new ResizeObserver(() => {
      size();
      for (const b of beams) b.reset();
    });
    ro.observe(canvas);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVis);
      ro.disconnect();
    };
  }, [intensity]);

  return <canvas ref={canvasRef} aria-hidden="true" className={cn('absolute inset-0 h-full w-full', className)} />;
}
