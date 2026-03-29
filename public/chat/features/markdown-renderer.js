function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// Safe fallback renderer when third-party markdown libraries are not available.
// It preserves line breaks while still escaping HTML content.
function fallbackMarkdown(text) {
  return `<p>${escapeHtml(text).replaceAll("\n", "<br>")}</p>`;
}

// Renders markdown with defense-in-depth:
// 1) Parse markdown using marked
// 2) Sanitize resulting HTML using DOMPurify
// 3) Fallback to escaped text if dependencies are not loaded
export function renderMarkdown(text) {
  const source = typeof text === "string" ? text : "";
  if (!source.trim()) {
    return "";
  }

  if (window.marked && window.DOMPurify) {
    const html = window.marked.parse(source, {
      gfm: true,
      breaks: true
    });

    return window.DOMPurify.sanitize(html, {
      USE_PROFILES: {
        html: true
      }
    });
  }

  return fallbackMarkdown(source);
}
