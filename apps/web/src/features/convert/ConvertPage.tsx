import { AlertCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ConvertStep } from "./ConvertStep";
import { OptionsStep } from "./OptionsStep";
import { SourceStep } from "./SourceStep";
import { useConverter } from "./useConverter";

function Step({
  n,
  title,
  children,
  muted,
}: {
  n: number;
  title: string;
  children?: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <section aria-labelledby={`step-${n}`} className={muted ? "opacity-50" : undefined}>
      <h2 id={`step-${n}`} className="mb-3 flex items-center gap-2 text-base">
        <span className="inline-flex size-6 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
          {n}
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function ErrorAlert({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <Alert variant="destructive" className="mt-4">
      <AlertCircle />
      <AlertTitle>Something went wrong</AlertTitle>
      <AlertDescription className="break-words">{message}</AlertDescription>
    </Alert>
  );
}

export function ConvertPage() {
  const { state, load, add, remove, run, update, setSourceOptions, reset } = useConverter();
  const { phase, input, info } = state;
  const ready = !!input && !!info;
  // Loading the first input shows in the drop zone; adding to it, in the source card.
  const busy = ready ? phase === "inspecting" : phase === "loading";
  const sourceError = !ready || state.errorAt === "source" ? state.error : undefined;
  const convertError = ready && state.errorAt !== "source" ? state.error : undefined;

  return (
    <div className="space-y-8 rounded-md border bg-card p-5 shadow-card sm:p-8">
      <Step n={1} title="Source">
        <SourceStep
          busy={busy}
          status={state.status}
          input={input}
          info={info}
          onSelect={load}
          onAdd={add}
          onRemove={remove}
          onClear={reset}
        />
        {/* Loading and adding errors belong to the source; conversion errors to step 3. */}
        <ErrorAlert message={sourceError} />
      </Step>

      <Step n={2} title="Options" muted={!ready}>
        {ready && (
          <OptionsStep
            info={info}
            source={input.format}
            target={state.target}
            lods={state.lods}
            attributes={state.attributes}
            disabled={phase === "converting" || phase === "inspecting"}
            onChange={update}
            onSourceOptions={setSourceOptions}
          />
        )}
      </Step>

      <Step n={3} title="Convert" muted={!ready}>
        {ready && <ConvertStep state={state} onConvert={run} />}
        <ErrorAlert message={convertError} />
      </Step>
    </div>
  );
}
