// Shared browser chat configuration values.
// Keeping constants in one module avoids scattered magic strings.
export const chatApiBase = "/chat/api";
export const oauthCallbackPath = "/chat/oauth-callback.html";
export const sessionTokenKey = "enterprise-mcp-chat-token";
export const conversationMemoryKey = "enterprise-mcp-chat-memory";
export const maxRecentTurns = 6;
export const maxContextChars = 4000;
