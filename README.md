# metaai-reversed

Talk to **meta.ai** from Node by doing an impression of a web browser so committed it deserves an award.

```js
const {AnonChat} = require("metaai-reversed");
console.log(await new AnonChat().complete("Who are you?"));
// "I am Meta AI."
```

No account. No API key. No browser. No dependencies. Just `fetch`, a `WebSocket`, and a deep personal knowledge of protobuf field numbers that nobody should have.

> ⚠️ Unofficial reverse-engineering project. Not affiliated with, endorsed by, or known to Meta. Your use is subject to Meta's terms of service. If it breaks, you get to keep both pieces.

---

## Install

```bash
npm install github:myounis1996/metaai-reversed
```

Node **22.4+** (for the built-in WebSocket). `node_modules` stays empty. It's beautiful in there.

---

## How it works, in one paragraph

meta.ai doesn't chat over HTTP. It opens a WebSocket to `gateway.meta.ai`, speaks a custom binary framing over it, and inside each frame sends JSON that contains base64 that contains a protobuf. The header announcing this arrangement is, and we are not making this up, `PROTO_INSIDE_JSON`. The answer comes back not as text but as a stream of JSON patches against a UI document, which this library applies, then turns back into markdown. It's turtles. Polite, well-typed turtles.

---

## Quick start

### Anonymous (no cookies at all)

```js
const {AnonChat} = require("metaai-reversed");

const chat = new AnonChat();
console.log(await chat.complete("Explain recursion in one sentence."));
chat.resetSession(); // become a different stranger
```

meta.ai will mint a temporary user for anyone who asks nicely. We ask nicely.

### Logged in

```js
const {AuthChat} = require("metaai-reversed");

const chat = new AuthChat({cookiesPath: "./cookies.json"});
console.log(await chat.complete("Who are you?"));
// "I'm Meta AI, built by Meta and powered by Muse Spark 1.1."
```

(Logged out, it "cannot share the specifics of my model". Logged in, it tells you. Loyalty has its perks.)

### Streaming

```js
const stream = await chat.complete("Write a haiku about sockets", {stream: true});
for await (const {text} of stream) process.stdout.write(text);
```

### Keep talking

```js
await chat.complete("My lucky number is 47.");
const id = chat.lastResponse.conversationId;
await chat.complete("What's my lucky number?", {conversationId: id}); // "47"
```

### Thinking mode

```js
await chat.complete("Is 391 prime?", {
  mode: "thinking",                       // or "instant" (default)
  onThinking: ({text}) => process.stderr.write(text),
});
// "No, 391 is not prime — 391 = 17 × 23."
chat.lastResponse.thinking; // [{header, body}, …]
```

### Web search, with citations

There is no "search" switch. The model decides to browse. Asking for something from this week tends to convince it.

```js
await chat.complete("Search the web: latest Node.js release this week? Cite sources.");
chat.lastResponse.citations; // [{id, url, title, site}, …]
// and the text links them inline: "… released Oct 14 [1](https://…)"
```

### Look at a picture

```js
await chat.complete("What colour is this?", {files: ["./mystery.png"]}); // "Red."
// also: Buffers, or {bytes, name, mime}. Works logged out too.
```

### Make a picture (logged in)

```js
const {AuthImageGen} = require("metaai-reversed");
const fs = require("fs");

const gen = new AuthImageGen({cookiesPath: "./cookies.json"});
const {images} = await gen.generate("a lighthouse in heavy rain", {download: true});
fs.writeFileSync("out.webp", images[0].bytes); // 1920×1280, very moody
```

Want a different shape? There's no size option, because the website doesn't have one either. You just *say it*, and it listens:

| put in the prompt | you get |
|---|---|
| nothing | 1920×1280 |
| `portrait, 9:16` | 1152×2048 |
| `landscape, 16:9` | 2048×1152 |
| `square, 1:1` | 1600×1600 |

```js
await gen.generate("a lighthouse in heavy rain, portrait orientation (9:16)");
```

There is no image endpoint and no image model to pick. You ask the chat for a picture, the chat calls a tool named `imagine`, and a picture falls out of the answer. If the model replies with words instead, you get an `ImageGenRefusalError` with the words attached.

Logged out, ask for an image and Meta AI will cheerfully describe the beautiful image it has made for you. There is no image. It's very confident about it, though.

---

## Cookies (logged-in only)

1. Log in at `meta.ai`.
2. Export the cookies with any cookie-export extension (`[{name, value, domain, …}]`).
3. Save as `cookies.json`. The important ones are `datr` and `ecto_1_sess`.

Any shape works:

```js
new AuthChat({cookiesPath: "./cookies.json"});
new AuthChat({cookies: [{name: "datr", value: "…"}, /* … */]});
new AuthChat({cookies: "datr=…; ecto_1_sess=…"});
```

🔒 `cookies.json` **is your Meta login.** It's in `.gitignore`. Keep it out of issues, gists and screenshots.

🗂️ meta.ai has no temporary chat, so everything you send ends up in your history. Clean up after yourself:

```js
await chat.listConversations();          // [{id, title, updatedAt, pinned}]
await chat.deleteConversation(id);
```

`AuthImageGen` does this for you after every picture (`keepConversation: true` to opt out). The image URLs survive the deletion; we checked.

---

## `lastResponse`

After every turn:

```js
{
  text,            // markdown: prose, code fences, tables, $$math$$, [n](links)
  thinking,        // [{header, body}] — Thinking mode only
  images,          // [{url, mediaId, width, height, mimeType, bytes?}]
  citations,       // [{id, url, title, site}]
  followUps,       // suggested next prompts
  title,           // the server names new conversations ("Simple math question")
  conversationId, responseId, mode,
}
```

## `complete(message, options)`

| option | default | |
|---|---|---|
| `stream` | `false` | async iterable of `{text}` |
| `mode` | `"instant"` | or `"thinking"` |
| `conversationId` | new chat | continue one this instance started |
| `files` | `[]` | paths, Buffers, or `{bytes, name, mime}` |
| `timeoutMs` | `300000` | the whole turn |
| `onThinking` / `onEvent` | | observers |

---

## Tests

```bash
npm test                # offline: protobuf, framing, renderer. No network.
npm run test:anon       # the rest are live and hit meta.ai for real
npm run test:auth       # needs cookies.json
npm run test:thinking
npm run test:search
npm run test:files
npm run test:image      # writes tests/output/image.webp
```

---

## When it breaks

It will. Meta ships fast and owes us nothing.

| symptom | translation |
|---|---|
| `meta.ai served no access token` | your cookies expired. Re-export them |
| `gateway rejected the access token (close 4003)` | token went stale. Retried once automatically |
| `graphql … failed` | a query id rotated after a Meta deploy |
| `meta.ai refused the turn: GLOBAL_RATE_LIMITED` | go outside for a bit |
| the stream ends early, but `lastResponse.text` is complete | the server rewrote text it had already sent (it does that with math). The stream can't unsay things; `lastResponse` is the truth |

---

## License

[MIT](LICENSE). Do what you like; it comes with no warranty, which is the most honest thing about it.
