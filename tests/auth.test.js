const {AuthChat} = require("../src");
const {printPrompt, printAnswer, fmtMs, requireCookies, runCases, drain} = require("./_helpers");

// Deterministic reply so the parser's capture of the full stream is checkable.
const PROMPT =
  "List the 8 planets of our solar system in order from the Sun, one per line, with no numbering, no extra text, no bullets, just the names.";
const PLANETS = ["Mercury", "Venus", "Earth", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune"];
const chat = new AuthChat({cookiesPath: requireCookies()});

// meta.ai has no temporary chat — every turn lands in the account's history,
// so each case deletes what it created.
async function withCleanup(fn) {
  try {
    await fn();
  } finally {
    const id = chat.lastResponse && chat.lastResponse.conversationId;
    if (id) await chat.deleteConversation(id).catch(() => {});
  }
}

const checkPlanets = (text) => {
  const missing = PLANETS.filter((p) => !text.includes(p));
  if (missing.length) throw new Error(`reply is missing ${missing.join(", ")}`);
};

const testCollect = () =>
  withCleanup(async () => {
    console.log("\n── [auth] collected ───────────────────────────────────────");
    printPrompt(PROMPT);
    const t0 = performance.now();
    const reply = await chat.complete(PROMPT);
    printAnswer(reply);
    console.log("elapsed:", fmtMs(performance.now() - t0), "| title:", chat.lastResponse.title);
    checkPlanets(reply);
  });

const testStream = () =>
  withCleanup(async () => {
    console.log("\n── [auth] streaming ───────────────────────────────────────");
    printPrompt(PROMPT);
    const {text, chunks, ttft} = await drain(await chat.complete(PROMPT, {stream: true}));
    printAnswer(text);
    console.log("chunks:", chunks, "| time to first chunk:", ttft === null ? "n/a" : fmtMs(ttft));
    checkPlanets(text);
    if (text !== chat.lastResponse.text) throw new Error("streamed text differs from lastResponse.text");
  });

const testFollowUpAndHistory = () =>
  withCleanup(async () => {
    console.log("\n── [auth] follow-up + history list/delete ─────────────────");
    await chat.complete("My lucky number is 47. Reply with just OK.");
    const {conversationId} = chat.lastResponse;
    const reply = await chat.complete("What is my lucky number? Just the number.", {conversationId});
    printAnswer(reply);
    if (!reply.includes("47")) throw new Error("the follow-up did not remember the first turn");
    const listed = await chat.listConversations();
    if (!listed.some((c) => c.id === conversationId)) throw new Error("new conversation is not in listConversations()");
    await chat.deleteConversation(conversationId);
    const after = await chat.listConversations();
    if (after.some((c) => c.id === conversationId)) throw new Error("conversation still listed after delete");
    console.log("listed, then deleted:", conversationId);
  });

runCases("auth", [
  ["collect", testCollect],
  ["stream", testStream],
  ["follow-up+history", testFollowUpAndHistory],
]);
