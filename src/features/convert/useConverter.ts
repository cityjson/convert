import { useCallback, useEffect, useRef, useState } from "react";
import { convert, inspect, type SourceInfo } from "@/core/convert";
import { FORMAT_IDS, type FormatId } from "@/core/formats";
import type { BrowserEngine } from "@/engine/duckdb";
import {
  collectOutput,
  outputPath,
  prepareInput,
  type Download,
  type InputSelection,
  type PreparedInput,
} from "./io";

export type Phase = "idle" | "loading" | "ready" | "converting" | "done";

export interface ConverterState {
  phase: Phase;
  /** What is happening right now, for the busy indicator. */
  status?: string;
  error?: string;
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
      const input = await prepareInput(engine, selection);
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
      setState({ ...INITIAL, error: message(e) });
    }
  }, []);

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
      setState((s) => ({ ...s, phase: "ready", status: undefined, error: message(e) }));
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

  const reset = useCallback(async () => {
    const { input } = stateRef.current;
    setState(INITIAL);
    if (input) await (await getEngine()).dropFiles(input.registered);
  }, []);

  return { state, load, run, update, reset, formats: FORMAT_IDS };
}
