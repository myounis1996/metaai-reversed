const {AuthChat} = require("../src");
const {printPrompt, printAnswer, requireCookies, runCases, drain} = require("./_helpers");

// meta.ai has no "force search" flag: the model decides to browse. A prompt
// that needs this week's facts, and says so, browses reliably.
const PROMPT = "Search the web: what is the latest Node.js release this week? Two short bullets, cite sources.";

async function testCitations() {
  console.log("\n── [search] web answer with citations ─────────────────────");
  printPrompt(PROMPT);
  const chat = new AuthChat({cookiesPath: requireCookies()});
  try {
    const {text} = await drain(await chat.complete(PROMPT, {stream: true}));
    const {citations} = chat.lastResponse;
    printAnswer(text);
    printAnswer(citations.map((c) => `[${c.id}] ${c.title} — ${c.url}`).join("\n") || "(none)", {label: "CITATIONS"});
    if (citations.length === 0) throw new Error("no citations came back — the turn did not browse");
    if (/\{\{\/?IE_\d+\}\}/.test(text)) throw new Error("raw inline-entity markers leaked into the text");
    if (text !== chat.lastResponse.text) throw new Error("streamed text differs from lastResponse.text");
  } finally {
    if (chat.lastResponse) await chat.deleteConversation(chat.lastResponse.conversationId).catch(() => {});
  }
}

runCases("search", [["citations", testCitations]]);
