const {randomUUID} = require("crypto");
const {BaseChat} = require("./BaseChat");
const {graphql, DOC_IDS} = require("../http/graphql");

// Logged-out chat. meta.ai lets anyone chat without an account: the page calls
// the `createTempUser` mutation, which needs no cookies at all and returns an
// `ecto1:` access token plus a temporary user id. That token then
// authenticates the DGW socket exactly like a logged-in one, with the request
// marked USER_TYPE_LOGGED_OUT / "Abra Web Temp User Key".
//
// One instance = one temp user, created on the first complete() and reused
// after (like one browser tab). Logged out, the model answers text only —
// image requests come back as prose without an image.
class AnonChat extends BaseChat {
  constructor({mode} = {}) {
    super({mode});
    this._identity = null;
  }

  // Become a different anonymous visitor.
  resetSession() {
    this._identity = null;
    this._conversations.clear();
    this._sessionId = randomUUID();
  }

  async _getIdentity({refresh = false} = {}) {
    if (this._identity && !refresh) return this._identity;
    const data = await graphql(DOC_IDS.createTempUser, {});
    const user = data && data.createTempUser;
    if (!user || !user.success || !user.accessToken || !user.abraUserId) {
      throw new Error(
        `createTempUser failed: ${(user && (user.errorType || user.errorMessage)) || "no access token in response"}`
      );
    }
    this._identity = {userId: user.abraUserId, accessToken: user.accessToken, loggedOut: true};
    return this._identity;
  }
}

module.exports = {AnonChat};
