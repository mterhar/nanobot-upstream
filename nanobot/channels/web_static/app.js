// ── Nanobot Web UI ──
// Pure vanilla JS — no build tools, no Node.js.

(function () {
  "use strict";

  // ── Elements ──
  const messagesEl = document.getElementById("messages");
  const inputEl    = document.getElementById("input");
  const formEl     = document.getElementById("chat-form");
  const sendBtn    = document.getElementById("btn-send");
  const statusEl   = document.getElementById("status");
  const newBtn     = document.getElementById("btn-new");

  // ── State ──
  let ws = null;
  let clientId = localStorage.getItem("nanobot_client_id") || null;
  let streamBubble = null;   // currently streaming bot message element
  let streamText   = "";     // accumulated raw markdown during stream
  let connected    = false;

  // ── Lightweight Markdown ──
  // Converts a subset of Markdown to HTML (code blocks, inline code, bold,
  // italic, links, headers, lists, blockquotes, tables).  Good enough for
  // chat — no external library needed.

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function renderMarkdown(src) {
    // Protect code blocks
    var blocks = [];
    src = src.replace(/```(\w*)\n?([\s\S]*?)```/g, function (_, lang, code) {
      blocks.push('<pre><code class="lang-' + escapeHtml(lang) + '">' + escapeHtml(code.replace(/\n$/, "")) + "</code></pre>");
      return "\x00CB" + (blocks.length - 1) + "\x00";
    });

    // Protect inline code
    var inlines = [];
    src = src.replace(/`([^`]+)`/g, function (_, code) {
      inlines.push("<code>" + escapeHtml(code) + "</code>");
      return "\x00IC" + (inlines.length - 1) + "\x00";
    });

    // Split into lines for block-level processing
    var lines = src.split("\n");
    var html = [];
    var inList = null; // "ul" | "ol" | null
    var inBlockquote = false;
    var tableRows = [];

    function flushList() {
      if (inList) { html.push("</" + inList + ">"); inList = null; }
    }
    function flushBlockquote() {
      if (inBlockquote) { html.push("</blockquote>"); inBlockquote = false; }
    }
    function flushTable() {
      if (tableRows.length === 0) return;
      var thead = tableRows[0];
      var tbody = tableRows.slice(2); // skip separator row
      var out = "<table><thead><tr>";
      thead.forEach(function (c) { out += "<th>" + processInline(c.trim()) + "</th>"; });
      out += "</tr></thead><tbody>";
      tbody.forEach(function (row) {
        out += "<tr>";
        row.forEach(function (c) { out += "<td>" + processInline(c.trim()) + "</td>"; });
        out += "</tr>";
      });
      out += "</tbody></table>";
      html.push(out);
      tableRows = [];
    }

    function processInline(s) {
      // Bold
      s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
      s = s.replace(/__(.+?)__/g, "<strong>$1</strong>");
      // Italic
      s = s.replace(/(?<![a-zA-Z0-9])\*([^*]+)\*(?![a-zA-Z0-9])/g, "<em>$1</em>");
      s = s.replace(/(?<![a-zA-Z0-9])_([^_]+)_(?![a-zA-Z0-9])/g, "<em>$1</em>");
      // Strikethrough
      s = s.replace(/~~(.+?)~~/g, "<del>$1</del>");
      // Links [text](url)
      s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
      return s;
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];

      // Code block placeholder — pass through
      if (/^\x00CB\d+\x00$/.test(line.trim())) {
        flushList(); flushBlockquote(); flushTable();
        var idx = parseInt(line.trim().replace(/\x00CB|\x00/g, ""), 10);
        html.push(blocks[idx]);
        continue;
      }

      // Table row (pipes)
      if (/^\s*\|.+\|/.test(line)) {
        flushList(); flushBlockquote();
        var cells = line.trim().replace(/^\||\|$/g, "").split("|");
        // Separator row?
        if (cells.every(function (c) { return /^[\s:-]+$/.test(c); })) {
          tableRows.push(cells); // keep as marker
        } else {
          tableRows.push(cells);
        }
        continue;
      } else {
        flushTable();
      }

      // Headers
      var hm = line.match(/^(#{1,6})\s+(.+)$/);
      if (hm) {
        flushList(); flushBlockquote();
        var level = hm[1].length;
        html.push("<h" + level + ">" + processInline(escapeHtml(hm[2])) + "</h" + level + ">");
        continue;
      }

      // Blockquote
      if (/^>\s?(.*)$/.test(line)) {
        flushList(); flushTable();
        if (!inBlockquote) { html.push("<blockquote>"); inBlockquote = true; }
        html.push(processInline(escapeHtml(line.replace(/^>\s?/, ""))) + "<br>");
        continue;
      } else {
        flushBlockquote();
      }

      // Unordered list
      if (/^[\s]*[-*+]\s+(.+)$/.test(line)) {
        flushBlockquote(); flushTable();
        if (inList !== "ul") { flushList(); html.push("<ul>"); inList = "ul"; }
        var content = line.replace(/^[\s]*[-*+]\s+/, "");
        html.push("<li>" + processInline(escapeHtml(content)) + "</li>");
        continue;
      }

      // Ordered list
      var olm = line.match(/^[\s]*(\d+)\.\s+(.+)$/);
      if (olm) {
        flushBlockquote(); flushTable();
        if (inList !== "ol") { flushList(); html.push("<ol>"); inList = "ol"; }
        html.push("<li>" + processInline(escapeHtml(olm[2])) + "</li>");
        continue;
      }

      flushList();

      // Empty line
      if (line.trim() === "") {
        continue;
      }

      // Normal paragraph
      html.push("<p>" + processInline(escapeHtml(line)) + "</p>");
    }

    flushList();
    flushBlockquote();
    flushTable();

    var result = html.join("\n");

    // Restore inline code
    inlines.forEach(function (repl, j) {
      result = result.replace("\x00IC" + j + "\x00", repl);
    });
    // Restore code blocks (any remaining in inline context)
    blocks.forEach(function (repl, j) {
      result = result.replace("\x00CB" + j + "\x00", repl);
    });

    return result;
  }

  // ── UI Helpers ──

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function setStatus(state) {
    statusEl.className = "status " + state;
    statusEl.textContent = state;
    connected = state === "connected";
    sendBtn.disabled = !connected;
  }

  function addMessage(role, content) {
    var el = document.createElement("div");
    el.className = "msg " + role;
    if (role === "bot") {
      var inner = document.createElement("div");
      inner.className = "rendered";
      inner.innerHTML = renderMarkdown(content);
      el.appendChild(inner);
    } else {
      el.textContent = content;
    }
    messagesEl.appendChild(el);
    scrollToBottom();
    return el;
  }

  function showThinking() {
    var el = document.createElement("div");
    el.className = "thinking";
    el.id = "thinking";
    el.innerHTML = 'Thinking<span class="dots"></span>';
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  function hideThinking() {
    var el = document.getElementById("thinking");
    if (el) el.remove();
  }

  function startStream() {
    hideThinking();
    streamText = "";
    var el = document.createElement("div");
    el.className = "msg bot streaming";
    var inner = document.createElement("div");
    inner.className = "rendered";
    el.appendChild(inner);
    messagesEl.appendChild(el);
    streamBubble = el;
    scrollToBottom();
  }

  function appendStream(delta) {
    if (!streamBubble) startStream();
    streamText += delta;
    var inner = streamBubble.querySelector(".rendered");
    inner.innerHTML = renderMarkdown(streamText);
    scrollToBottom();
  }

  function endStream(finalContent) {
    hideThinking();
    if (streamBubble) {
      streamBubble.classList.remove("streaming");
      if (finalContent) {
        var inner = streamBubble.querySelector(".rendered");
        inner.innerHTML = renderMarkdown(finalContent);
      }
      streamBubble = null;
      streamText = "";
      scrollToBottom();
    }
  }

  // ── Auto-resize textarea ──

  inputEl.addEventListener("input", function () {
    this.style.height = "auto";
    this.style.height = Math.min(this.scrollHeight, 150) + "px";
  });

  // Submit on Enter (Shift+Enter for newline)
  inputEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      formEl.dispatchEvent(new Event("submit"));
    }
  });

  // ── Send Message ──

  formEl.addEventListener("submit", function (e) {
    e.preventDefault();
    var text = inputEl.value.trim();
    if (!text || !connected) return;

    addMessage("user", text);
    ws.send(JSON.stringify({ type: "message", content: text }));
    inputEl.value = "";
    inputEl.style.height = "auto";
    showThinking();
  });

  // ── New Chat ──

  newBtn.addEventListener("click", function () {
    if (!confirm("Start a new conversation? Current history will be cleared from the screen.")) return;
    messagesEl.innerHTML = "";
    // Generate new client id for a fresh session
    clientId = crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "").slice(0, 12) : Math.random().toString(36).slice(2, 14);
    localStorage.setItem("nanobot_client_id", clientId);
    // Reconnect with new id
    if (ws) ws.close();
    connect();
  });

  // ── WebSocket ──

  var reconnectDelay = 1000;
  var maxReconnectDelay = 30000;
  var pingInterval = null;

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.close();
    }

    setStatus("connecting");

    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    var url = proto + "//" + location.host + "/ws";
    if (clientId) url += "?client_id=" + encodeURIComponent(clientId);

    ws = new WebSocket(url);

    ws.onopen = function () {
      reconnectDelay = 1000;
    };

    ws.onmessage = function (ev) {
      var data;
      try { data = JSON.parse(ev.data); } catch (_) { return; }

      switch (data.type) {
        case "connected":
          clientId = data.client_id;
          localStorage.setItem("nanobot_client_id", clientId);
          setStatus("connected");
          // Start keepalive
          clearInterval(pingInterval);
          pingInterval = setInterval(function () {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "ping" }));
            }
          }, 25000);
          break;

        case "message":
          hideThinking();
          endStream();  // finalize any in-progress stream
          addMessage("bot", data.content || "");
          break;

        case "stream_delta":
          appendStream(data.delta || "");
          break;

        case "stream_end":
          endStream(data.content || null);
          break;

        case "pong":
          break;

        case "error":
          hideThinking();
          addMessage("bot", "[Error] " + (data.error || "Unknown error"));
          break;
      }
    };

    ws.onclose = function () {
      setStatus("disconnected");
      clearInterval(pingInterval);
      streamBubble = null;
      streamText = "";
      // Auto-reconnect with backoff
      setTimeout(function () {
        reconnectDelay = Math.min(reconnectDelay * 2, maxReconnectDelay);
        connect();
      }, reconnectDelay);
    };

    ws.onerror = function () {
      // onclose will fire after this
    };
  }

  // ── Boot ──
  connect();
})();
