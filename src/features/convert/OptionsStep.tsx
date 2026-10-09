import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import type { SourceInfo } from "@/core/convert";
import { FORMATS, FORMAT_IDS, type FormatId } from "@/core/formats";
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

export function OptionsStep({ info, source, target, lods, attributes, disabled, onChange }: Props) {
  const allLods = info.schema.lods;
  const allAttributes = info.schema.attributes.map((a) => a.name);

  return (
    <div className="space-y-6">
      <Group title="Output format">
        <div
          role="radiogroup"
          aria-label="Output format"
          className="grid grid-cols-2 gap-2 sm:grid-cols-4"
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
                    {id === "cityparquet" ? "package · .zip" : FORMATS[id].extension}
                    {id === source ? " · same as input" : ""}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </Group>

      <Group title="Levels of detail">
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
