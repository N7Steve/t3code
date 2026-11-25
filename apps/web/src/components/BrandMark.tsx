import type { SVGProps } from "react";

import { cn } from "~/lib/utils";

/** Two chevrons in the text color around the teal diamond. */
export function BrandGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 156 160" xmlns="http://www.w3.org/2000/svg">
      <path d="M66 22 8 80 66 138 66 122 24 80 66 38Z" fill="currentColor" />
      <path d="M90 22 148 80 90 138 90 122 132 80 90 38Z" fill="currentColor" />
      <path d="M78 54 104 80 78 106 52 80Z" fill="var(--brand-mark-accent)" />
    </svg>
  );
}

/** The glyph with a lowercase name set in both brand faces; size it with a text-* class. */
export function BrandWordmark({
  className,
  mutedClassName,
}: {
  readonly className?: string;
  readonly mutedClassName?: string;
}) {
  return (
    <span
      aria-label="T3 Code"
      className={cn("inline-flex min-w-0 items-center gap-1.5 leading-none", className)}
      role="img"
    >
      <BrandGlyph aria-hidden className="size-[1.15em] shrink-0" />
      <span aria-hidden className="inline-flex items-baseline whitespace-nowrap">
        <span className="font-brand font-semibold">t3</span>
        <span className={cn("font-brand-mono tracking-normal", mutedClassName)}>code</span>
      </span>
    </span>
  );
}
