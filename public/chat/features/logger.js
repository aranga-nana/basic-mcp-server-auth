function nowTime() {
  const date = new Date();
  return date.toLocaleTimeString("en-US", { hour12: false });
}

// Creates a lightweight logger that writes structured debug entries into
// the dev console panel used by the chat UI.
export function createDevLogger(devLogElement) {
  return {
    log(scope, message, details) {
      if (!devLogElement) {
        return;
      }

      const lines = [`[${nowTime()}] [${scope}] ${message}`];
      if (details !== undefined) {
        try {
          lines.push(JSON.stringify(details, null, 2));
        } catch {
          lines.push(String(details));
        }
      }

      devLogElement.textContent += `${lines.join("\n")}\n\n`;
      devLogElement.scrollTop = devLogElement.scrollHeight;
    }
  };
}
