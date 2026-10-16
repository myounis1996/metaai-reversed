const {AuthBase} = require("./AuthBase");

// Thrown when the turn finishes without an image: a policy refusal, or the
// model decided to ask a clarifying question instead.
class ImageGenRefusalError extends Error {
  constructor(text, response) {
    super(`no image came back — the model answered with text instead: ${String(text).slice(0, 200)}`);
    this.name = "ImageGenRefusalError";
    this.text = text;
    this.response = response;
  }
}

// Image generation is not a separate endpoint on meta.ai: the chat model calls
// its `imagine` tool when the prompt asks for a picture, and the image arrives
// as a GenAIImagePrimitive section of the normal answer. So generate() is a
// chat turn that insists on an image. There is no image-model or size knob to
// send — the web client has none either. Orientation goes in the prompt, and
// the model honours it (measured 2026-10-16): default 1920x1280,
// "portrait 9:16" 1152x2048, "landscape 16:9" 2048x1152, "square 1:1" 1600x1600.
class AuthImageGen extends AuthBase {
  // Options: download (attach image.bytes), keepConversation (default false —
  // the conversation is deleted from history after the images are read),
  // mode, timeoutMs, onEvent, onThinking — as AuthChat.complete().
  async generate(prompt, options = {}) {
    if (typeof prompt !== "string" || !prompt.trim()) {
      throw new Error("generate() needs a non-empty prompt string");
    }
    // A bare description ("a lighthouse in rain") is often just described back.
    const asked = /^\s*(imagine|create|generate|draw|make|paint|render)\b/i.test(prompt) ? prompt : `Imagine ${prompt}`;
    const text = await this.complete(asked, {...options, stream: false, files: undefined});
    const response = this.lastResponse;
    const {images} = response;

    if (options.download) {
      await Promise.all(
        images.map(async (image) => {
          const res = await fetch(image.url);
          if (!res.ok) throw new Error(`image download failed: ${res.status} ${res.statusText}`);
          image.bytes = Buffer.from(await res.arrayBuffer());
        })
      );
    }
    let deleted = false;
    if (!options.keepConversation) {
      deleted = await this.deleteConversation(response.conversationId).catch(() => false);
    }
    if (images.length === 0) throw new ImageGenRefusalError(text, response);

    return {
      prompt,
      conversationId: response.conversationId,
      images,
      text,
      followUps: response.followUps,
      deleted,
    };
  }
}

module.exports = {AuthImageGen, ImageGenRefusalError};
