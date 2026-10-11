import { useState, type FormEvent } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import type { SourceInfo } from "@cityjson/cjconv-core";
import { FORMATS, FORMAT_IDS, type FormatId } from "@cityjson/cjconv-core";
import type { ReadOptions } from "@cityjson/cjconv-core";
import { cn } from "@/lib/utils";
import { FormatBadge } from "./FormatBadge";

interface Props {
  info: SourceInfo;
  source: FormatId;
  target: FormatId;
  lods: string[];
  attributes: string[];
  disabled: boolean;
  onChange: (patch: { target?: FormatId; lods?: string[]; attributes?: string[] }) => void;
  /** Re-reads the source with new read options (OBJ only). */
  onSourceOptions: (options: ReadOptions) => void;
}

function toggle(list: string[], value: string, on: boolean, order: string[]): string[] {
  const set = new Set(list);
  if (on) set.add(value);
  else set.delete(value);
  return order.filter((v) => set.has(v));
}

function Group({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <legend className="text-[11px] font-medium tracking-[0.1em] text-foreground uppercase">
          {title}
        </legend>
        {aside}
      </div>
      {children}
    </fieldset>
  );
}

const LOD_PATTERN = /^\d(\.\d)?$/;

/** The LoD and CRS an OBJ does not state, for the user to supply. */
function ObjSourceOptions({
  options,
  disabled,
  onApply,
}: {
  options: ReadOptions;
  disabled: boolean;
  onApply: (options: ReadOptions) => void;
}) {
  const [lod, setLod] = useState(options.lod ?? "2.2");
  const [epsg, setEpsg] = useState(options.crs?.code ?? "");
  const valid = LOD_PATTERN.test(lod.trim()) && /^\d*$/.test(epsg.trim());
  const changed = lod.trim() !== (options.lod ?? "") || epsg.trim() !== (options.crs?.code ?? "");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    const code = epsg.trim();
    onApply({ lod: lod.trim(), ...(code ? { crs: { authority: "EPSG", code } } : {}) });
  };
  return (
    <form onSubmit={submit} className="space-y-2">
      <p className="text-xs">
        OBJ states no level of detail or coordinate reference system: say what its geometry is.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="obj-lod" className="text-xs">
            Read as LoD
          </Label>
          <Input
            id="obj-lod"
            value={lod}
            onChange={(e) => setLod(e.target.value)}
            disabled={disabled}
            aria-invalid={!LOD_PATTERN.test(lod.trim())}
            className="w-24 font-mono"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="obj-crs" className="text-xs">
            CRS (EPSG code, optional)
          </Label>
          <Input
            id="obj-crs"
            inputMode="numeric"
            placeholder="e.g. 7415"
            value={epsg}
            onChange={(e) => setEpsg(e.target.value)}
            disabled={disabled}
            aria-invalid={!/^\d*$/.test(epsg.trim())}
            className="w-36 font-mono"
          />
        </div>
        <Button type="submit" variant="outline" size="sm" disabled={disabled || !valid || !changed}>
          Apply
        </Button>
      </div>
    </form>
  );
}

export function OptionsStep({
  info,
  source,
  target,
  lods,
  attributes,
  disabled,
  onChange,
  onSourceOptions,
}: Props) {
  const allLods = info.schema.lods;
  const allAttributes = info.schema.attributes.map((a) => a.name);
  const sourceOptions = info.source.kind === "file" ? info.source.options : undefined;

  return (
    <div className="space-y-6">
      {source === "obj" && sourceOptions && (
        <Group title="OBJ source">
          <ObjSourceOptions
            // Remount after a re-read so the fields show what was applied.
            key={`${sourceOptions.lod}|${sourceOptions.crs?.code ?? ""}`}
            options={sourceOptions}
            disabled={disabled}
            onApply={onSourceOptions}
          />
        </Group>
      )}

      <Group title="Output format">
        <div
          role="radiogroup"
          aria-label="Output format"
          className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-5"
        >
          {FORMAT_IDS.map((id) => {
            const selected = id === target;
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={disabled}
                onClick={() => onChange({ target: id })}
                className={cn(
                  "flex flex-col items-start gap-2 rounded-md border bg-card p-3 text-left transition-colors",
                  "hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                  "disabled:pointer-events-none disabled:opacity-50",
                  selected ? "border-primary shadow-card ring-1 ring-primary" : "border-input",
                )}
              >
                <FormatBadge format={id} />
                <span>
                  <span className="block font-medium text-foreground">{FORMATS[id].label}</span>
                  <span className="block font-mono text-[11px]">
                    {id === "cityparquet"
                      ? "package · .zip"
                      : id === "obj"
                        ? ".obj + .mtl · .zip"
                        : FORMATS[id].extension}
                    {id === source ? " · same as input" : ""}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </Group>

      <Group title="Levels of detail">
        {target === "obj" && allLods.length > 1 && (
          <p className="text-xs">
            OBJ holds one level of detail: the highest one selected is written.
          </p>
        )}
        {allLods.length === 0 ? (
          <p className="text-xs">This dataset has no geometry columns.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {allLods.map((lod) => {
              const id = `lod-${lod}`;
              return (
                <Label
                  key={lod}
                  htmlFor={id}
                  className="flex cursor-pointer items-center gap-2 rounded-md border border-input px-3 py-2 font-normal has-[[data-state=checked]]:border-primary"
                >
                  <Checkbox
                    id={id}
                    checked={lods.includes(lod)}
                    disabled={disabled}
                    onCheckedChange={(on) =>
                      onChange({ lods: toggle(lods, lod, on === true, allLods) })
                    }
                  />
                  <span className="font-mono text-foreground">LoD {lod}</span>
                </Label>
              );
            })}
          </div>
        )}
      </Group>

      <Group
        title={`Attributes · ${attributes.length} of ${allAttributes.length}`}
        aside={
          allAttributes.length > 0 && (
            <span className="flex gap-1">
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled}
                onClick={() => onChange({ attributes: allAttributes })}
              >
                All
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled}
                onClick={() => onChange({ attributes: [] })}
              >
                None
              </Button>
            </span>
          )
        }
      >
        {allAttributes.length === 0 ? (
          <p className="text-xs">This dataset has no attributes.</p>
        ) : (
          <div className="grid max-h-64 grid-cols-1 gap-x-4 gap-y-1 overflow-y-auto rounded-md border p-3 sm:grid-cols-2">
            {info.schema.attributes.map((attr) => {
              const id = `attr-${attr.name}`;
              return (
                <div key={attr.name} className="flex min-w-0 items-center gap-2 py-0.5">
                  <Checkbox
                    id={id}
                    checked={attributes.includes(attr.name)}
                    disabled={disabled}
                    onCheckedChange={(on) =>
                      onChange({
                        attributes: toggle(attributes, attr.name, on === true, allAttributes),
                      })
                    }
                  />
                  <Label
                    htmlFor={id}
                    className="min-w-0 truncate font-mono text-xs font-normal"
                    title={`${attr.name} (${attr.type})`}
                  >
                    {attr.name}
                  </Label>
                </div>
              );
            })}
          </div>
        )}
      </Group>
    </div>
  );
}
