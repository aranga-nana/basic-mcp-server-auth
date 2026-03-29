function createTurn(role, text) {
  return {
    role,
    text,
    timestamp: Date.now()
  };
}

function summarizeTurns(turns) {
  if (!turns.length) {
    return "";
  }

  return turns
    .map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.text.replace(/\s+/g, " ").trim()}`)
    .join("\n");
}

export function createConversationMemoryStore(options) {
  const {
    storage,
    storageKey,
    maxRecentTurns,
    maxContextChars
  } = options;

  let state = {
    summary: "",
    turns: []
  };

  function compactSummary(summary) {
    if (summary.length <= maxContextChars) {
      return summary;
    }

    return summary.slice(summary.length - maxContextChars);
  }

  function save() {
    try {
      storage.setItem(storageKey, JSON.stringify(state));
    } catch {
      // Ignore session storage errors; memory stays available in runtime state.
    }
  }

  function load() {
    try {
      const raw = storage.getItem(storageKey);
      if (!raw) {
        state = { summary: "", turns: [] };
        return state;
      }

      const parsed = JSON.parse(raw);
      const summary = typeof parsed?.summary === "string" ? parsed.summary : "";
      const turns = Array.isArray(parsed?.turns)
        ? parsed.turns
            .filter((item) => item && (item.role === "user" || item.role === "assistant") && typeof item.text === "string")
            .map((item) => createTurn(item.role, item.text))
        : [];

      state = {
        summary,
        turns: turns.slice(-maxRecentTurns)
      };
      return state;
    } catch {
      state = { summary: "", turns: [] };
      return state;
    }
  }

  function addTurn(role, text) {
    const normalized = (text || "").trim();
    if (!normalized) {
      return;
    }

    state.turns.push(createTurn(role, normalized));

    // Roll over older turns into running summary to stay within request budget.
    if (state.turns.length > maxRecentTurns) {
      const overflow = state.turns.length - maxRecentTurns;
      const moved = state.turns.splice(0, overflow);
      const movedSummary = summarizeTurns(moved);
      if (movedSummary) {
        state.summary = compactSummary(state.summary ? `${state.summary}\n${movedSummary}` : movedSummary);
      }
    }

    save();
  }

  function buildContext() {
    const recent = summarizeTurns(state.turns);
    const parts = [];

    if (state.summary) {
      parts.push(`Running summary:\n${state.summary}`);
    }

    if (recent) {
      parts.push(`Recent turns:\n${recent}`);
    }

    return compactSummary(parts.join("\n\n"));
  }

  function clear() {
    state = { summary: "", turns: [] };
    save();
  }

  function snapshot() {
    return {
      summary: state.summary,
      turns: [...state.turns]
    };
  }

  return {
    load,
    addTurn,
    buildContext,
    clear,
    snapshot
  };
}
