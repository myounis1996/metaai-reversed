// Tiny shared helpers so every live harness prints prompt + answer the same
// way, honours --verbose, and runs its cases the same way. Not a framework.

const path = require("path");
const fs = require("fs");

const COOKIES_PATH = path.join(__dirname, "..", "cookies.json");

function isVerbose() {
  return process.argv.includes("--verbose") || process.argv.includes("-v") || process.env.VERBOSE === "1";
}

const LINE = "═".repeat(70);

function printPrompt(text) {
  console.log("\n═ PROMPT " + "═".repeat(61));
  console.log(text);
  console.log(LINE);
}

function printAnswer(text, {label = "ANSWER"} = {}) {
  const header = `═ ${label} `;
  console.log("\n" + header + "═".repeat(Math.max(3, 70 - header.length)));
  console.log(text);
  console.log(LINE);
}

const fmtMs = (ms) => `${ms.toFixed(0)} ms`;

// Fail fast with a useful message instead of a 4003 from the gateway.
function requireCookies() {
  if (!fs.existsSync(COOKIES_PATH)) {
    console.error(`no cookies.json at ${COOKIES_PATH} — export one from a logged-in meta.ai tab (see README)`);
    process.exit(1);
  }
  return COOKIES_PATH;
}

// Run [name, fn] cases in order; exit 1 if any failed.
async function runCases(suite, cases) {
  let failed = 0;
  for (const [name, fn] of cases) {
    try {
      await fn();
      console.log(`[${suite}:${name}] OK`);
    } catch (err) {
      failed += 1;
      console.error(`[${suite}:${name}] FAIL —`, err.message);
    }
  }
  process.exit(failed === 0 ? 0 : 1);
}

// Drain a stream, timing the first chunk; echoes chunks under --verbose.
async function drain(stream) {
  const t0 = performance.now();
  let firstAt = null;
  let chunks = 0;
  let text = "";
  for await (const chunk of stream) {
    if (firstAt === null) firstAt = performance.now();
    chunks += 1;
    text += chunk.text;
    if (isVerbose()) process.stdout.write(chunk.text);
  }
  if (isVerbose()) process.stdout.write("\n");
  return {text, chunks, ttft: firstAt === null ? null : firstAt - t0};
}

module.exports = {COOKIES_PATH, isVerbose, printPrompt, printAnswer, fmtMs, requireCookies, runCases, drain};
