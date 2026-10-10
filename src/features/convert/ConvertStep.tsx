import { Download, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FORMATS, type FormatId } from "@/core/formats";
import type { ConverterState } from "./useConverter";

interface Props {
  state: ConverterState;
  onConvert: () => void;
}

function formatBytes(n: number): string {
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

export function ConvertStep({ state, onConvert }: Props) {
  const { phase, target, lods, info, result, status } = state;
  const converting = phase === "converting";
  const noGeometry = (info?.schema.lods.length ?? 0) > 0 && lods.length === 0;
  const label = FORMATS[target as FormatId].label;

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      {result ? (
        <>
          <Button asChild size="lg">
            <a href={result.url} download={result.fileName}>
              <Download /> Download {result.fileName}
            </a>
          </Button>
          <span className="text-xs">{formatBytes(result.blob.size)}</span>
          <Button variant="ghost" size="sm" className="sm:ml-auto" onClick={onConvert}>
            <RefreshCw /> Convert again
          </Button>
        </>
      ) : (
        <>
          <Button
            size="lg"
            onClick={onConvert}
            disabled={converting || phase === "inspecting" || noGeometry}
          >
            {converting ? <Loader2 className="animate-spin" /> : null}
            {converting ? status : `Convert to ${label}`}
          </Button>
          {noGeometry && <span className="text-xs">Select at least one level of detail.</span>}
        </>
      )}
    </div>
  );
}
