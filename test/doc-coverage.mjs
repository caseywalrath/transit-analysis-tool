// Lists every public name the app defines (App.* assignments, window.* engine namespaces and
// registered module ids) and reports the ones not mentioned in CLAUDE.md or docs/reference/.
// docs/comment-cleanup-plan.md Phases 1 and 4.
// usage: node test/doc-coverage.mjs [--list]
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
function walk(d, ext, out = []) {
  if (!existsSync(d)) return out;
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p, ext, out); else if (p.endsWith(ext)) out.push(p);
  }
  return out;
}
const docs = [readFileSync(join(ROOT, "CLAUDE.md"), "utf8"), ...walk(join(ROOT, "docs/reference"), ".md").map((p) => readFileSync(p, "utf8"))].join("\n");

const names = new Map(); // name -> first file
const add = (n, f) => { if (!names.has(n)) names.set(n, f); };
for (const p of walk(join(ROOT, "js"), ".js")) {
  if (/mitigation-needs/.test(p)) continue; // dormant module
  const src = readFileSync(p, "utf8"), rel = p.slice(ROOT.length);
  for (const m of src.matchAll(/\bApp\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)) add(m[1], rel);
  for (const m of src.matchAll(/\bwindow\.([A-Z][\w$]*)\s*=(?!=)/g)) add(m[1], rel);
  for (const m of src.matchAll(/registerModule\(\s*\{\s*id:\s*"([^"]+)"/g)) add(m[1], rel);
}
const missing = [...names].filter(([n]) => !docs.includes(n));
if (process.argv.includes("--list")) for (const [n, f] of names) console.log(n, f);
for (const [n, f] of missing) console.log("undocumented  " + n.padEnd(34) + f);
console.log(`${names.size - missing.length}/${names.size} public names documented (${missing.length} missing)`);
