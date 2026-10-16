const {AuthBase} = require("./AuthBase");

// Logged-in chat. Unlike AnonChat it can see images, generate them, and its
// conversations land in the account's meta.ai history (there is no temporary
// chat mode on meta.ai) — `deleteConversation(id)` removes one.
//
//   new AuthChat({cookiesPath: "./cookies.json", mode: "thinking"})
class AuthChat extends AuthBase {}

module.exports = {AuthChat};
