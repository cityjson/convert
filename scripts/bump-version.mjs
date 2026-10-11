#!/usr/bin/env node
// Bumps the published packages to one new version, together: @cityjson/cjconv and
// @cityjson/cjconv-core always share a version, since cjconv pins the core it was
// tested with. Prints the new version.
//
//   node scripts/bump-version.mjs patch|minor|major
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = ["packages/core/package.json", "packages/cjconv/package.json"];

export function bump(version, kind) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) throw new Error(`not a plain x.y.z version: ${version}`);
  const [major, minor, patch] = m.slice(1).map(Number);
  if (kind === "major") return `${major + 1}.0.0`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  if (kind === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new Error(`bump must be patch, minor or major, not ${kind}`);
}

const kind = process.argv[2];
const manifests = PACKAGES.map((p) => {
  const file = path.join(ROOT, p);
  return { file, json: JSON.parse(readFileSync(file, "utf8")) };
});
const versions = new Set(manifests.map((m) => m.json.version));
if (versions.size !== 1) {
  throw new Error(`the packages disagree on their version: ${[...versions].join(", ")}`);
}
const next = bump([...versions][0], kind);
for (const m of manifests) {
  m.json.version = next;
  writeFileSync(m.file, `${JSON.stringify(m.json, null, 2)}\n`);
}
console.log(next);
