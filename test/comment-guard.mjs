// Proves an edit changed only comments and whitespace (docs/comment-cleanup-plan.md Phase 0).
// Compares every changed .js/.mjs/.css/.html file between a git base revision and the
// working tree: JS by acorn token stream (comments dropped), CSS/HTML with comments
// stripped and whitespace collapsed. Markdown and other files are ignored.
//
// usage: NODE_PATH=/opt/node-tools/node_modules node test/comment-guard.mjs [base-rev]
//        (base-rev defaults to HEAD, i.e. uncommitted work; use HEAD~1 to check the last commit)
//        node test/comment-guard.mjs --self-test
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let acorn;
try { acorn = require("acorn"); }
catch { console.error("acorn not found — run with NODE_PATH=/opt/node-tools/node_modules"); process.exit(2); }

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

// JS: token stream with comments dropped. Each token is serialized as type + raw source text,
// so string, regex and template-literal contents all count as code.
function jsTokens(src, sourceType) {
  const out = [];
  for (const t of acorn.tokenizer(src, { ecmaVersion: "latest", sourceType, allowHashBang: true })) {
    out.push(t.type.label + "\u0001" + src.slice(t.start, t.end));
  }
  return out;
}
function normJs(src, file) {
  // .mjs is always a module; try script first for .js (the app's IIFE files), then module.
  const order = file.endsWith(".mjs") ? ["module"] : ["script", "module"];
  let err;
  for (const st of order) {
    try { return jsTokens(src, st).join("\u0002"); } catch (e) { err = e; }
  }
  throw new Error("tokenize failed: " + err.message);
}
// CSS: string-aware comment strip (a "/*" inside a quoted string is kept), then collapse whitespace.
function normCss(src) {
  let out = "", i = 0, q = null;
  while (i < src.length) {
    const c = src[i];
    if (q) { out += c; if (c === "\\") { out += src[i + 1] || ""; i += 2; continue; } if (c === q) q = null; i++; continue; }
    if (c === '"' || c === "'") { q = c; out += c; i++; continue; }
    if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? src.length : e + 2; out += " "; continue; }
    out += c; i++;
  }
  return out.replace(/\s+/g, " ").replace(/\s*([{};,>])\s*/g, "$1").trim();
}
// HTML: strip <!-- --> comments, collapse whitespace, ignore whitespace between tags.
function normHtml(src) {
  return src.replace(/<!--[\s\S]*?-->/g, " ").replace(/\s+/g, " ").replace(/>\s+</g, "><").trim();
}
function normalize(file, src) {
  if (/\.(m?js)$/.test(file)) return normJs(src, file);
  if (file.endsWith(".css")) return normCss(src);
  if (file.endsWith(".html")) return normHtml(src);
  return null;
}

function selfTest() {
  const cases = [
    ["comment-only edit passes", "a.js", "var x = 1; // one\n", "var x = 1; /* two */\n\n", true],
    ["code char change fails", "a.js", "var x = 1;", "var x = 2;", false],
    ["string containing // fails", "a.js", 'var u = "http://a";', 'var u = "http://b";', false],
    ["regex literal change fails", "a.js", "var r = /ab+/g;", "var r = /ab*/g;", false],
    ["template literal change fails", "a.js", "var t = `a ${b} c`;", "var t = `a ${b} d`;", false],
    ["css comment-only passes", "a.css", "a { color: red; } /* x */", "/* y */\na{color: red;}", true],
    ["css value change fails", "a.css", "a { color: red; }", "a { color: blue; }", false],
    ["css /* in string kept", "a.css", 'a{content:"/*x*/"}', 'a{content:"/*y*/"}', false],
    ["html comment-only passes", "a.html", "<p>hi</p><!-- c -->", "<!-- d -->\n<p>hi</p>", true],
    ["html text change fails", "a.html", "<p>hi</p>", "<p>ho</p>", false],
  ];
  let ok = 0;
  for (const [name, f, a, b, expect] of cases) {
    const same = normalize(f, a) === normalize(f, b);
    const pass = same === expect;
    if (pass) ok++;
    console.log((pass ? "ok   " : "FAIL ") + name);
  }
  console.log(ok === cases.length ? `PASS — ${ok}/${cases.length} self-test cases` : `FAIL — ${ok}/${cases.length}`);
  process.exit(ok === cases.length ? 0 : 1);
}

if (process.argv[2] === "--self-test") selfTest();

const base = process.argv[2] || "HEAD";
const changed = execFileSync("git", ["diff", "--name-only", base, "--", "."], { cwd: ROOT, encoding: "utf8" })
  .split("\n").filter(Boolean).filter((f) => /\.(m?js|css|html)$/.test(f));

let pass = 0, fail = 0;
for (const f of changed) {
  const abs = ROOT + "/" + f;
  let before = null;
  try { before = execFileSync("git", ["show", base + ":" + f], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 }); } catch {}
  const after = existsSync(abs) ? readFileSync(abs, "utf8") : null;
  let verdict;
  if (before === null || after === null) verdict = before === null ? "ADDED (code file — not allowed)" : "DELETED (not allowed)";
  else {
    try { verdict = normalize(f, before) === normalize(f, after) ? "unchanged" : "CODE CHANGED"; }
    catch (e) { verdict = "ERROR " + e.message; }
  }
  if (verdict === "unchanged") pass++; else fail++;
  console.log((verdict === "unchanged" ? "ok   " : "FAIL ") + f + "  " + verdict);
}
const n = pass + fail;
console.log(fail ? `FAIL — ${fail}/${n} files changed code (base ${base})` : `PASS — ${n}/${n} files code-identical (base ${base})`);
process.exit(fail ? 1 : 0);
