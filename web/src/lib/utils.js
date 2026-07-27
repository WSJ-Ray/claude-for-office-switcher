import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** 合并条件类名并解决 Tailwind 类名冲突。 */
export const cn = (...args) => twMerge(clsx(args))
