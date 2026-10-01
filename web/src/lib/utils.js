import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Aceternity/shadcn 标准 cn() 工具 */
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

export const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
