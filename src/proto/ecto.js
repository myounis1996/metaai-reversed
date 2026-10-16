// The two protobuf messages meta.ai's chat runs on: `clippy.ecto.Request`
// (client → gateway) and `clippy.ecto.Response` (gateway → client, one per
// streamed chunk). Field numbers come from the FileDescriptorProtos embedded in
// the web bundle (`ecto_request_client.proto` / `ecto_response_client.proto`,
// read 2026-10-16) — not guessed from captures. Every value below was then
// checked against a request the real web client sent.
//
// Only the fields the web composer actually fills are built. The schema has
// many more (developer overrides, system-prompt overrides, integrity-check
// toggles…) that the server ignores or rejects for normal accounts.

const {randomInt} = require("crypto");
const {encode, decode, get, getMessage, getString, getBool} = require("./wire");

// Constants hardcoded in the web bundle's request serializer.
const APP_ID = "1522763855472543"; // ProductContext.app_id — also the DGW x-dgw-appid
const CONFIG_KEY = "5a5b-8d4e-f054-99ef-b2de-db02-0d05-52c7";
const PERSONA_ID = "867051314767696"; // the Meta AI persona (id and version are the same value)
const BLOKS_VERSIONING_ID = "467ac00fac43b3f1e9b4405009b6a555e912c23d79e8c7f9bf1f2b668bec3fa3";
const INLINE_CAPABILITIES = ["stocks", "weather", "meta_knowledge_search_carousel", "meta_catalog_search_carousel", "media_gallery"];
// The home composer starts a conversation; the in-thread composer continues one.
const ENTRY_POINT_NEW = "KADABRA__HOME__UNIFIED_INPUT_BAR";
const ENTRY_POINT_FOLLOW_UP = "KADABRA__CHAT__UNIFIED_INPUT_BAR";

// Enum values (ecto_request_client.proto).
const APP_TYPE_ECTO_1 = 5;
const USER_TYPE_EXTERNAL = 2;
const USER_TYPE_LOGGED_OUT = 6;
const CLIENT_CAPABILITY_JSON_PATCH = 3;
const CLIENT_CAPABILITY_CLIENT_TOOL = 5;
const THINKING_LEVEL_STANDARD = 1;
const ATTACHMENT_TYPE = {image: 1, file: 2, video: 3, audio: 4};

// Facebook "offline threading id": ms timestamp in the high bits, 22 random low
// bits. The client mints one per user message (MessageId.unique_message_id);
// the bot's reply id is the next integer.
function offlineThreadingId(nowMs = Date.now()) {
  return (BigInt(nowMs) << 22n) | BigInt(randomInt(0, 1 << 22));
}

// mode: an entry of MODES (src/models.js).
// conversation: {id, sessionId, lastEventId, branchPath} — lastEventId and
//   branchPath come from the previous turn's final Response; both are null on
//   the first turn.
// attachments: [{mediaId, kind, mimeType, filename}] from uploadAttachment().
function buildRequest({
  userId,
  loggedOut,
  conversation,
  requestId,
  turnId,
  qplJoinId,
  message,
  mode,
  attachments = [],
  browser,
  nowMs = Date.now(),
}) {
  const isNew = !conversation.lastEventId;
  const account = BigInt(userId);
  // The composer refers to each attachment inline by index; with no inline
  // marker in the text it prefixes them all, which is what we do.
  const content = attachments.map((_, i) => `<|attachment:${i}|> `).join("") + message;

  const productContext = [
    [1, isNew ? ENTRY_POINT_NEW : ENTRY_POINT_FOLLOW_UP], // entry_point
    [2, APP_ID],
    [4, CONFIG_KEY],
    [5, [[5, [[1, conversation.id]]]]], // product_data.meta_ai_product_data.conversation_id
    [6, APP_TYPE_ECTO_1],
    [7, "HUMAN_AGENT"], // bot_chat_type
    [8, [[1, PERSONA_ID], [2, PERSONA_ID]]], // persona
    [10, "ECTO1"], // app_name
    [11, loggedOut ? "Abra Web Temp User Key" : "Abra Web Main Key"], // client_name
    [12, [ // product_config
      [3, [[1, mode.agentTypeValue], [2, mode.agentType]]], // agent_config
      isNew ? [4, [[1, true]]] : undefined, // response_config.generate_conversation_title
    ].filter(Boolean)],
    [13, browser.platform], // device_os
    [14, "user_input"], // prompt_type
    [15, browser.agent], // user_agent
    [16, "desktop_web"], // client_interface
    [19, [[1, BLOKS_VERSIONING_ID], [2, {float: 1}]]], // bloks_rendering_context (pixel_density 1)
  ];

  const metadata = [
    [1, productContext],
    [2, [[1, account], [2, account], [3, loggedOut ? USER_TYPE_LOGGED_OUT : USER_TYPE_EXTERNAL]]], // user_ids
    [3, [[4, true]]], // traffic_control.is_dgw_request
    [4, []], // auth_context (empty — auth rides on the socket URL)
    [5, [[1, nowMs], [3, nowMs]]], // trace_context
    [6, requestId],
    [7, mode.thinking ? [[12, true], [13, THINKING_LEVEL_STANDARD]] : []], // model_input_overrides
    [9, [[2, browser.language]]], // locale_info.user_locale
    [10, [[1, conversation.sessionId], [3, qplJoinId], [4, conversation.id]]], // conversation_context_ids
    [15, [[4, browser.timezone]]], // location_data.client_timezone
    [16, [[22, true]]], // clippy_overrides.writes_enabled_via_node_api_for_cp
    ...INLINE_CAPABILITIES.map((key) => [18, [[1, key], [2, [[1, 1]]]]]), // inline_capabilities map, version 1
    [20, Buffer.from([CLIENT_CAPABILITY_JSON_PATCH])], // client_capabilities (packed)
    [23, [[1, CLIENT_CAPABILITY_CLIENT_TOOL], [3, "blocking_confirmation"]]], // client_capability_configs
    [26, 0], // meta_subs_client_signal UNSPECIFIED
  ];

  const promptId = [
    [1, turnId], // identifier
    [2, [[1, conversation.id], [2, nowMs], [3, offlineThreadingId(nowMs)]]], // mid
    conversation.lastEventId ? [4, conversation.lastEventId] : undefined, // last_known_event_id
    isNew ? [5, true] : undefined, // is_new_conversation
  ].filter(Boolean);

  const prompt = [
    [1, promptId],
    [2, content],
    ...attachments.map((a) => [3, [
      [1, [[1, BigInt(a.mediaId)]]], // id.fbid
      [2, ATTACHMENT_TYPE[a.kind] || ATTACHMENT_TYPE.file],
      [3, []], // urls — empty; the server resolves the fbid
      [5, 0], // location UNSPECIFIED
      [6, a.mimeType],
      [7, a.filename],
    ]]),
    [4, [[1, conversation.branchPath || "0"]]], // prompt_edit_config.current_branch_path
  ];

  return encode([[1, metadata], [2, prompt]]);
}

// ResponsePiece is a oneof; for each variant that carries the UI state, the
// field number of its `raw_unified_response` (a JSON string — either the whole
// response, or a JSON-patch against it).
const RAW_UNIFIED_FIELD = {
  4: 10, // model_response
  5: 4, // reasoning_response
  8: 9, // inline_response
  11: 5, // client_tool_input_request
};
const PIECE_ERROR = 10;
const ERROR_CODES = ["UNKNOWN", "LOGGED_OUT_BLOCKED", "GLOBAL_RATE_LIMITED", "PROMPT_GUARD_BLOCKED"];

// Decode one Response chunk into the handful of fields the client needs.
function readResponse(bytes) {
  const res = decode(bytes);
  const piece = getMessage(res, 1) || [];
  let raw = null;
  let error = null;
  for (const [variant, rawField] of Object.entries(RAW_UNIFIED_FIELD)) {
    const body = getMessage(piece, Number(variant));
    if (body) raw = getString(body, rawField);
  }
  const err = getMessage(piece, PIECE_ERROR);
  if (err) {
    const code = Number(get(err, 2) || 0n);
    error = {message: getString(err, 1) || "", code: ERROR_CODES[code] || String(code)};
  }
  const branch = getMessage(res, 10);
  const asyncMeta = getMessage(res, 9);
  return {
    isFinal: getBool(res, 3), // is_final_chunk — the turn is over
    responseId: getString(res, 4),
    raw,
    error,
    title: asyncMeta ? getString(asyncMeta, 1) : null,
    branchPath: branch ? getString(branch, 2) : null, // response_branch_path
    lastEventId: getString(res, 12),
  };
}

module.exports = {buildRequest, readResponse, offlineThreadingId, APP_ID};
