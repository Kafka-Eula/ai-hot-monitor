import { cn } from '../../lib/utils.js';

/**
 * Aceternity UI「Spotlight」移植版：椭圆光斑缓慢漂移，聚焦 Hero 内容。
 * 官方实现为 SVG + CSS 动画，此处保留同名 keyframes 与语义。
 */
export function Spotlight({ className, fill = '#22D3EE' }) {
  return (
    <svg
      className={cn(
        'pointer-events-none absolute z-0 [mask-image:radial-gradient(68%_64%_at_50%_50%,white,transparent)] md:opacity-70',
        'animate-spotlight',
        className
      )}
      viewBox="0 0 3787 2842"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <ellipse
        cx="1914.71"
        cy="1301.55"
        id="spotlight-ellipse"
        rx="916.28"
        ry="1215.34"
        fill="url(#spotlight-gradient)"
        fillOpacity="0.21"
      />
      <defs>
        <radialGradient
          id="spotlight-gradient"
          cx="0"
          cy="0"
          r="1"
          gradientUnits="userSpaceOnUse"
          gradientTransform="translate(1914.71 1301.55) rotate(90) scale(1215.34 916.28)"
        >
          <stop offset="0" stopColor={fill} stopOpacity="0.95" />
          <stop offset="0.5" stopColor={fill} stopOpacity="0.35" />
          <stop offset="1" stopColor="#8B5CF6" stopOpacity="0" />
        </radialGradient>
      </defs>
    </svg>
  );
}
