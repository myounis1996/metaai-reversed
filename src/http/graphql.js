const {buildBrowserHeaders} = require("./browser");

const GRAPHQL_ENDPOINT = "https://www.meta.ai/api/graphql";

// Relay persisted-query ids, read from the web bundle on 2026-10-16
// (`params:{id, name, operationKind}`). The id is a hash of the query text, so
// it rotates whenever Meta changes that query; a stale one fails with a
// GraphQL error naming the document, not a 404.
const DOC_IDS = {
  createTempUser: "128302cfa314f375be53f53a266699fd", // useCreateTempUserMutation
  listConversations: "f9f2f515cf675e127f619401193b6992", // EctoConversationListWithPaginationRouterQuery
  deleteConversation: "ad35bda8475e29ba4264ef0d6cc0958a", // useEctoDeleteConversationMutation
};

// POST one persisted query. Returns `data`; throws on HTTP or GraphQL errors.
// Logged-in calls authenticate with cookies alone — no token header.
async function graphql(docId, variables = {}, {cookie} = {}) {
  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      ...buildBrowserHeaders({accept: "application/json"}),
      "content-type": "application/json",
      ...(cookie ? {cookie} : {}),
    },
    body: JSON.stringify({doc_id: docId, variables}),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  const firstError = json && Array.isArray(json.errors) && json.errors[0];
  if (!response.ok || !json || firstError) {
    const detail = firstError ? firstError.message : text.slice(0, 200);
    throw new Error(`graphql ${docId} failed: ${response.status} — ${detail}`);
  }
  return json.data;
}

module.exports = {graphql, DOC_IDS, GRAPHQL_ENDPOINT};
