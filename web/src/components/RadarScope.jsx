import { useEffect, useRef, useState } from 'react';
import { SOURCE_LABEL } from '../lib/api.js';

export const SRC_COLOR = {
  hn: '#ff8a3d',
  gh_trending: '#8ab4ff',
  hf_papers: '#c58bff',
  blog: '#3ef2a5',
  web_search: '#ffd166',
  twitter: '#e8e8e8',
};

const SPAN = 6 * 3600e3; // 雷达时间窗口：近 6 小时（圆心=最新，外圈=6 小时前）

/**
 * 雷达盘：角度=信息源扇区，半径=时间，光点=一条内容。
 * 带时间刻度环、来源中文标签、悬停提示、点击打开原文。
 */
export default function RadarScope({ items, scanning, sources }) {
  const ref = useRef(null);
  const dataRef = useRef({ items: [], scanning: false, sources: [] });
  dataRef.current = { items, scanning, sources };
  const angleRef = useRef(0);
  const dotsRef = useRef([]); // CSS 像素坐标，用于命中检测
  const hoverRef = useRef(-1); // 当前悬停光点索引
  const [tip, setTip] = useState(null); // {x,y,item}

  useEffect(() => {
    const cvs = ref.current;
    const ctx = cvs.getContext('2d');
    let raf;
    let dpr = Math.min(window.devicePixelRatio || 1, 2);

    const resize = () => {
      const r = cvs.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      cvs.width = r.width * dpr;
      cvs.height = r.height * dpr;
    };
    resize();
    window.addEventListener('resize', resize);

    const draw = () => {
      const { items, scanning, sources } = dataRef.current;
      const W = cvs.width;
      const H = cvs.height;
      const cx = W / 2;
      const cy = H / 2;
      const R = Math.min(W, H) / 2 - 26 * dpr;
      const now = Date.now();

      ctx.clearRect(0, 0, W, H);

      // 同心环 + 时间刻度（圆心=最新 → 外圈=6小时前）
      ctx.strokeStyle = 'rgba(34,52,79,0.85)';
      ctx.lineWidth = 1 * dpr;
      const timeLabels = ['1.5h', '3h', '4.5h', '6h前'];
      for (let i = 1; i <= 4; i++) {
        ctx.beginPath();
        ctx.arc(cx, cy, (R * i) / 4, 0, Math.PI * 2);
        ctx.globalAlpha = 0.5 + i * 0.12;
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.font = `${9 * dpr}px ui-monospace, Consolas, monospace`;
        const lx = cx + (R * i) / 4 + 3 * dpr;
        const ly = cy;
        const tw = ctx.measureText(timeLabels[i - 1]).width;
        ctx.fillStyle = 'rgba(4,6,12,0.82)'; // 暗色衬底防重叠
        ctx.fillRect(lx - 2 * dpr, ly - 6.5 * dpr, tw + 4 * dpr, 13 * dpr);
        ctx.fillStyle = '#5d7089';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(timeLabels[i - 1], lx, ly);
      }
      // 中心"现在"标记
      ctx.fillStyle = '#4a5d78';
      ctx.textAlign = 'center';
      ctx.fillText('现在', cx, cy - 10 * dpr);

      // 来源射线 + 中文标签（含条数）
      const list = sources.length ? sources : [];
      const n = Math.max(list.length, 1);
      const counts = {};
      for (const it of items) counts[it.source] = (counts[it.source] || 0) + 1;
      ctx.font = `${10 * dpr}px ui-monospace, Consolas, monospace`;
      list.forEach((s, i) => {
        const a = (i / n) * Math.PI * 2 - Math.PI / 2;
        ctx.strokeStyle = 'rgba(22,35,58,0.9)';
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
        ctx.stroke();
        const col = SRC_COLOR[s.source] || '#61748f';
        ctx.fillStyle = col;
        ctx.globalAlpha = 0.95;
        const lx = cx + Math.cos(a) * (R + 14 * dpr);
        const ly = cy + Math.sin(a) * (R + 14 * dpr);
        ctx.textAlign = Math.cos(a) > 0.2 ? 'left' : Math.cos(a) < -0.2 ? 'right' : 'center';
        ctx.textBaseline = Math.sin(a) > 0.5 ? 'top' : Math.sin(a) < -0.5 ? 'bottom' : 'middle';
        ctx.fillText(`${SOURCE_LABEL[s.source] || s.source} ${counts[s.source] || 0}`, lx, ly);
        ctx.globalAlpha = 1;
      });

      // 条目光点（半径=时间新旧，越靠中心越新）
      const bySrc = new Map();
      list.forEach((s, i) => bySrc.set(s.source, i));
      const dots = [];
      for (const it of items) {
        const t = Date.parse(it.collected_at || it.published_at);
        if (!t || now - t > SPAN) continue;
        const si = bySrc.has(it.source) ? bySrc.get(it.source) : Math.floor(Math.random() * n);
        const sector = (si / n) * Math.PI * 2 - Math.PI / 2;
        const jitter = ((hash(it.id) % 100) / 100 - 0.5) * ((Math.PI * 2) / n) * 0.72;
        const a = sector + jitter;
        const age = (now - t) / SPAN; // 0=最新 1=6小时前
        const rr = R * 0.06 + age * R * 0.9;
        const x = cx + Math.cos(a) * rr;
        const y = cy + Math.sin(a) * rr;
        const col = SRC_COLOR[it.source] || '#3ef2a5';
        const alpha = 0.28 + (1 - age) * 0.62;
        const rad = (1.6 + (1 - age) * 2.6) * dpr;

        const g = ctx.createRadialGradient(x, y, 0, x, y, rad * 3.2);
        g.addColorStop(0, hexA(col, alpha));
        g.addColorStop(1, hexA(col, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, rad * 3.2, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = hexA(col, Math.min(1, alpha + 0.25));
        ctx.beginPath();
        ctx.arc(x, y, rad * 0.62, 0, Math.PI * 2);
        ctx.fill();

        dots.push({ x: x / dpr, y: y / dpr, item: it, col });
      }
      dotsRef.current = dots;

      // 悬停高亮
      const hi = hoverRef.current;
      if (hi >= 0 && dots[hi]) {
        const d = dots[hi];
        ctx.strokeStyle = d.col;
        ctx.lineWidth = 1.5 * dpr;
        ctx.beginPath();
        ctx.arc(d.x * dpr, d.y * dpr, 8 * dpr, 0, Math.PI * 2);
        ctx.stroke();
      }

      // 扫描线
      angleRef.current += (scanning ? 0.045 : 0.012);
      const sa = angleRef.current - Math.PI / 2;
      const sg = ctx.createConicGradient
        ? (() => {
            const gr = ctx.createConicGradient(sa, cx, cy);
            gr.addColorStop(0, hexA('#3ef2a5', 0.32));
            gr.addColorStop(0.12, hexA('#3ef2a5', 0));
            gr.addColorStop(1, hexA('#3ef2a5', 0));
            return gr;
          })()
        : null;
      if (sg) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, R, 0, Math.PI * 2);
        ctx.clip();
        ctx.fillStyle = sg;
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
      }
      const grad = ctx.createLinearGradient(cx, cy, cx + Math.cos(sa) * R, cy + Math.sin(sa) * R);
      grad.addColorStop(0, hexA('#3ef2a5', 0.15));
      grad.addColorStop(1, hexA('#3ef2a5', 0.85));
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.6 * dpr;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(sa) * R, cy + Math.sin(sa) * R);
      ctx.stroke();

      // 中心
      ctx.fillStyle = '#3ef2a5';
      ctx.shadowColor = '#3ef2a5';
      ctx.shadowBlur = 10 * dpr;
      ctx.beginPath();
      ctx.arc(cx, cy, 2.4 * dpr, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      raf = requestAnimationFrame(draw);
    };
    draw();

    const findDot = (mx, my) => {
      const dots = dotsRef.current;
      let best = -1;
      let bd = 12;
      for (let i = 0; i < dots.length; i++) {
        const d = Math.hypot(dots[i].x - mx, dots[i].y - my);
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      return best;
    };
    const onMove = (e) => {
      const r = cvs.getBoundingClientRect();
      const i = findDot(e.clientX - r.left, e.clientY - r.top);
      hoverRef.current = i;
      if (i >= 0) {
        const d = dotsRef.current[i];
        setTip({ x: d.x, y: d.y, item: d.item, col: d.col });
        cvs.style.cursor = 'pointer';
      } else {
        setTip(null);
        cvs.style.cursor = 'default';
      }
    };
    const onLeave = () => {
      hoverRef.current = -1;
      setTip(null);
    };
    const onClick = (e) => {
      const r = cvs.getBoundingClientRect();
      const i = findDot(e.clientX - r.left, e.clientY - r.top);
      if (i >= 0 && dotsRef.current[i].item.url) window.open(dotsRef.current[i].item.url, '_blank');
    };
    cvs.addEventListener('mousemove', onMove);
    cvs.addEventListener('mouseleave', onLeave);
    cvs.addEventListener('click', onClick);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      cvs.removeEventListener('mousemove', onMove);
      cvs.removeEventListener('mouseleave', onLeave);
      cvs.removeEventListener('click', onClick);
    };
  }, []);

  return (
    <>
      <canvas ref={ref} className="radar" />
      {tip && (
        <div
          className="radar-tip"
          style={{
            left: Math.min(tip.x + 14, 999),
            top: tip.y - 10,
            borderColor: tip.col,
          }}
        >
          <b>{tip.item.title}</b>
          <span>
            {SOURCE_LABEL[tip.item.source] || tip.item.source} · {agoShort(tip.item)}
            {tip.item.url ? ' · 点击查看原文' : ''}
          </span>
        </div>
      )}
    </>
  );
}

function agoShort(it) {
  const t = Date.parse(it.collected_at || it.published_at);
  if (!t) return '未知时间';
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  return `${(m / 60).toFixed(1)} 小时前`;
}

function hash(n) {
  const x = Math.sin(Number(n) * 12.9898) * 43758.5453;
  return Math.abs(Math.floor(x * 1000));
}

function hexA(hex, a) {
  const v = hex.replace('#', '');
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
