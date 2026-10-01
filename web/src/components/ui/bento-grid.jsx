import { motion } from 'motion/react';
import { cn, prefersReducedMotion } from '../../lib/utils.js';

/**
 * Aceternity UI「Bento Grid」移植版：错落有致的玻璃卡片网格。
 * 入场 stagger（对应设计系统的 Stagger List 动效），hover 辉光跟随。
 */
export function BentoGrid({ className, children }) {
  return (
    <div className={cn('grid grid-cols-1 gap-3 bp:auto-rows-[minmax(150px,auto)] bp:grid-cols-4', className)}>
      {children}
    </div>
  );
}

export function BentoCard({ children, className, highlight = '#22D3EE', delay = 0, onClick }) {
  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty('--mx', `${e.clientX - r.left}px`);
    e.currentTarget.style.setProperty('--my', `${e.clientY - r.top}px`);
  };
  return (
    <motion.div
      initial={prefersReducedMotion() ? false : { opacity: 0, y: 16, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.45, delay, ease: [0.22, 1, 0.36, 1] }}
      onMouseMove={onMove}
      onClick={onClick}
      className={cn('bento-card group', className)}
      style={{ '--hl': highlight }}
    >
      {children}
    </motion.div>
  );
}

export function BentoIcon({ children, className }) {
  return (
    <div className={cn('mb-2 flex h-8 w-8 items-center justify-center rounded-lg border border-cyan-400/25 bg-cyan-400/10 text-cyan-300', className)}>
      {children}
    </div>
  );
}
