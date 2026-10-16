// The composer's mode picker. meta.ai has no model slug to choose — the page
// ships a `modes` list (in the server-rendered HTML, read 2026-10-16) and each
// mode maps to an agent type the request carries in
// ProductContext.product_config.agent_config:
//
//   id          label      agentType       agentTypeValue  thinking
//   think_fast  Instant    MODE_FAST       1000            no
//   think_hard  Thinking   mode_thinking   1001            yes (ThinkingLevel STANDARD)
//
// Which model answers is decided server-side. On 2026-10-16 both modes
// introduced themselves as "Muse Spark 1.1" when logged in; logged out it
// declines to say.

const MODES = {
  instant: {id: "think_fast", label: "Instant", agentType: "MODE_FAST", agentTypeValue: 1000, thinking: false},
  thinking: {id: "think_hard", label: "Thinking", agentType: "mode_thinking", agentTypeValue: 1001, thinking: true},
};

function resolveMode(mode = "instant") {
  const key = String(mode).toLowerCase();
  const found = MODES[key] || Object.values(MODES).find((m) => m.id === key);
  if (!found) {
    throw new Error(`Unknown mode ${JSON.stringify(mode)} — use one of: ${Object.keys(MODES).join(", ")}`);
  }
  return found;
}

module.exports = {MODES, resolveMode};
