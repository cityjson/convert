import type { FormatId } from "@/core/formats";
import { cn } from "@/lib/utils";

// Each format wears one ink of the CityJSON mark. Amber and green are too light for
// white text, so they carry the heading grey instead.
const INK: Record<FormatId, string> = {
  cityjson: "bg-house text-white",
  cityjsonseq: "bg-block text-foreground",
  flatcitybuf: "bg-tree text-foreground",
  cityparquet: "bg-ink text-white",
};

const ABBR: Record<FormatId, string> = {
  cityjson: "CJ",
  cityjsonseq: "CJS",
  flatcitybuf: "FCB",
  cityparquet: "CPQ",
};

export function FormatBadge({ format, className }: { format: FormatId; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex h-7 min-w-9 shrink-0 items-center justify-center rounded-sm px-1.5 font-mono text-[11px] font-semibold",
        INK[format],
        className,
      )}
    >
      {ABBR[format]}
    </span>
  );
}
