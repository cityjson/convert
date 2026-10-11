// The cjconv command, run in-process through main() against the native extension.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createNodeEngine, type NodeEngine } from "../src/engine";
import { main } from "../src/main";

const FIXTURE = path.resolve(import.meta.dirname, "../../../fixtures/delft_subset.city.jsonl");
const OBJECTS = 40;

let dir: string;
let engine: NodeEngine;
const out = (name: string) => path.join(dir, name);

/** Runs cjconv with captured output. */
async function run(...argv: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
  });
  return { code, stdout, stderr };
}

async function count(sql: string): Promise<number> {
  const [row] = await engine.query(sql);
  return Number(Object.values(row!)[0]);
}

async function columns(relation: string): Promise<string[]> {
  return (await engine.query(`DESCRIBE SELECT * FROM ${relation}`)).map((r) =>
    String(r.column_name),
  );
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "cjconv-cli-"));
  engine = await createNodeEngine();
});

afterAll(() => {
  engine?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("cjconv <input> <output>", () => {
  it("takes the output format from the output name", async () => {
    const r = await run(FIXTURE, out("a.fcb"));
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("a.fcb");
    expect(await count(`SELECT count(*) FROM read_flatcitybuf('${out("a.fcb")}')`)).toBe(OBJECTS);
  });

  it("keeps only the chosen LoDs and attributes", async () => {
    const r = await run(FIXTURE, out("b.city.json"), "--lod", "2.2", "--attributes", "status");
    expect(r.code).toBe(0);
    const cols = await columns(`read_cityjson('${out("b.city.json")}')`);
    expect(cols).toContain("geometry_lod2_2");
    expect(cols).not.toContain("geometry_lod1_2");
    expect(cols).toContain("status");
    expect(cols).not.toContain("b3_volume_lod22");
  });

  it("drops every attribute with --no-attributes", async () => {
    const r = await run(FIXTURE, out("c.city.jsonl"), "--no-attributes");
    expect(r.code).toBe(0);
    const cols = await columns(`read_cityjsonseq('${out("c.city.jsonl")}')`);
    expect(cols).not.toContain("status");
    expect(cols).toContain("geometry_lod2_2");
  });

  it("writes a CityParquet package into a directory, creating it, and reads one back", async () => {
    const pkg = out("pkg");
    const w = await run(FIXTURE, pkg, "--to", "cityparquet");
    expect(w.code).toBe(0);
    expect(readdirSync(pkg).sort()).toEqual(["building.parquet", "metadata.json"]);

    const r = await run(pkg, out("from-pkg.city.jsonl"));
    expect(r.code).toBe(0);
    expect(
      await count(`SELECT count(*) FROM read_cityjsonseq('${out("from-pkg.city.jsonl")}')`),
    ).toBe(OBJECTS);
  });

  it("treats an output ending in / as a CityParquet package", async () => {
    const r = await run(FIXTURE, `${out("pkg-slash")}/`);
    expect(r.code).toBe(0);
    expect(existsSync(out("pkg-slash/building.parquet"))).toBe(true);
  });

  it("creates the output's parent directories", async () => {
    const r = await run(FIXTURE, out("nested/deeper/d.fcb"));
    expect(r.code).toBe(0);
    expect(existsSync(out("nested/deeper/d.fcb"))).toBe(true);
  });
});

describe("refusals", () => {
  it("does not overwrite an existing output without --force", async () => {
    writeFileSync(out("exists.fcb"), "keep me");
    const r = await run(FIXTURE, out("exists.fcb"));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/exists.*--force/);
    const forced = await run(FIXTURE, out("exists.fcb"), "--force");
    expect(forced.code).toBe(0);
  });

  it("does not write a package into a non-empty directory without --force", async () => {
    mkdirSync(out("busy"));
    writeFileSync(out("busy/other.txt"), "x");
    const r = await run(FIXTURE, out("busy"), "--to", "cityparquet");
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/not empty.*--force/);
  });

  it("names the LoDs a file has when asked for one it lacks", async () => {
    const r = await run(FIXTURE, out("e.fcb"), "--lod", "3.0");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("3.0");
    expect(r.stderr).toContain("2.2");
  });

  it("names unknown attributes", async () => {
    const r = await run(FIXTURE, out("f.fcb"), "--attributes", "status,nope");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("nope");
  });

  it("reports a missing input", async () => {
    const r = await run(out("missing.city.json"), out("g.fcb"));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/no such file/i);
  });

  it("asks for --to when the output name says nothing", async () => {
    const r = await run(FIXTURE, out("h.dat"));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--to");
  });

  it("rejects an unknown format name", async () => {
    const r = await run(FIXTURE, out("i.x"), "--to", "gml");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("gml");
  });

  it("prints usage and exits 2 without arguments", async () => {
    const r = await run();
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Usage");
  });
});

describe("cjconv info", () => {
  it("summarises a file", async () => {
    const r = await run("info", FIXTURE);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("CityJSONSeq");
    expect(r.stdout).toContain("EPSG:7415");
    expect(r.stdout).toContain("2.2");
    expect(r.stdout).toContain(String(OBJECTS));
  });

  it("prints JSON with --json", async () => {
    const r = await run("info", FIXTURE, "--json");
    expect(r.code).toBe(0);
    const info = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(info.format).toBe("cityjsonseq");
    expect(info.crs).toBe("EPSG:7415");
    expect(info.objects).toBe(OBJECTS);
    expect(info.lods).toEqual(["0.0", "1.2", "1.3", "2.2"]);
    expect((info.attributes as { name: string }[]).map((a) => a.name)).toContain("status");
  });
});

describe("--help and --version", () => {
  it("prints help", async () => {
    const r = await run("--help");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("cjconv <input> <output>");
  });

  it("prints the version", async () => {
    const r = await run("--version");
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
