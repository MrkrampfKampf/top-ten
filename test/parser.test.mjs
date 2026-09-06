/**
 * Tests for the JSON parsing in index.html.
 *
 * No dependencies and no build step: this reads index.html, lifts the block
 * between the parser:start / parser:end markers, and runs it. That way the
 * app stays a single self-contained file and the parser is still tested.
 *
 *   node test/parser.test.mjs
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "index.html"), "utf8");

const START = "// --- parser:start";
const END = "// --- parser:end";
const from = html.indexOf(START);
const to = html.indexOf(END);
assert.ok(from !== -1 && to > from, "parser markers not found in index.html");

const source = html.slice(from, to);
const parseResults = new Function(
  '"use strict";' + source + "\nreturn parseResults;"
)();

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failures.push({ name, err });
  }
}

const rec = (t, extra = {}) => ({ t, y: "2019", k: "Film", w: "Netflix", s: "IMDb 8.0/10", p: "Good.", ...extra });
const ten = Array.from({ length: 10 }, (_, i) => rec("Title " + (i + 1)));

// --- the happy path --------------------------------------------------------

test("parses a clean array of ten", () => {
  const out = parseResults(JSON.stringify(ten));
  assert.equal(out.length, 10);
  assert.equal(out[0].t, "Title 1");
  assert.equal(out[9].s, "IMDb 8.0/10");
});

test("keeps all six fields", () => {
  const out = parseResults(JSON.stringify([rec("Heat")]));
  assert.deepEqual(out[0], {
    t: "Heat", y: "2019", k: "Film", w: "Netflix", s: "IMDb 8.0/10", p: "Good.",
  });
});

// --- shapes the model actually produces ------------------------------------

test("strips a ```json fence", () => {
  const out = parseResults("```json\n" + JSON.stringify(ten) + "\n```");
  assert.equal(out.length, 10);
});

test("strips a bare ``` fence", () => {
  const out = parseResults("```\n" + JSON.stringify(ten) + "\n```");
  assert.equal(out.length, 10);
});

test("survives a sentence of preamble", () => {
  const out = parseResults("Here are the ten best:\n\n" + JSON.stringify(ten));
  assert.equal(out.length, 10);
});

test("survives trailing prose after the array", () => {
  const out = parseResults(JSON.stringify(ten) + "\n\nHope that helps!");
  assert.equal(out.length, 10);
});

test("accepts a wrapper object", () => {
  const out = parseResults(JSON.stringify({ items: ten }));
  assert.equal(out.length, 10);
});

test("accepts newline-delimited objects with no array", () => {
  const out = parseResults(ten.map((r) => JSON.stringify(r)).join("\n"));
  assert.equal(out.length, 10);
});

// --- truncation ------------------------------------------------------------

test("truncated mid-object keeps the complete records", () => {
  const full = JSON.stringify(ten);
  const cut = full.slice(0, full.indexOf('{"t":"Title 8"') + 30);
  const out = parseResults(cut);
  assert.equal(out.length, 7);
  assert.equal(out[6].t, "Title 7");
});

test("truncated mid-string keeps the complete records", () => {
  const out = parseResults('[{"t":"Alpha","y":"2001"},{"t":"Bet');
  assert.equal(out.length, 1);
  assert.equal(out[0].t, "Alpha");
});

test("truncated immediately after the opening bracket yields nothing", () => {
  assert.deepEqual(parseResults("["), []);
});

test("truncated inside the very first object yields nothing", () => {
  assert.deepEqual(parseResults('[{"t":"Alp'), []);
});

test("truncated mid-escape does not throw", () => {
  const out = parseResults('[{"t":"Alpha"},{"t":"Bad\\');
  assert.equal(out.length, 1);
});

// --- characters that break naive parsers -----------------------------------

test("a brace inside a title does not desynchronise the scanner", () => {
  const rows = [rec("Everything {sic} Everywhere"), rec("Second")];
  const broken = "prose " + JSON.stringify(rows); // force the scanner path
  const out = parseResults(broken);
  assert.equal(out.length, 2);
  assert.equal(out[0].t, "Everything {sic} Everywhere");
});

test("an unbalanced closing brace inside a title is safe", () => {
  const out = parseResults("prose " + JSON.stringify([rec("Exit }"), rec("Next")]));
  assert.equal(out.length, 2);
  assert.equal(out[0].t, "Exit }");
});

test("escaped quotes in a title survive", () => {
  const out = parseResults("prose " + JSON.stringify([rec('The "Burbs"'), rec("Next")]));
  assert.equal(out.length, 2);
  assert.equal(out[0].t, 'The "Burbs"');
});

test("a backslash before a quote does not swallow the record", () => {
  const out = parseResults("prose " + JSON.stringify([rec("AC\\DC: Live"), rec("Next")]));
  assert.equal(out.length, 2);
  assert.equal(out[0].t, "AC\\DC: Live");
});

test("a nested object inside a record is handled", () => {
  const out = parseResults('prose [{"t":"Alpha","w":{"us":"Netflix"}},{"t":"Beta"}]');
  assert.equal(out.length, 2);
  assert.equal(out[1].t, "Beta");
});

// --- coercion --------------------------------------------------------------

test("a numeric year becomes a string", () => {
  const out = parseResults(JSON.stringify([{ t: "A", y: 2019 }]));
  assert.equal(out[0].y, "2019");
});

test("a year range keeps the first year", () => {
  const out = parseResults(JSON.stringify([{ t: "A", y: "2019-2023" }]));
  assert.equal(out[0].y, "2019");
});

test("a non-year value for y becomes empty", () => {
  const out = parseResults(JSON.stringify([{ t: "A", y: "ongoing" }]));
  assert.equal(out[0].y, "");
});

test("an array for where-to-watch is joined", () => {
  const out = parseResults(JSON.stringify([{ t: "A", w: ["Netflix", "Max"] }]));
  assert.equal(out[0].w, "Netflix, Max");
});

test("missing fields become empty strings, never undefined", () => {
  const out = parseResults(JSON.stringify([{ t: "A" }]));
  assert.deepEqual(out[0], { t: "A", y: "", k: "", w: "", s: "", p: "" });
});

test("whitespace around values is trimmed", () => {
  const out = parseResults(JSON.stringify([{ t: "  A  ", p: "\n Why \n" }]));
  assert.equal(out[0].t, "A");
  assert.equal(out[0].p, "Why");
});

test("a record with no title is dropped", () => {
  const out = parseResults(JSON.stringify([{ y: "2019", k: "Film" }, { t: "Real" }]));
  assert.equal(out.length, 1);
  assert.equal(out[0].t, "Real");
});

test("a record with an empty title is dropped", () => {
  const out = parseResults(JSON.stringify([{ t: "   " }, { t: "Real" }]));
  assert.equal(out.length, 1);
});

test("markup in a title is preserved verbatim for textContent rendering", () => {
  const nasty = '<img src=x onerror=alert(1)>';
  const out = parseResults(JSON.stringify([{ t: nasty }]));
  assert.equal(out[0].t, nasty);
});

// --- junk ------------------------------------------------------------------

for (const [label, input] of [
  ["empty string", ""],
  ["whitespace", "   \n  "],
  ["plain prose", "I could not find anything for that topic."],
  ["an empty array", "[]"],
  ["a bare number", "42"],
  ["null", null],
  ["undefined", undefined],
  ["a number", 42],
  ["an object", { t: "A" }],
  ["an array", [{ t: "A" }]],
  ["an unopened brace", "}}}"],
  ["nothing but fences", "``````"],
]) {
  test(`returns [] for ${label}`, () => {
    assert.deepEqual(parseResults(input), []);
  });
}

// --- report ----------------------------------------------------------------

for (const { name, err } of failures) {
  console.error(`FAIL  ${name}\n      ${err.message}`);
}
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
