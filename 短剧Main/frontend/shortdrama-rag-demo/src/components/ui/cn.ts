import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** className 合并（clsx + tailwind-merge 去冲突），shadcn 惯例。 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
