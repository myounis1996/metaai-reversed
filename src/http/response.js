// Turns the stream of Response chunks into text.
//
// meta.ai does not stream tokens; it streams UI state. Each chunk's
// `raw_unified_response` is one of:
//   {"seq":N, "type":"full",  "response":{…}}       replace the whole document
//   {"seq":N, "type":"patch", "operations":[…]}     JSON-patch it
//   {"response_id":…, "sections":[…], …}            the final document, bare
// Patch ops seen live: add / replace / remove (RFC 6902) plus a non-standard
// `delta`, which appends a string to the value at `path`.
//
// The document is a list of `sections`, each a typed primitive:
//   GenAIMarkdownTextUXPrimitive     answer prose (markdown); inline entities
//                                    {{IE_n}}…{{/IE_n}} (citations, inline
//                                    math) resolved via its `inline_entities`
//   GenAICodeUXPrimitive             a code block (syntax-token list)
//   GenATableUXPrimitive             a table (sic — no "I" in the typename)
//   GenAILatexUXPrimitive            display math
//   GenAIImagePrimitive              a generated image
//   GenAIClippyFollowUpPrimitive     a suggested follow-up prompt
//   GenAIBotThinkingStatusPrimitive  the "Show thinking" header
// and the reasoning steps live under
//   embedded_screens[].content[].tabs[].step_entries[] {header, body}
// Text is rendered back to one markdown string; the ~50 widget primitives
// (weather, sports, maps, charts…) are not text and are skipped.
//
// Streaming needs a rendering that only ever grows at the end, so mid-stream
// renderText({final:false}) holds back the parts that would later change in
// place: a code/table/math block until the next section starts, and prose from
// the first inline entity whose description has not arrived yet.

function applyPatch(doc, {op, path, value}) {
  const keys = String(path).split("/").slice(1).map((k) => k.replace(/~1/g, "/").replace(/~0/g, "~"));
  const last = keys.pop();
  let parent = doc;
  for (const key of keys) {
    if (parent == null || typeof parent !== "object") return;
    parent = parent[key];
  }
  // ponytail: a patch against a path we never saw is dropped, not fatal — the
  // final chunk carries the whole document and overwrites any drift.
  if (parent == null || typeof parent !== "object") return;
  const index = last === "-" ? parent.length : Number(last);
  if (op === "add") {
    if (Array.isArray(parent)) parent.splice(index, 0, value);
    else parent[last] = value;
  } else if (op === "replace") {
    parent[Array.isArray(parent) ? index : last] = value;
  } else if (op === "remove") {
    if (Array.isArray(parent)) parent.splice(index, 1);
    else delete parent[last];
  } else if (op === "delta") {
    const key = Array.isArray(parent) ? index : last;
    parent[key] = (typeof parent[key] === "string" ? parent[key] : "") + value;
  }
}

const primitives = (doc) =>
  ((doc && doc.sections) || []).map((s) => s && s.view_model && s.view_model.primitive).filter(Boolean);

const MARKDOWN = "GenAIMarkdownTextUXPrimitive";
// Inline entity: {{IE_n}}fallback text{{/IE_n}}, described by inline_entities[key=IE_n].
const INLINE_ENTITY = /\{\{(IE_\d+)\}\}([\s\S]*?)\{\{\/\1\}\}/g;
// Prose that can still be rewritten in place: an inline entity opened but not
// closed (or a partial `{{IE_` at the very end), and display math / fenced
// code — the server streams `$$…` as plain markdown, then replaces it with a
// GenAILatexUXPrimitive block (seen live).
const UNSTABLE_PROSE = /\{\{IE_\d+\}\}|\$\$|```|\{(?:\{(?:I(?:E(?:_\d*\}?)?)?)?)?$/;

const cellText = (cell) => String((cell && cell.text) ?? cell ?? "").replace(/(?<!\\)\|/g, "\\|").replace(/\n/g, " ");

const BLOCK_RENDERERS = {
  GenAICodeUXPrimitive: (p) =>
    "```" + (p.language || "") + "\n" + (p.code_blocks || []).map((b) => b.content || "").join("") + "\n```",
  GenAILatexUXPrimitive: (p) => (p.latex_expression ? `$$\n${p.latex_expression}\n$$` : null),
  GenATableUXPrimitive: (p) => {
    const rows = (p.rows || []).map((r) => (r.markdown_cells || r.cells || []).map(cellText));
    if (rows.length === 0) return null;
    const width = Math.max(...rows.map((r) => r.length));
    const line = (r) => "| " + Array.from({length: width}, (_, i) => r[i] || "").join(" | ") + " |";
    return [line(rows[0]), "|" + " --- |".repeat(width), ...rows.slice(1).map(line)].join("\n");
  },
};

// Seen live: GenAISearchCitationItem (a web source) and GenAILatexItem (inline
// math, whose fallback text is already `$…$`). Anything else keeps its fallback.
function renderEntity(meta, fallback) {
  if (meta.reference_url) return `[${meta.reference_id ?? "source"}](${meta.reference_url})`;
  if (meta.latex_expression) return `$${meta.latex_expression}$`;
  return fallback;
}

// → {text, held}: `held` = the rest of this section (and everything after it)
// is not stable yet.
function renderMarkdown(p, final) {
  const source = typeof p.text === "string" ? p.text : "";
  const entities = new Map((p.inline_entities || []).map((e) => [e.key, e.metadata || {}]));
  let out = "";
  let pos = 0;
  for (const m of source.matchAll(INLINE_ENTITY)) {
    const meta = entities.get(m[1]);
    if (!meta && !final) return {text: out + source.slice(pos, m.index), held: true};
    // A marker whose entity never arrives (seen logged out) is dropped.
    out += source.slice(pos, m.index) + (meta ? renderEntity(meta, m[2]) : "");
    pos = m.index + m[0].length;
  }
  const text = out + source.slice(pos);
  const cut = final ? -1 : text.search(UNSTABLE_PROSE);
  return cut === -1 ? {text, held: false} : {text: text.slice(0, cut), held: true};
}

class ResponseState {
  constructor() {
    this.doc = null;
  }

  // Fold one raw_unified_response string in. Returns false if it wasn't JSON.
  apply(raw) {
    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      return false;
    }
    if (json.type === "full" && json.response) this.doc = json.response;
    else if (json.type === "patch" && Array.isArray(json.operations)) {
      if (!this.doc) this.doc = {};
      for (const op of json.operations) applyPatch(this.doc, op);
    } else if (json.sections) this.doc = json;
    return true;
  }

  get text() {
    return this.renderText({final: true});
  }

  renderText({final = true} = {}) {
    const blocks = primitives(this.doc).filter((p) => p.__typename === MARKDOWN || BLOCK_RENDERERS[p.__typename]);
    const parts = [];
    for (let i = 0; i < blocks.length; i++) {
      const p = blocks[i];
      if (p.__typename === MARKDOWN) {
        const {text, held} = renderMarkdown(p, final);
        if (text) parts.push(text);
        if (held) break;
      } else {
        // A block streams in place, and can exist before its content does
        // (math gets its expression after the section is created): hold it
        // until a later section starts and it has content.
        const text = BLOCK_RENDERERS[p.__typename](p);
        if (!final && (i === blocks.length - 1 || !text)) break;
        if (text) parts.push(text);
      }
    }
    return parts.join("\n\n");
  }

  // Web sources the answer cites: [{id, url, title, site}], in citation order.
  get citations() {
    const seen = new Map();
    for (const p of primitives(this.doc)) {
      for (const entity of (p.__typename === MARKDOWN && p.inline_entities) || []) {
        const m = entity.metadata || {};
        if (m.reference_url && !seen.has(m.reference_url)) {
          seen.set(m.reference_url, {
            id: m.reference_id ?? null,
            url: m.reference_url,
            title: m.reference_title || null,
            site: m.reference_display_name || null,
          });
        }
      }
    }
    return [...seen.values()];
  }

  get thinking() {
    const steps = [];
    for (const screen of (this.doc && this.doc.embedded_screens) || []) {
      for (const content of screen.content || []) {
        for (const tab of content.tabs || []) {
          for (const step of tab.step_entries || []) {
            if (step && typeof step.body === "string") steps.push({header: step.header || "", body: step.body});
          }
        }
      }
    }
    return steps;
  }

  get images() {
    return primitives(this.doc)
      .filter((p) => p.__typename === "GenAIImagePrimitive" && (p.full_image || p.preview_image))
      .map((p) => {
        const img = p.full_image || p.preview_image;
        return {
          url: img.url,
          mediaId: img.media_id || null,
          mimeType: img.mime_type || null,
          width: img.width || null,
          height: img.height || null,
          previewUrl: (p.preview_image && p.preview_image.url) || null,
          suggestions: (p.follow_up_pills || []).map((pill) => pill.prompt_text).filter(Boolean),
        };
      });
  }

  get followUps() {
    return primitives(this.doc)
      .filter((p) => p.__typename === "GenAIClippyFollowUpPrimitive" && p.prompt_text)
      .map((p) => p.prompt_text);
  }
}

module.exports = {ResponseState, applyPatch};
