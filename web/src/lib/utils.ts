import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// The type roles in styles.css are sizes; unregistered, the merge reads them as colours and drops the real colour.
const twMerge = extendTailwindMerge({ extend: { theme: { text: ["display", "title", "body", "ui", "caption"] } } });

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
