/**
 * Handwritten signature — "Ryan Hillebäck".
 *
 * Set in a script face rather than drawn as SVG paths: the name carries a
 * diacritic (ä), and hand-plotted letterforms would either drop it or render it
 * badly. The font is linked at runtime (see layout.tsx) with `display=swap` and
 * a cursive fallback stack, so a blocked or slow font request degrades to a
 * system script face instead of failing the build — which is why this does not
 * use `next/font`, whose fetch happens at build time.
 */
export function Signature({ className }: { className?: string }) {
  return (
    <span className={className}>
      <span
        className="signature-name select-none text-[1.6rem] leading-none"
        aria-label="Ryan Hillebäck"
      >
        Ryan Hillebäck
      </span>
      {/* Underline flourish, tapered to read as a pen stroke rather than a rule. */}
      <svg
        viewBox="0 0 200 10"
        className="mt-0.5 block h-2 w-full max-w-[190px] text-current opacity-60"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        aria-hidden="true"
      >
        <path d="M3 6.5C38 2.6 96 1.8 140 4.2C160 5.3 176 6.6 190 8" />
      </svg>
    </span>
  );
}
