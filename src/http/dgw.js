// DGW — the binary WebSocket protocol meta.ai streams chat over
// (wss://gateway.meta.ai/ws/clippy). Reconstructed from live captures,
// 2026-10-16.
//
// Every frame: [type:1][stream id:2 BE][body length:3 LE][body]
//   ESTAB_STREAM (0x0f)  body = JSON stream headers; the gateway answers with
//                        its own ESTAB_STREAM whose body is {"code":200}
//   DATA         (0x0d)  body = [seq:2 LE, bit 15 = "ack me"][payload]
//                        client payload: JSON {"req-id", "payload": base64 Request}
//                        server payload: one protobuf Response chunk
//   ACK          (0x0c)  body = the acked seq
//   PING / PONG  (0x09 / 0x0a)  bare single byte, no header
//   DRAIN (0x03), DEAUTH (0x04) — the gateway is going away / the token is bad
//
// One socket carries one turn here. The web client keeps a socket open and
// multiplexes conversations as streams, but conversation state is entirely
// server-side (see BaseChat), so a fresh socket per turn costs one TLS
// handshake and removes every "is the shared socket still healthy" question.

const {randomUUID} = require("crypto");
const {SIMULATED_BROWSER} = require("./browser");
const {APP_ID} = require("../proto/ecto");

const GATEWAY_URL = "wss://gateway.meta.ai/ws/clippy";
const FRAME = {DRAIN: 0x03, DEAUTH: 0x04, PING: 0x09, PONG: 0x0a, ACK: 0x0c, DATA: 0x0d, END_OF_DATA: 0x0e, ESTAB_STREAM: 0x0f};
const ACK_REQUESTED = 0x8000;
// The web client pings every ~45-60 s while a long (Thinking) turn runs.
const PING_INTERVAL_MS = 30_000;
const DEFAULT_TURN_TIMEOUT_MS = 300_000;

function buildFrame(type, body, streamId = 0) {
  const header = Buffer.alloc(6);
  header[0] = type;
  header.writeUInt16BE(streamId, 1);
  header.writeUIntLE(body.length, 3, 3);
  return Buffer.concat([header, body]);
}

function parseFrame(buf) {
  if (buf.length < 6) return {type: buf[0], streamId: 0, body: Buffer.alloc(0)};
  return {type: buf[0], streamId: buf.readUInt16BE(1), body: buf.subarray(6, 6 + buf.readUIntLE(3, 3))};
}

function buildDataFrame(payload, seq = 0) {
  const prefix = Buffer.alloc(2);
  prefix.writeUInt16LE((seq & 0x7fff) | ACK_REQUESTED);
  return buildFrame(FRAME.DATA, Buffer.concat([prefix, payload]));
}

function gatewayUrl(accessToken) {
  const query = new URLSearchParams({
    "x-dgw-appid": APP_ID,
    "x-dgw-appversion": "1.0.0",
    "x-dgw-authtype": "15:0",
    "x-dgw-version": "5",
    "x-dgw-uuid": "0",
    "x-dgw-tier": "prod",
    Authorization: accessToken,
    "x-dgw-app-origin": "meta.ai",
    "x-dgw-app-clippy-request-id": randomUUID(),
  });
  return `${GATEWAY_URL}?${query}`;
}

// Open a socket, establish the conversation's stream and send one Request.
// Resolves once the request is on the wire, so connection/auth failures throw
// here (before the caller hands a stream to anyone). Returns an async iterator
// of raw Response protobuf chunks; breaking out of it closes the socket.
// `dispatcher` (an undici Dispatcher, e.g. a ProxyAgent) carries the upgrade
// request; Node's WebSocket takes it as a non-standard option.
async function openTurn({accessToken, conversationId, requestId, payload, timeoutMs = DEFAULT_TURN_TIMEOUT_MS, dispatcher}) {
  const ws = new WebSocket(gatewayUrl(accessToken), {
    headers: {origin: "https://www.meta.ai", "user-agent": SIMULATED_BROWSER.agent},
    dispatcher,
  });
  ws.binaryType = "arraybuffer";

  const queue = [];
  let failure = null;
  let wake = null;
  let markSent;
  let markFailed;
  const sent = new Promise((resolve, reject) => {
    markSent = resolve;
    markFailed = reject;
  });
  const notify = () => {
    const w = wake;
    wake = null;
    if (w) w();
  };
  const fail = (err) => {
    if (!failure) failure = err;
    markFailed(failure);
    notify();
  };

  ws.onopen = () => {
    const headers = Buffer.from(JSON.stringify({
      "x-dgw-app-x-ecto-conversation-id": conversationId,
      "x-dgw-app-client-payload-type": "PROTO_INSIDE_JSON",
    }));
    ws.send(buildFrame(FRAME.ESTAB_STREAM, headers));
  };
  ws.onmessage = (event) => {
    const frame = parseFrame(Buffer.from(event.data));
    if (frame.type === FRAME.ESTAB_STREAM) {
      let code = null;
      try {
        code = JSON.parse(frame.body.toString("utf8")).code;
      } catch {}
      if (code !== 200) {
        fail(new Error(`dgw: gateway refused the stream (code ${code}) — the access token may be expired`));
        return;
      }
      const envelope = JSON.stringify({"req-id": requestId, payload: payload.toString("base64")});
      ws.send(buildDataFrame(Buffer.from(envelope)));
      markSent();
    } else if (frame.type === FRAME.DATA) {
      queue.push(frame.body.subarray(2));
      notify();
    } else if (frame.type === FRAME.DEAUTH) {
      fail(new Error("dgw: gateway de-authenticated the socket — the access token is expired or invalid"));
    } else if (frame.type === FRAME.DRAIN) {
      fail(new Error("dgw: gateway is draining this socket — retry the turn"));
    }
    // PONG / ACK / END_OF_DATA carry nothing we need.
  };
  ws.onerror = (event) => {
    const detail = (event && (event.message || (event.error && event.error.message))) || "connection failed";
    fail(new Error(`dgw: socket error — ${detail}`));
  };
  ws.onclose = (event) =>
    fail(
      new Error(
        event.code === 4003
          ? "dgw: gateway rejected the access token (close 4003) — it is expired or invalid"
          : `dgw: socket closed (code ${event.code}) before the turn finished`
      )
    );

  const pinger = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(Buffer.from([FRAME.PING]));
  }, PING_INTERVAL_MS);
  const deadline =
    timeoutMs > 0 ? setTimeout(() => fail(new Error(`dgw: turn timed out after ${timeoutMs}ms`)), timeoutMs) : null;
  const cleanup = () => {
    clearInterval(pinger);
    clearTimeout(deadline);
    try {
      ws.close();
    } catch {}
  };

  try {
    await sent;
  } catch (err) {
    cleanup();
    throw err;
  }

  async function* chunks() {
    try {
      for (;;) {
        if (queue.length) {
          yield queue.shift();
          continue;
        }
        if (failure) throw failure;
        await new Promise((resolve) => (wake = resolve));
      }
    } finally {
      cleanup();
    }
  }
  return chunks();
}

module.exports = {openTurn, buildFrame, parseFrame, buildDataFrame, FRAME};
