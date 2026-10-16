const fs = require("fs");
const path = require("path");
const {AuthImageGen, ImageGenRefusalError} = require("../src");
const {printPrompt, fmtMs, requireCookies, runCases} = require("./_helpers");

const PROMPT = "a red fox sitting in snow, soft morning light";
const OUT_DIR = path.join(__dirname, "output");

async function testGenerate() {
  console.log("\n── [image] generate + download ────────────────────────────");
  printPrompt(PROMPT);
  const gen = new AuthImageGen({cookiesPath: requireCookies()});
  const t0 = performance.now();
  let result;
  try {
    result = await gen.generate(PROMPT, {download: true});
  } catch (err) {
    if (err instanceof ImageGenRefusalError) throw new Error(`refused / answered with text: ${err.text}`);
    throw err;
  }
  const [image] = result.images;
  fs.mkdirSync(OUT_DIR, {recursive: true});
  const ext = (image.mimeType || "image/webp").split("/")[1];
  const file = path.join(OUT_DIR, `image.${ext}`);
  fs.writeFileSync(file, image.bytes);
  console.log(`images: ${result.images.length} | ${image.width}x${image.height} ${image.mimeType} | ${image.bytes.length} bytes → ${file}`);
  console.log("text:", result.text);
  console.log("conversation deleted:", result.deleted, "| elapsed:", fmtMs(performance.now() - t0));
  if (!image.bytes || image.bytes.length < 1000) throw new Error("downloaded image is suspiciously small");
  if (!result.deleted) throw new Error("conversation was not deleted after generation");
}

// No size option exists; orientation is asked for in words. Checks that the
// model still honours it (2026-10-16: portrait 9:16 → 1152x2048).
async function testPortrait() {
  console.log("\n── [image] orientation from the prompt ────────────────────");
  const prompt = "a lighthouse in heavy rain, portrait orientation (vertical, 9:16)";
  printPrompt(prompt);
  const gen = new AuthImageGen({cookiesPath: requireCookies()});
  const {images} = await gen.generate(prompt);
  const {width, height} = images[0];
  console.log(`size: ${width}x${height}`);
  if (!(height > width)) throw new Error(`asked for portrait, got ${width}x${height}`);
}

runCases("image", [
  ["generate", testGenerate],
  ["portrait", testPortrait],
]);
