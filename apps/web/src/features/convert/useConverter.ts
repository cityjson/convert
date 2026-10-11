import { useCallback, useEffect, useRef, useState } from "react";
import { convert, inspect, type SourceInfo } from "@cityjson/cjconv-core";
import { FORMAT_IDS, type FormatId } from "@cityjson/cjconv-core";
import type { ReadOptions } from "@cityjson/cjconv-core";
import type { BrowserEngine } from "@/engine/duckdb";
import {
  collectOutput,
  combineInputs,
  outputPath,
  prepareInputs,
  withInputNames,
  type Download,
  type InputSelection,
  type PreparedInput,
} from "./io";

/**
 * `inspecting`: re-reading the loaded source after a change to it -- a file added or
 * removed, or new read options (OBJ LoD / CRS).
 */
export type Phase = "idle" | "loading" | "inspecting" | "ready" | "converting" | "done";

export interface ConverterState {
  phase: Phase;
  /** What is happening right now, for the busy indicator. */
  status?: string;
  error?: string;
  /** Which step the error belongs to, so it is shown there. */
  errorAt?: "source" | "convert";
  /** What is converted: one input, or several combined (its `parts`). */
  input?: PreparedInput;
  info?: SourceInfo;
  target: FormatId;
  lods: string[];
  attributes: string[];
  result?: Download & { url: string };
}

// One DuckDB worker for the page. A failed worker (e.g. out of memory) is discarded
// and the next call starts a fresh one.
let enginePromise: Promise<BrowserEngine> | undefined;
function getEngine(): Promise<BrowserEngine> {
  // Loaded on first use, so the page renders before duckdb-wasm's JavaScript arrives.
  enginePromise ??= import("@/engine/duckdb")
    .then((m) => m.createBrowserEngine())
    .catch((e: unknown) => {
      enginePromise = undefined;
      throw e;
    });
  return enginePromise;
}
async function discardEngine(): Promise<void> {
  const engine = await enginePromise?.catch(() => undefined);
  enginePromise = undefined;
  await engine?.terminate().catch(() => undefined);
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const looksFatal = (e: unknown) => /memory|out of bounds|unreachable|worker/i.test(message(e));

/** The output format offered first: anything but the input's own format. */
function defaultTarget(source: FormatId): FormatId {
  return source === "cityjsonseq" ? "cityjson" : "cityjsonseq";
}

/** The inputs a source is made of: its parts when combined, else itself. */
const partsOf = (input: PreparedInput) => input.parts ?? [input];

const INITIAL: ConverterState = { phase: "idle", target: "cityjsonseq", lods: [], attributes: [] };

export function useConverter() {
  const [state, setState] = useState<ConverterState>(INITIAL);
  const stateRef = useRef(state);
  stateRef.current = state;

  // Revoke the previous download URL when it is replaced or the page unmounts.
  const resultUrl = state.result?.url;
  useEffect(
    () => () => {
      if (resultUrl) URL.revokeObjectURL(resultUrl);
    },
    [resultUrl],
  );

  const load = useCallback(async (selection: InputSelection) => {
    const previous = stateRef.current.input;
    setState({ ...INITIAL, phase: "loading", status: "Starting DuckDB…" });
    try {
      const engine = await getEngine();
      if (previous) await engine.dropFiles(previous.registered);
      setState((s) => ({
        ...s,
        status: selection.kind === "url" ? "Downloading…" : "Reading file…",
      }));
      const input = combineInputs(await prepareInputs(engine, selection));
      setState((s) => ({ ...s, status: "Inspecting…" }));
      const info = await inspect(engine, input.source);
      setState({
        phase: "ready",
        input,
        info,
        target: defaultTarget(input.format),
        lods: info.schema.lods,
        attributes: info.schema.attributes.map((a) => a.name),
      });
    } catch (e) {
      if (looksFatal(e)) await discardEngine();
      setState({ ...INITIAL, error: message(e), errorAt: "source" });
    }
  }, []);

  /** Re-inspects a changed set of inputs; `added` is dropped again if they don't combine. */
  const resource = useCallback(
    async (parts: PreparedInput[], added: PreparedInput[], status: string) => {
      setState((s) => ({ ...s, phase: "inspecting", status, error: undefined, result: undefined }));
      const engine = await getEngine();
      let input: PreparedInput | undefined;
      try {
        input = combineInputs(parts);
        const info = await inspect(engine, input.source);
        setState((s) => ({
          ...s,
          phase: "ready",
          status: undefined,
          input,
          info,
          lods: info.schema.lods,
          attributes: info.schema.attributes.map((a) => a.name),
        }));
      } catch (e) {
        await engine.dropFiles(added.flatMap((i) => i.registered));
        setState((s) => ({
          ...s,
          phase: "ready",
          status: undefined,
          error: withInputNames(message(e), input),
          errorAt: "source",
        }));
      }
    },
    [],
  );

  /**
   * Adds files or a URL to what is loaded: from then on they are combined into one
   * output. Refused (and not added) when they cannot be combined with what is there.
   */
  const add = useCallback(
    async (selection: InputSelection) => {
      const { input } = stateRef.current;
      if (!input) return load(selection);
      setState((s) => ({
        ...s,
        phase: "inspecting",
        status: selection.kind === "url" ? "Downloading…" : "Reading file…",
        error: undefined,
        result: undefined,
      }));
      let added: PreparedInput[];
      try {
        added = await prepareInputs(await getEngine(), selection);
      } catch (e) {
        setState((s) => ({
          ...s,
          phase: "ready",
          status: undefined,
          error: message(e),
          errorAt: "source",
        }));
        return;
      }
      await resource([...partsOf(input), ...added], added, "Inspecting…");
    },
    [load, resource],
  );

  /** Removes one of several combined inputs. */
  const remove = useCallback(
    async (index: number) => {
      const { input } = stateRef.current;
      if (!input) return;
      const parts = partsOf(input);
      const gone = parts[index];
      if (!gone) return;
      const rest = parts.filter((_, i) => i !== index);
      await (await getEngine()).dropFiles(gone.registered);
      if (rest.length === 0) {
        setState(INITIAL);
        return;
      }
      await resource(rest, [], "Inspecting…");
    },
    [resource],
  );

  const run = useCallback(async () => {
    const { input, info, target, lods, attributes } = stateRef.current;
    if (!input || !info) return;
    setState((s) => ({
      ...s,
      phase: "converting",
      status: "Converting…",
      error: undefined,
      result: undefined,
    }));
    try {
      const engine = await getEngine();
      const files = await convert(engine, {
        info,
        target,
        selection: { lods, attributes },
        output: outputPath(input, target),
      });
      setState((s) => ({ ...s, status: "Preparing download…" }));
      const download = await collectOutput(engine, files, input, target);
      await engine.dropFiles(files);
      setState((s) => ({
        ...s,
        phase: "done",
        status: undefined,
        result: { ...download, url: URL.createObjectURL(download.blob) },
      }));
    } catch (e) {
      if (looksFatal(e)) {
        await discardEngine();
        setState({
          ...INITIAL,
          error: `${message(e)}. DuckDB was restarted; load the file again.`,
        });
        return;
      }
      setState((s) => ({
        ...s,
        phase: "ready",
        status: undefined,
        error: withInputNames(message(e), input),
        errorAt: "convert",
      }));
    }
  }, []);

  const update = useCallback(
    (patch: Partial<Pick<ConverterState, "target" | "lods" | "attributes">>) =>
      setState((s) => ({
        ...s,
        ...patch,
        phase: s.phase === "done" ? "ready" : s.phase,
        result: undefined,
        error: undefined,
      })),
    [],
  );

  /** Re-reads the loaded file with new read options: the LoD and CRS an OBJ lacks. */
  const setSourceOptions = useCallback(async (options: ReadOptions) => {
    const { input } = stateRef.current;
    if (!input || input.source.kind !== "file") return;
    const source = { ...input.source, options };
    setState((s) => ({
      ...s,
      phase: "inspecting",
      status: "Inspecting…",
      error: undefined,
      result: undefined,
    }));
    try {
      const info = await inspect(await getEngine(), source);
      setState((s) => ({
        ...s,
        phase: "ready",
        status: undefined,
        input: { ...input, source },
        info,
        lods: info.schema.lods,
        attributes: info.schema.attributes.map((a) => a.name),
      }));
    } catch (e) {
      setState((s) => ({
        ...s,
        phase: "ready",
        status: undefined,
        error: message(e),
        errorAt: "source",
      }));
    }
  }, []);

  const reset = useCallback(async () => {
    const { input } = stateRef.current;
    setState(INITIAL);
    if (input) await (await getEngine()).dropFiles(input.registered);
  }, []);

  return { state, load, add, remove, run, update, setSourceOptions, reset, formats: FORMAT_IDS };
}
