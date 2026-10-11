import { useRef, useState, type DragEvent, type FormEvent } from "react";
import { FilePlus, FileUp, FolderUp, Link2, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FORMATS } from "@cityjson/cjconv-core";
import type { SourceInfo } from "@cityjson/cjconv-core";
import { cn } from "@/lib/utils";
import { canCombine, type InputSelection, type PreparedInput } from "./io";
import { FormatBadge } from "./FormatBadge";

const SAMPLE_URL = "https://cityjson.open3d.city/cityjsonseq/delft.city.jsonl";
// .mtl and images so an OBJ can be chosen together with the files it names.
const ACCEPT = ".json,.jsonl,.fcb,.obj,.mtl,.png,.jpg,.jpeg,.zip,.parquet";
// What can join a combination: more tiles of the same dataset.
const ACCEPT_COMBINABLE = ".json,.jsonl,.fcb";

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
  /** Adds files or a URL to what is loaded; they are combined into one output. */
  onAdd: (selection: InputSelection) => void;
  /** Removes one of the combined inputs. */
  onRemove: (index: number) => void;
  onClear: () => void;
}

/** What is loaded: one input, or several combined, with ways to add and remove files. */
function LoadedSource({
  busy,
  status,
  input,
  info,
  onAdd,
  onRemove,
  onClear,
}: Omit<Props, "onSelect" | "input" | "info"> & { input: PreparedInput; info: SourceInfo }) {
  const [dragging, setDragging] = useState(false);
  const [url, setUrl] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const parts = input.parts ?? [input];
  const combinable = parts.every(canCombine);
  const lods = info.schema.lods.length;

  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (!busy && combinable) onAdd({ kind: "files", files: await droppedFiles(e.dataTransfer) });
  };
  const onUrl = (e: FormEvent) => {
    e.preventDefault();
    if (url.trim()) {
      onAdd({ kind: "url", url: url.trim() });
      setUrl("");
    }
  };

  return (
    <div
      onDragOver={(e) => {
        if (!combinable) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={cn(
        "rounded-md border bg-muted transition-colors",
        dragging && "border-primary bg-accent",
      )}
    >
      <ul aria-label="Input files" className="divide-y">
        {parts.map((part, i) => (
          <li key={part.registered[0] ?? part.name} className="flex items-center gap-3 px-4 py-2">
            <FormatBadge format={part.format} />
            <span className="min-w-0 flex-1 truncate font-medium text-foreground" title={part.name}>
              {part.name}
            </span>
            <span className="shrink-0 text-xs">{formatBytes(part.bytes)}</span>
            {parts.length > 1 && (
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={busy}
                onClick={() => onRemove(i)}
                aria-label={`Remove ${part.name}`}
              >
                <X />
              </Button>
            )}
          </li>
        ))}
      </ul>

      <div className="flex items-center gap-3 border-t px-4 py-2">
        <p className="min-w-0 flex-1 text-xs">
          {parts.length > 1 && (
            <span className="font-medium text-foreground">{parts.length} files combined · </span>
          )}
          {FORMATS[input.format].label} · {formatBytes(input.bytes)}
          {info.objects !== undefined && ` · ${info.objects} objects`} · {lods} LoD
          {lods === 1 ? "" : "s"} · {info.schema.attributes.length} attributes
          {info.crs ? ` · ${info.crs.authority}:${info.crs.code}` : " · no CRS"}
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClear}
          disabled={busy}
          aria-label="Clear all files"
        >
          <X /> Clear
        </Button>
      </div>

      {combinable && (
        <div className="space-y-2 border-t px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              <FilePlus /> Add files
            </Button>
            <form onSubmit={onUrl} className="flex min-w-60 flex-1 gap-2">
              <Input
                type="url"
                placeholder="…or add a file by URL"
                aria-label="Add a file by URL"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={busy}
                className="h-8 bg-background"
              />
              <Button type="submit" size="sm" variant="outline" disabled={busy || !url.trim()}>
                Add
              </Button>
            </form>
          </div>
          {busy ? (
            <p className="flex items-center gap-2 text-xs" role="status">
              <Loader2 className="size-3.5 animate-spin text-primary" aria-hidden /> {status}
            </p>
          ) : (
            <p className="text-xs">
              More files of the same dataset (or drop them here) are combined into one output.
            </p>
          )}
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPT_COMBINABLE}
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files?.length) onAdd({ kind: "files", files: [...e.target.files] });
              e.target.value = "";
            }}
          />
        </div>
      )}
    </div>
  );
}

export function SourceStep({
  busy,
  status,
  input,
  info,
  onSelect,
  onAdd,
  onRemove,
  onClear,
}: Props) {
  const [dragging, setDragging] = useState(false);
  const [url, setUrl] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  if (input && info) {
    return (
      <LoadedSource
        busy={busy}
        status={status}
        input={input}
        info={info}
        onAdd={onAdd}
        onRemove={onRemove}
        onClear={onClear}
      />
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
                CityParquet package (folder or .zip). Several files of one dataset are combined.
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
