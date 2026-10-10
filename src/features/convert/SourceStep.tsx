import { useRef, useState, type DragEvent, type FormEvent } from "react";
import { FileUp, FolderUp, Link2, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FORMATS } from "@/core/formats";
import type { SourceInfo } from "@/core/convert";
import { cn } from "@/lib/utils";
import type { InputSelection, PreparedInput } from "./io";
import { FormatBadge } from "./FormatBadge";

const SAMPLE_URL = "https://cityjson.open3d.city/cityjsonseq/delft.city.jsonl";
// .mtl and images so an OBJ can be chosen together with the files it names.
const ACCEPT = ".json,.jsonl,.fcb,.obj,.mtl,.png,.jpg,.jpeg,.zip,.parquet";

/** Collects files from a drop, walking into dropped folders (for CityParquet packages). */
async function droppedFiles(dt: DataTransfer): Promise<File[]> {
  const entries = [...dt.items]
    .map((item) => item.webkitGetAsEntry?.())
    .filter((e): e is FileSystemEntry => !!e);
  if (entries.length === 0) return [...dt.files];

  const files: File[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject),
      );
      // Keep the folder structure visible to prepareInput, like <input webkitdirectory>.
      Object.defineProperty(file, "webkitRelativePath", { value: `${prefix}${file.name}` });
      files.push(file);
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
        reader.readEntries(resolve, reject),
      );
      if (batch.length === 0) break;
      for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
    }
  };
  for (const entry of entries) await walk(entry, "");
  return files;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

interface Props {
  busy: boolean;
  status?: string;
  input?: PreparedInput;
  info?: SourceInfo;
  onSelect: (selection: InputSelection) => void;
  onClear: () => void;
}

export function SourceStep({ busy, status, input, info, onSelect, onClear }: Props) {
  const [dragging, setDragging] = useState(false);
  const [url, setUrl] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  if (input && info) {
    return (
      <div className="flex items-center gap-3 rounded-md border bg-muted px-4 py-3">
        <FormatBadge format={input.format} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-foreground" title={input.name}>
            {input.name}
          </p>
          <p className="text-xs">
            {FORMATS[input.format].label} · {formatBytes(input.bytes)} · {info.schema.lods.length}{" "}
            LoD{info.schema.lods.length === 1 ? "" : "s"} · {info.schema.attributes.length}{" "}
            attributes
            {info.crs ? ` · ${info.crs.authority}:${info.crs.code}` : " · no CRS"}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClear} aria-label="Choose another file">
          <X /> Change
        </Button>
      </div>
    );
  }

  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (!busy) onSelect({ kind: "files", files: await droppedFiles(e.dataTransfer) });
  };
  const onUrl = (e: FormEvent) => {
    e.preventDefault();
    if (url.trim()) onSelect({ kind: "url", url: url.trim() });
  };

  return (
    <div className="space-y-4">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          "flex flex-col items-center gap-3 rounded-md border-2 border-dashed px-6 py-10 text-center transition-colors",
          dragging ? "border-primary bg-accent" : "border-input",
          busy && "pointer-events-none opacity-70",
        )}
      >
        {busy ? (
          <>
            <Loader2 className="size-8 animate-spin text-primary" aria-hidden />
            <p className="font-medium text-foreground" role="status">
              {status}
            </p>
          </>
        ) : (
          <>
            <FileUp className="size-8 text-primary" aria-hidden />
            <div>
              <p className="font-medium text-foreground">Drop a 3D city model here</p>
              <p className="text-xs">
                CityJSON, CityJSONSeq, FlatCityBuf, OBJ (with its .mtl and textures), or a
                CityParquet package (folder or .zip)
              </p>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              <Button size="sm" onClick={() => fileRef.current?.click()}>
                <FileUp /> Choose file
              </Button>
              <Button size="sm" variant="outline" onClick={() => folderRef.current?.click()}>
                <FolderUp /> Choose package folder
              </Button>
            </div>
          </>
        )}
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPT}
          multiple
          hidden
          onChange={(e) =>
            e.target.files?.length && onSelect({ kind: "files", files: [...e.target.files] })
          }
        />
        <input
          ref={folderRef}
          type="file"
          hidden
          // @ts-expect-error -- non-standard but supported by every current browser
          webkitdirectory=""
          onChange={(e) =>
            e.target.files?.length && onSelect({ kind: "files", files: [...e.target.files] })
          }
        />
      </div>

      <form onSubmit={onUrl} className="flex gap-2">
        <div className="relative flex-1">
          <Link2
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
            aria-hidden
          />
          <Input
            type="url"
            placeholder="https://… .city.json, .city.jsonl or .fcb"
            aria-label="File URL"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={busy}
            className="pl-8"
          />
        </div>
        <Button type="submit" variant="outline" disabled={busy || !url.trim()}>
          Load
        </Button>
      </form>
      <p className="text-xs">
        No file at hand?{" "}
        <button
          type="button"
          className="text-link hover:text-link-hover underline-offset-2 hover:underline"
          disabled={busy}
          onClick={() => onSelect({ kind: "url", url: SAMPLE_URL })}
        >
          Try the 3DBAG Delft sample
        </button>
        .
      </p>
    </div>
  );
}
