const zlib = require("zlib");
const {AnonChat, AuthChat} = require("../src");
const {printPrompt, printAnswer, requireCookies, runCases} = require("./_helpers");

const PROMPT = "What colour is this image? Answer with one word.";

// A solid red 64x64 PNG, built here so the suite needs no fixture file.
function redPng() {
  const w = 64;
  const h = 64;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) raw.set([220, 20, 30], y * (w * 3 + 1) + 1 + x * 3);
  }
  const crcTable = Array.from({length: 256}, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function ask(chat, label) {
  console.log(`\n── [files] ${label}: vision on an uploaded PNG ${"─".repeat(30 - label.length)}`);
  printPrompt(PROMPT);
  const reply = await chat.complete(PROMPT, {files: [{bytes: redPng(), name: "red.png"}]});
  printAnswer(reply);
  if (!/red/i.test(reply)) throw new Error("the model did not see the red image");
}

runCases("files", [
  ["anon", () => ask(new AnonChat(), "anon")],
  [
    "auth",
    async () => {
      const chat = new AuthChat({cookiesPath: requireCookies()});
      try {
        await ask(chat, "auth");
      } finally {
        if (chat.lastResponse) await chat.deleteConversation(chat.lastResponse.conversationId).catch(() => {});
      }
    },
  ],
]);
