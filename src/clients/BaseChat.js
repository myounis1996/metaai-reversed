const {randomUUID} = require("crypto");
const {SIMULATED_BROWSER} = require("../http/browser");
const {openTurn} = require("../http/dgw");
const {ResponseState} = require("../http/response");
const {uploadAttachment} = require("../http/upload");
const {buildRequest, readResponse} = require("../proto/ecto");
const {resolveMode} = require("../models");

// One chat turn = one protobuf Request over a fresh DGW socket, answered by a
// stream of Response chunks (see src/http/dgw.js, src/http/response.js).
//
// Conversation state lives on the server. To continue a conversation the next
// Request only has to carry two values from the previous turn's final chunk —
// `last_event_id` and `response_branch_path` — so that is all this class
// remembers, per conversation id.
//
// Subclasses supply `_getIdentity({refresh})` → {userId, accessToken, loggedOut}.
class BaseChat {
  constructor({mode = "instant"} = {}) {
    if (new.target === BaseChat) {
      throw new Error("BaseChat is abstract — instantiate AnonChat or AuthChat");
    }
    this._defaultMode = resolveMode(mode).id;
    // One prompt session per instance, like one browser tab.
    this._sessionId = randomUUID();
    this._conversations = new Map();
    this._lastResponse = null;
  }

  // Everything the most recent turn produced:
  //   {text, thinking: [{header, body}], images: [{url, mediaId, …}],
  //    citations: [{id, url, title, site}], followUps: [string], title,
  //    conversationId, responseId, mode}
  // `title` is only set on the first turn of a conversation (the server names it).
  get lastResponse() {
    return this._lastResponse;
  }

  // Options (all optional):
  //   stream          boolean — return an async iterable of {text} deltas
  //   mode            "instant" | "thinking" (default: the constructor's)
  //   conversationId  continue a conversation this instance started
  //   files           Array<string | Buffer | {path|bytes, name?, mime?}>
  //   timeoutMs       whole-turn timeout (default 300 000)
  //   onThinking({text})  reasoning deltas as they stream
  //   onEvent(chunk)      every decoded Response chunk (see readResponse)
  async complete(message, options = {}) {
    if (typeof message !== "string" || !message.trim()) {
      throw new Error("complete() needs a non-empty message string");
    }
    this._lastResponse = null;
    const mode = resolveMode(options.mode || this._defaultMode);
    const conversation = this._conversation(options.conversationId);

    let identity = await this._getIdentity();
    const files = Array.isArray(options.files) ? options.files : [];
    const attachments = await Promise.all(
      files.map((file) => uploadAttachment(file, {accessToken: identity.accessToken}))
    );

    const requestId = randomUUID();
    const send = (who) =>
      openTurn({
        accessToken: who.accessToken,
        conversationId: conversation.id,
        requestId,
        timeoutMs: options.timeoutMs,
        payload: buildRequest({
          userId: who.userId,
          loggedOut: who.loggedOut,
          conversation,
          requestId,
          turnId: randomUUID(),
          qplJoinId: randomUUID(),
          message,
          mode,
          attachments,
          browser: SIMULATED_BROWSER,
        }),
      });

    // openTurn only throws before the Request is on the wire, so one retry
    // with a re-fetched identity (the usual cause: an expired token) can never
    // send the message twice.
    let chunks;
    try {
      chunks = await send(identity);
    } catch {
      identity = await this._getIdentity({refresh: true});
      chunks = await send(identity);
    }

    const stream = this._readTurn(chunks, {conversation, mode, options});
    if (options.stream) return stream;
    for await (const _ of stream);
    return this._lastResponse.text;
  }

  async *_readTurn(chunks, {conversation, mode, options}) {
    const state = new ResponseState();
    let emitted = "";
    let thoughts = "";
    for await (const bytes of chunks) {
      const chunk = readResponse(bytes);
      if (typeof options.onEvent === "function") {
        try {
          options.onEvent(chunk);
        } catch {}
      }
      if (chunk.error) {
        throw new Error(
          `meta.ai refused the turn: ${chunk.error.code}${chunk.error.message ? " — " + chunk.error.message : ""}`
        );
      }
      if (chunk.raw) state.apply(chunk.raw);

      const thinking = state.thinking.map((s) => s.body).join("\n\n");
      if (thinking.length > thoughts.length && thinking.startsWith(thoughts)) {
        if (typeof options.onThinking === "function") {
          try {
            options.onThinking({text: thinking.slice(thoughts.length)});
          } catch {}
        }
        thoughts = thinking;
      }

      // ponytail: streams the growing suffix only. If the server ever rewrites
      // earlier text, the stream skips it; lastResponse.text is authoritative.
      const text = state.renderText({final: chunk.isFinal});
      if (text.length > emitted.length && text.startsWith(emitted)) {
        yield {text: text.slice(emitted.length)};
        emitted = text;
      }

      if (chunk.isFinal) {
        conversation.lastEventId = chunk.lastEventId || conversation.lastEventId;
        conversation.branchPath = chunk.branchPath || conversation.branchPath;
        this._conversations.set(conversation.id, conversation);
        this._lastResponse = {
          text,
          thinking: state.thinking,
          images: state.images,
          citations: state.citations,
          followUps: state.followUps,
          title: chunk.title,
          conversationId: conversation.id,
          responseId: chunk.responseId,
          mode: mode.label,
        };
        return;
      }
    }
  }

  _conversation(conversationId) {
    if (!conversationId) {
      return {id: randomUUID(), sessionId: this._sessionId, lastEventId: null, branchPath: null};
    }
    const known = this._conversations.get(conversationId);
    if (!known) {
      throw new Error(
        `Unknown conversationId ${conversationId} — only conversations started by this instance can be continued`
      );
    }
    return known;
  }

  async _getIdentity() {
    throw new Error("_getIdentity must be implemented by subclass");
  }
}

module.exports = {BaseChat};
