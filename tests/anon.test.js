const {AnonChat} = require("../src");
const {printPrompt, printAnswer, fmtMs, runCases, drain} = require("./_helpers");

const PROMPT = "In one short sentence: who are you?";

async function testCollect() {
  console.log("\n── [anon] collected ───────────────────────────────────────");
  printPrompt(PROMPT);
  const chat = new AnonChat();
  const t0 = performance.now();
  const reply = await chat.complete(PROMPT);
  printAnswer(reply);
  console.log("elapsed:", fmtMs(performance.now() - t0), "| title:", chat.lastResponse.title);
  if (typeof reply !== "string" || reply.length === 0) throw new Error("expected non-empty string reply");
}

async function testStream() {
  console.log("\n── [anon] streaming ───────────────────────────────────────");
  const prompt = "Name the 8 planets of the solar system, comma separated, nothing else.";
  printPrompt(prompt);
  const chat = new AnonChat();
  const {text, chunks, ttft} = await drain(await chat.complete(prompt, {stream: true}));
  printAnswer(text);
  console.log("chunks:", chunks, "| time to first chunk:", ttft === null ? "n/a" : fmtMs(ttft));
  if (chunks === 0 || !text) throw new Error("stream produced no text");
  if (text !== chat.lastResponse.text) throw new Error("streamed text differs from lastResponse.text");
}

async function testFollowUp() {
  console.log("\n── [anon] follow-up in the same conversation ──────────────");
  const chat = new AnonChat();
  await chat.complete("My secret word is PINEAPPLE. Reply with just OK.");
  const reply = await chat.complete("What is my secret word? One word.", {
    conversationId: chat.lastResponse.conversationId,
  });
  printAnswer(reply);
  if (!/pineapple/i.test(reply)) throw new Error("the follow-up did not remember the first turn");
}

runCases("anon", [
  ["collect", testCollect],
  ["stream", testStream],
  ["follow-up", testFollowUp],
]);
