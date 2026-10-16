// Offline self-check for the pure parts: protobuf wire codec, the ecto Request
// builder / Response reader, DGW framing, and the JSON-patch renderer
// (including the streaming hold-back rules), plus a check that every request
// rides a caller's dispatcher. No network, no cookies — this is what
// `npm test` and CI run. The live harnesses are the other files here.

const assert = require("assert");
const {encode, decode, get, getMessage, getString} = require("../src/proto/wire");
const {buildRequest, readResponse, offlineThreadingId} = require("../src/proto/ecto");
const {buildFrame, parseFrame, buildDataFrame, FRAME, openTurn} = require("../src/http/dgw");
const {ResponseState} = require("../src/http/response");
const {readAttachmentInput, uploadAttachment} = require("../src/http/upload");
const {MODES, resolveMode} = require("../src/models");
const {CookieJar} = require("../src/auth/CookieJar");
const {AnonChat} = require("../src/clients/AnonChat");
const {AuthImageGen} = require("../src/clients/AuthImageGen");

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("wire: round-trips varints, strings, floats, nested and repeated fields", () => {
  const big = 7516764622361569504n;
  const bytes = encode([[1, 150], [2, big], [3, "héllo"], [4, [[1, true], [2, "x"]]], [5, {float: 1}], [6, "a"], [6, "b"], [7, undefined]]);
  const msg = decode(bytes);
  assert.strictEqual(get(msg, 1), 150n);
  assert.strictEqual(get(msg, 2), big);
  assert.strictEqual(getString(msg, 3), "héllo");
  assert.strictEqual(get(getMessage(msg, 4), 1), 1n);
  assert.strictEqual(get(msg, 5), 0x3f800000);
  assert.deepStrictEqual(msg.filter(([f]) => f === 6).map(([, v]) => v.toString()), ["a", "b"]);
  assert.strictEqual(get(msg, 7), undefined);
  assert.strictEqual(encode([[1, 150]]).toString("hex"), "089601"); // the protobuf docs' own example
  assert.throws(() => decode(Buffer.from([0x0a, 0x05, 0x01])), /overruns/);
});

test("ecto: offline threading id carries the timestamp in its high bits", () => {
  assert.strictEqual(offlineThreadingId(1792136340793) >> 22n, 1792136340793n);
});

const BROWSER = {platform: "Windows", agent: "UA", language: "en-US", timezone: "UTC"};
const baseRequest = (overrides = {}) => ({
  userId: "1359072033957927",
  loggedOut: false,
  conversation: {id: "conv-1", sessionId: "sess-1", lastEventId: null, branchPath: null},
  requestId: "req-1",
  turnId: "turn-1",
  qplJoinId: "qpl-1",
  message: "hi",
  mode: MODES.instant,
  browser: BROWSER,
  ...overrides,
});

test("ecto: first-turn Request has the web client's shape", () => {
  const req = decode(buildRequest(baseRequest()));
  const meta = getMessage(req, 1);
  const ctx = getMessage(meta, 1);
  assert.strictEqual(getString(ctx, 1), "KADABRA__HOME__UNIFIED_INPUT_BAR");
  assert.strictEqual(getString(ctx, 11), "Abra Web Main Key");
  const agent = getMessage(getMessage(ctx, 12), 3);
  assert.strictEqual(get(agent, 1), 1000n);
  assert.strictEqual(getString(agent, 2), "MODE_FAST");
  assert.ok(getMessage(getMessage(ctx, 12), 4), "new conversation asks for a title");
  assert.strictEqual(get(getMessage(meta, 2), 1), 1359072033957927n);
  assert.strictEqual(get(getMessage(meta, 2), 3), 2n); // USER_TYPE_EXTERNAL
  assert.strictEqual(getString(meta, 6), "req-1");
  assert.strictEqual(getMessage(meta, 7).length, 0, "instant sends no thinking overrides");
  const prompt = getMessage(req, 2);
  const promptId = getMessage(prompt, 1);
  assert.strictEqual(getString(promptId, 1), "turn-1");
  assert.strictEqual(get(promptId, 5), 1n); // is_new_conversation
  assert.strictEqual(getString(prompt, 2), "hi");
  assert.strictEqual(getString(getMessage(prompt, 4), 1), "0");
});

test("ecto: follow-up, thinking, logged-out and attachments", () => {
  const req = decode(buildRequest(baseRequest({
    loggedOut: true,
    mode: resolveMode("thinking"),
    conversation: {id: "conv-1", sessionId: "sess-1", lastEventId: "e.123", branchPath: "2"},
    attachments: [{mediaId: "1185075233844103", kind: "image", mimeType: "image/png", filename: "red.png"}],
  })));
  const meta = getMessage(req, 1);
  const ctx = getMessage(meta, 1);
  assert.strictEqual(getString(ctx, 1), "KADABRA__CHAT__UNIFIED_INPUT_BAR");
  assert.strictEqual(getString(ctx, 11), "Abra Web Temp User Key");
  assert.strictEqual(getMessage(getMessage(ctx, 12), 4), null, "no title request on a follow-up");
  assert.strictEqual(get(getMessage(meta, 2), 3), 6n); // USER_TYPE_LOGGED_OUT
  assert.strictEqual(get(getMessage(meta, 7), 12), 1n); // thinking_enabled
  assert.strictEqual(get(getMessage(meta, 7), 13), 1n); // THINKING_LEVEL_STANDARD
  const prompt = getMessage(req, 2);
  const promptId = getMessage(prompt, 1);
  assert.strictEqual(getString(promptId, 4), "e.123");
  assert.strictEqual(get(promptId, 5), undefined);
  assert.strictEqual(getString(prompt, 2), "<|attachment:0|> hi");
  const attachment = getMessage(prompt, 3);
  assert.strictEqual(get(getMessage(attachment, 1), 1), 1185075233844103n);
  assert.strictEqual(get(attachment, 2), 1n); // ATTACHMENT_TYPE_IMAGE
  assert.strictEqual(getString(getMessage(prompt, 4), 1), "2");
});

test("ecto: readResponse pulls raw state, final flag, continuation ids and errors", () => {
  const raw = JSON.stringify({response_id: "r", sections: []});
  const chunk = readResponse(encode([
    [1, [[4, [[2, "so far"], [5, true], [10, raw]]]]], // piece.model_response
    [3, true],
    [4, "r"],
    [9, [[1, "A title"]]],
    [10, [[1, "1"], [2, "2"]]],
    [12, "e.abc"],
  ]));
  assert.deepStrictEqual(
    {isFinal: chunk.isFinal, raw: chunk.raw, title: chunk.title, branchPath: chunk.branchPath, lastEventId: chunk.lastEventId},
    {isFinal: true, raw, title: "A title", branchPath: "2", lastEventId: "e.abc"}
  );
  assert.strictEqual(readResponse(encode([[1, [[5, [[4, "{}"]]]]]])).raw, "{}"); // reasoning_response
  const err = readResponse(encode([[1, [[10, [[1, "slow down"], [2, 2]]]]]]));
  assert.deepStrictEqual(err.error, {message: "slow down", code: "GLOBAL_RATE_LIMITED"});
});

test("dgw: frames round-trip; DATA asks for an ack", () => {
  const f = parseFrame(buildFrame(FRAME.ESTAB_STREAM, Buffer.from('{"code":200}')));
  assert.strictEqual(f.type, FRAME.ESTAB_STREAM);
  assert.strictEqual(f.body.toString(), '{"code":200}');
  const data = buildDataFrame(Buffer.from("{}"));
  assert.strictEqual(data.subarray(0, 8).toString("hex"), "0d0000040000" + "0080");
});

const md = (text, inline_entities) => ({view_model: {primitive: {__typename: "GenAIMarkdownTextUXPrimitive", text, ...(inline_entities ? {inline_entities} : {})}}});
const block = (primitive) => ({view_model: {primitive}});

test("response: full + patch ops (add, delta, replace, remove) build the document", () => {
  const st = new ResponseState();
  st.apply(JSON.stringify({seq: 0, type: "full", response: {sections: [block({__typename: "GenAIBotThinkingStatusPrimitive", title: "t"})]}}));
  st.apply(JSON.stringify({seq: 1, type: "patch", operations: [{op: "add", path: "/sections/1", value: md("I'm")}]}));
  st.apply(JSON.stringify({seq: 2, type: "patch", operations: [{op: "delta", path: "/sections/1/view_model/primitive/text", value: " Meta AI"}]}));
  assert.strictEqual(st.text, "I'm Meta AI");
  st.apply(JSON.stringify({seq: 3, type: "patch", operations: [{op: "replace", path: "/sections/0/view_model/primitive/title", value: "Show thinking"}, {op: "remove", path: "/sections/1"}]}));
  assert.strictEqual(st.text, "");
  assert.strictEqual(st.doc.sections[0].view_model.primitive.title, "Show thinking");
  assert.strictEqual(st.apply("not json"), false);
});

test("response: renders code, tables, math, citations, images, thinking", () => {
  const st = new ResponseState();
  st.apply(JSON.stringify({
    sections: [
      md("Node {{IE_0}}123{{/IE_0}} and $x$ via {{IE_1}}$y${{/IE_1}}; junk{{IE_2}}[9]{{/IE_2}}.", [
        {key: "IE_0", metadata: {reference_id: 1, reference_url: "https://n.org", reference_title: "Node", reference_display_name: "n.org"}},
        {key: "IE_1", metadata: {latex_expression: "y"}},
      ]),
      block({__typename: "GenAICodeUXPrimitive", language: "js", code_blocks: [{content: "let a"}, {content: " = 1;"}]}),
      block({__typename: "GenATableUXPrimitive", rows: [{is_header: true, markdown_cells: [{text: "A"}, {text: "B|C"}]}, {markdown_cells: [{text: "1"}, {text: "2"}]}]}),
      block({__typename: "GenAILatexUXPrimitive", latex_expression: "e^{i\\pi}+1=0"}),
      block({__typename: "GenAIImagePrimitive", full_image: {url: "https://img", media_id: "9", width: 2, height: 1, mime_type: "image/webp"}}),
      block({__typename: "GenAIClippyFollowUpPrimitive", prompt_text: "More?"}),
    ],
    embedded_screens: [{content: [{tabs: [{step_entries: [{header: "h", body: "thought"}]}]}]}],
  }));
  assert.strictEqual(
    st.text,
    "Node [1](https://n.org) and $x$ via $y$; junk.\n\n```js\nlet a = 1;\n```\n\n| A | B\\|C |\n| --- | --- |\n| 1 | 2 |\n\n$$\ne^{i\\pi}+1=0\n$$"
  );
  assert.deepStrictEqual(st.citations, [{id: 1, url: "https://n.org", title: "Node", site: "n.org"}]);
  assert.strictEqual(st.images[0].url, "https://img");
  assert.deepStrictEqual(st.followUps, ["More?"]);
  assert.deepStrictEqual(st.thinking, [{header: "h", body: "thought"}]);
});

test("response: streaming render only grows — unstable parts are held back", () => {
  const st = new ResponseState();
  const renders = [];
  const step = (patch) => {
    st.apply(JSON.stringify(patch));
    renders.push(st.renderText({final: false}));
  };
  step({type: "full", response: {sections: [md("See {{IE_0}}1")]}}); // marker still open
  step({type: "patch", operations: [{op: "delta", path: "/sections/0/view_model/primitive/text", value: "{{/IE_0}} and"}]}); // closed, entity not here yet
  step({type: "patch", operations: [{op: "add", path: "/sections/0/view_model/primitive/inline_entities", value: [{key: "IE_0", metadata: {reference_id: 1, reference_url: "https://a"}}]}]});
  step({type: "patch", operations: [{op: "add", path: "/sections/1", value: block({__typename: "GenAICodeUXPrimitive", code_blocks: [{content: "x"}]})}]});
  step({type: "patch", operations: [{op: "delta", path: "/sections/1/view_model/primitive/code_blocks/0/content", value: "yz"}]});
  step({type: "patch", operations: [{op: "add", path: "/sections/2", value: md("$$e=")}]}); // display math streamed as prose…
  step({type: "full", response: {sections: [st.doc.sections[0], st.doc.sections[1], block({__typename: "GenAILatexUXPrimitive"})]}}); // …then rewritten into a block, expression pending
  step({type: "patch", operations: [{op: "add", path: "/sections/2/view_model/primitive/latex_expression", value: "mc^2"}, {op: "add", path: "/sections/3", value: md("Done.")}]});
  const final = st.renderText({final: true});
  renders.push(final);
  for (let i = 1; i < renders.length; i++) {
    assert.ok(renders[i].startsWith(renders[i - 1]), `render ${i} rewrote earlier text:\n${renders[i - 1]}\n→\n${renders[i]}`);
  }
  assert.strictEqual(renders[0], "See ");
  assert.strictEqual(final, "See [1](https://a) and\n\n```\nxyz\n```\n\n$$\nmc^2\n$$\n\nDone.");
});

test("upload: input shapes and MIME sniffing", () => {
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  assert.deepStrictEqual({...readAttachmentInput(png), bytes: undefined}, {bytes: undefined, name: "upload.png", mime: "image/png"});
  assert.strictEqual(readAttachmentInput({bytes: Buffer.from("a,b"), name: "t.csv"}).mime, "text/csv");
  assert.throws(() => readAttachmentInput(Buffer.alloc(0)), /non-empty/);
});

test("models + cookies: modes resolve by key or id; cookie shapes parse", () => {
  assert.strictEqual(resolveMode("think_hard"), MODES.thinking);
  assert.throws(() => resolveMode("pro"), /Unknown mode/);
  const jar = CookieJar.resolve({cookies: "datr=a; ecto_1_sess=b%3Ac"});
  assert.strictEqual(jar.get("ecto_1_sess"), "b%3Ac");
  assert.strictEqual(CookieJar.resolve({cookies: '[{"name":"datr","value":"x"}]'}).get("datr"), "x");
  jar.absorb(["datr=; Max-Age=0", "wd=1920x911; Path=/"]);
  assert.strictEqual(jar.has("datr"), false);
  assert.strictEqual(jar.toHeader(), "ecto_1_sess=b%3Ac; wd=1920x911");
});

// A dispatcher that notes where each request was going and refuses it, so
// nothing leaves the machine. Throwing from dispatch() fails a fetch or a
// socket the same way on every undici version.
test("dispatcher: the socket, GraphQL, uploads, the identity page and image downloads all ride it", async () => {
  const seen = [];
  const dispatcher = {
    dispatch(opts) {
      seen.push(opts.origin + opts.path);
      throw new Error("offline");
    },
  };
  const turn = {accessToken: "ecto1:x", conversationId: "c", requestId: "r", payload: Buffer.alloc(0), dispatcher};
  await assert.rejects(openTurn(turn), /dgw: socket/);
  await assert.rejects(new AnonChat({dispatcher}).complete("hi"));
  await assert.rejects(uploadAttachment(Buffer.from("89504e47", "hex"), {accessToken: "x", dispatcher}));
  const gen = new AuthImageGen({cookies: "datr=a; ecto_1_sess=b", dispatcher});
  await assert.rejects(gen._getIdentity());
  gen.complete = async function () {
    // a turn that drew a picture, so generate() reaches the download
    this._lastResponse = {text: "", images: [{url: "https://scontent.example.net/i.jpg"}], conversationId: "c"};
    return "";
  };
  await assert.rejects(gen.generate("a fox", {download: true}));
  await assert.rejects(gen.deleteConversation("c"));
  const expected = [
    /^https:\/\/gateway\.meta\.ai\/ws\/clippy\?/,
    /^https:\/\/www\.meta\.ai\/api\/graphql$/,
    /^https:\/\/rupload\.meta\.ai\/gen_ai_document_gen_ai_tenant\//,
    /^https:\/\/www\.meta\.ai\/$/,
    /^https:\/\/scontent\.example\.net\/i\.jpg$/,
    /^https:\/\/www\.meta\.ai\/api\/graphql$/,
  ];
  assert.strictEqual(seen.length, expected.length, seen.join("\n"));
  expected.forEach((pattern, i) => assert.match(seen[i], pattern));
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`ok   ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL ${name}\n     ${err.message.split("\n").join("\n     ")}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
