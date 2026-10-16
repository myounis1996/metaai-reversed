const {BaseChat} = require("./BaseChat");
const {CookieJar} = require("../auth/CookieJar");
const {buildBrowserHeaders} = require("../http/browser");
const {graphql, DOC_IDS} = require("../http/graphql");

const HOME_URL = "https://www.meta.ai/";

// Logged-in base. Cookies (`datr` + `ecto_1_sess`) authenticate the HTML and
// GraphQL endpoints directly; the DGW socket instead wants an `ecto1:` access
// token, which the server renders into the home page's RSC payload next to the
// viewer id:  …{"viewerId":"<fbid>","accessToken":"ecto1:…"}…
// So identity = one GET of https://www.meta.ai/ with the cookies. Cached per
// instance and re-fetched when a turn fails to open.
class AuthBase extends BaseChat {
  constructor({cookies, cookiesPath, mode} = {}) {
    super({mode});
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
    const response = await fetch(HOME_URL, {
      headers: {
        ...buildBrowserHeaders({accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"}),
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "none",
        "upgrade-insecure-requests": "1",
        cookie: this._cookies.toHeader(),
      },
    });
    this._cookies.absorb(response.headers.getSetCookie());
    const html = await response.text();
    // Quotes are backslash-escaped inside the RSC string; match both forms.
    const token = html.match(/\\?"accessToken\\?":\\?"(ecto1:[^"\\]+)/);
    const viewer = html.match(/\\?"viewerId\\?":\\?"(\d+)/);
    if (!response.ok || !token || !viewer) {
      throw new Error(
        `meta.ai served no access token (HTTP ${response.status}) — cookies may be expired or not logged in. ` +
          "Re-export cookies.json from a logged-in meta.ai tab."
      );
    }
    this._identity = {userId: viewer[1], accessToken: token[1], loggedOut: false};
    return this._identity;
  }

  // The account's history sidebar: [{id, title, updatedAt, pinned}].
  // ponytail: first page only (what the sidebar loads); add cursor paging when
  // someone needs more than that.
  async listConversations() {
    const data = await graphql(DOC_IDS.listConversations, {}, {cookie: this._cookies.toHeader()});
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
      {cookie: this._cookies.toHeader()}
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
