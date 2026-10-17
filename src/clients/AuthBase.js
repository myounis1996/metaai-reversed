const {BaseChat} = require("./BaseChat");
const {CookieJar} = require("../auth/CookieJar");
const {buildBrowserHeaders} = require("../http/browser");
const {graphql, DOC_IDS} = require("../http/graphql");

const HOME_URL = "https://www.meta.ai/";
// meta.ai's bot check. Datacenter and proxy IPs (never home ones, so far) get a
// 403 page whose only script POSTs to /__rd_verify_<token>?challenge=N and
// reloads; that POST sets an `rd_challenge` cookie (a day, Domain=meta.ai) the
// reload then carries. Measured 2026-10-17. GraphQL never serves the page.
const CHALLENGE = /\/__rd_verify_[^'"\s]*/;

// Logged-in base. Cookies (`datr` + `ecto_1_sess`) authenticate the HTML and
// GraphQL endpoints directly; the DGW socket instead wants an `ecto1:` access
// token, which the server renders into the home page's RSC payload next to the
// viewer id:  …{"viewerId":"<fbid>","accessToken":"ecto1:…"}…
// So identity = one GET of https://www.meta.ai/ with the cookies (three when
// the bot check answers first). Cached per instance and re-fetched when a turn
// fails to open.
class AuthBase extends BaseChat {
  constructor({cookies, cookiesPath, mode, dispatcher} = {}) {
    super({mode, dispatcher});
    if (new.target === AuthBase) {
      throw new Error("AuthBase is abstract — instantiate AuthChat or AuthImageGen");
    }
    this._cookies = CookieJar.resolve({cookies, cookiesPath});
    if (!this._cookies.has("ecto_1_sess")) {
      throw new Error(
        "cookies have no `ecto_1_sess` — export them from a browser tab where meta.ai is logged in"
      );
    }
    this._identity = null;
  }

  get cookies() {
    return this._cookies;
  }

  async _getIdentity({refresh = false} = {}) {
    if (this._identity && !refresh) return this._identity;
    const headers = {
      ...buildBrowserHeaders({accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"}),
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "none",
      "upgrade-insecure-requests": "1",
    };
    const load = async (url, method = "GET") => {
      const response = await fetch(url, {
        method,
        headers: {...headers, cookie: this._cookies.toHeader()},
        dispatcher: this._dispatcher,
      });
      this._cookies.absorb(response.headers.getSetCookie());
      return [response, await response.text()];
    };
    let [response, html] = await load(HOME_URL);
    // The bot check: do what its script does, once — POST, keep the cookie,
    // load the page again.
    const challenge = response.status === 403 && html.match(CHALLENGE);
    if (challenge) {
      await load(new URL(challenge[0], HOME_URL), "POST");
      [response, html] = await load(HOME_URL);
    }
    // Quotes are backslash-escaped inside the RSC string; match both forms.
    const token = html.match(/\\?"accessToken\\?":\\?"(ecto1:[^"\\]+)/);
    const viewer = html.match(/\\?"viewerId\\?":\\?"(\d+)/);
    if (!response.ok || !token || !viewer) {
      const why =
        challenge && CHALLENGE.test(html)
          ? "its bot check (/__rd_verify_) answered again after one pass; it wants more than a cookie now"
          : "cookies may be expired or not logged in. Re-export cookies.json from a logged-in meta.ai tab.";
      throw new Error(`meta.ai served no access token (HTTP ${response.status}) — ${why}`);
    }
    this._identity = {userId: viewer[1], accessToken: token[1], loggedOut: false};
    return this._identity;
  }

  // The account's history sidebar: [{id, title, updatedAt, pinned}].
  // ponytail: first page only (what the sidebar loads); add cursor paging when
  // someone needs more than that.
  async listConversations() {
    const data = await graphql(
      DOC_IDS.listConversations,
      {},
      {cookie: this._cookies.toHeader(), dispatcher: this._dispatcher}
    );
    const edges = [
      ...((data.pinnedConversations && data.pinnedConversations.edges) || []),
      ...((data.unpinnedConversations && data.unpinnedConversations.edges) || []),
    ];
    return edges.map(({node}) => ({
      id: node.conversationId || node.id,
      title: node.displayTitle || node.title || null,
      updatedAt: node.updatedAt || null,
      pinned: Boolean(node.pinned),
    }));
  }

  async deleteConversation(conversationId) {
    if (!conversationId) throw new Error("deleteConversation requires a conversationId");
    const data = await graphql(
      DOC_IDS.deleteConversation,
      {input: {id: conversationId}},
      {cookie: this._cookies.toHeader(), dispatcher: this._dispatcher}
    );
    const result = data && data.deleteConversation;
    if (!result || !result.success) {
      throw new Error(`deleteConversation failed: ${JSON.stringify(result)}`);
    }
    this._conversations.delete(conversationId);
    return true;
  }
}

module.exports = {AuthBase};
