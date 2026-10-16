const {AnonChat} = require("./clients/AnonChat");
const {AuthChat} = require("./clients/AuthChat");
const {AuthImageGen, ImageGenRefusalError} = require("./clients/AuthImageGen");
const {AuthBase} = require("./clients/AuthBase");
const {BaseChat} = require("./clients/BaseChat");
const {CookieJar} = require("./auth/CookieJar");
const {MODES} = require("./models");
const {buildRequest, readResponse} = require("./proto/ecto");
const {openTurn} = require("./http/dgw");
const {ResponseState} = require("./http/response");
const {uploadAttachment} = require("./http/upload");

module.exports = {
  // Primary clients — every turn rides the DGW socket at gateway.meta.ai
  AnonChat,
  AuthChat,
  AuthImageGen,
  // Errors / abstract bases / helpers
  ImageGenRefusalError,
  AuthBase,
  BaseChat,
  CookieJar,
  // The composer's mode picker: instant | thinking
  MODES,
  // Low-level machinery (for building custom flows)
  buildRequest, // clippy.ecto.Request protobuf
  readResponse, // one clippy.ecto.Response chunk → {raw, isFinal, error, …}
  openTurn, // DGW socket: send one Request, iterate Response chunks
  ResponseState, // folds full/patch chunks into text, thinking, images
  uploadAttachment, // rupload → {mediaId, …}
};
