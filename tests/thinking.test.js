const {AuthChat} = require("../src");
const {printPrompt, printAnswer, fmtMs, requireCookies, runCases, drain, isVerbose} = require("./_helpers");

const PROMPT = "Is 391 a prime number? Answer in one line.";

async function testThinking() {
  console.log("\n── [thinking] mode: thinking, streamed ─────────────────────");
  printPrompt(PROMPT);
  const chat = new AuthChat({cookiesPath: requireCookies(), mode: "thinking"});
  let thoughtChars = 0;
  const t0 = performance.now();
  try {
    const stream = await chat.complete(PROMPT, {
      stream: true,
      onThinking: ({text}) => {
        thoughtChars += text.length;
        if (isVerbose()) process.stdout.write(`\x1b[2m${text}\x1b[0m`);
      },
    });
    const {text} = await drain(stream);
    const {thinking, mode} = chat.lastResponse;
    printAnswer(thinking.map((s) => `• ${s.header}\n  ${s.body}`).join("\n"), {label: "THINKING"});
    printAnswer(text);
    console.log("mode:", mode, "| steps:", thinking.length, "| streamed thought chars:", thoughtChars, "| elapsed:", fmtMs(performance.now() - t0));
    if (mode !== "Thinking") throw new Error(`expected Thinking mode, got ${mode}`);
    if (thinking.length === 0 || thoughtChars === 0) throw new Error("no reasoning steps came back");
    if (!/17|23|not/i.test(text)) throw new Error("answer does not look right (391 = 17 × 23)");
  } finally {
    if (chat.lastResponse) await chat.deleteConversation(chat.lastResponse.conversationId).catch(() => {});
  }
}

runCases("thinking", [["thinking", testThinking]]);
