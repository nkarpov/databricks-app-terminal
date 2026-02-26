(() => {
  const tabsEl = document.getElementById("tabs");
  const terminalMainEl = document.getElementById("terminal-main");
  const createBtn = document.getElementById("create-session");
  const sessionPicker = document.getElementById("session-picker");
  const sessionTypeOptions = document.getElementById("session-type-options");
  const modelPicker = document.getElementById("model-picker");
  const pickerBack = document.getElementById("picker-back");

  const sessions = new Map();
  let activeSessionId = null;

  const AGENT_MODELS = {
    "claude-code": [
      { id: "databricks-claude-opus-4-6", name: "Claude Opus 4.6", desc: "Most capable" },
      { id: "databricks-claude-sonnet-4-6", name: "Claude Sonnet 4.6", desc: "Balanced" },
      { id: "databricks-claude-haiku-4-5", name: "Claude Haiku 4.5", desc: "Fastest" },
    ],
    codex: [
      { id: "databricks-gpt-5-3-codex", name: "GPT 5.3 Codex", desc: "Latest" },
      { id: "databricks-gpt-5-2", name: "GPT 5.2", desc: "Stable" },
    ],
  };

  const AGENT_LABELS = {
    "claude-code": "Claude",
    codex: "Codex",
  };

  function api(method, url, body) {
    return fetch(url, {
      method,
      headers: {
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (response) => {
      const payload = await response.json();
      if (!response.ok || payload.ok === false) {
        const msg = payload?.error?.message || `Request failed (${response.status})`;
        throw new Error(msg);
      }
      return payload.data;
    });
  }

  function wsUrlFromPath(path) {
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    return `${scheme}://${window.location.host}${path}`;
  }

  function normalizeAuthMode(mode) {
    return mode === "user" || mode === "user-token" ? "user" : "m2m";
  }

  function authBadgeText(mode) {
    return mode === "user" ? "user" : "m2m";
  }

  function updateTabAuth(session) {
    const mode = normalizeAuthMode(session.authMode);
    session.authMode = mode;
    session.authEl.textContent = authBadgeText(mode);
    session.authEl.classList.toggle("user", mode === "user");
  }

  function shortSessionLabel(sessionId) {
    return sessionId.slice(0, 8);
  }

  function agentTabLabel(agent) {
    if (!agent) return null;
    return AGENT_LABELS[agent] || agent;
  }

  function displayTitle(session) {
    if (session.dynamicTitle && session.dynamicTitle.trim().length > 0) {
      return session.dynamicTitle.trim();
    }
    return agentTabLabel(session.agent, session.sessionId) || shortSessionLabel(session.sessionId);
  }

  function updateTabTitle(session) {
    session.labelEl.textContent = displayTitle(session);
  }

  function updateTabStatus(sessionId, status) {
    const session = sessions.get(sessionId);
    if (!session) {
      return;
    }

    session.status = status;
    session.statusEl.classList.remove("connected", "disconnected", "closed");
    session.statusEl.classList.add(status);
  }

  function sendResize(session) {
    if (!session.socket || session.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    session.socket.send(
      JSON.stringify({
        type: "resize",
        cols: session.terminal.cols,
        rows: session.terminal.rows,
      }),
    );
  }

  function fitAndResizeSession(session) {
    requestAnimationFrame(() => {
      session.fitAddon.fit();
      sendResize(session);
    });
  }

  function focusSessionTerminal(session) {
    requestAnimationFrame(() => {
      session.terminal.focus();
    });
  }

  function activateSession(sessionId) {
    activeSessionId = sessionId;

    for (const [id, session] of sessions.entries()) {
      const isActive = id === sessionId;
      session.tabEl.classList.toggle("active", isActive);
      session.paneEl.classList.toggle("active", isActive);
    }

    const active = sessions.get(sessionId);
    if (active) {
      fitAndResizeSession(active);
      setTimeout(() => {
        if (activeSessionId === sessionId) {
          fitAndResizeSession(active);
        }
      }, 80);
      focusSessionTerminal(active);
    }
  }

  function closeSessionUi(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      return;
    }

    if (session.socket) {
      session.socket.close();
      session.socket = null;
    }

    session.terminal.dispose();
    session.tabEl.remove();
    session.paneEl.remove();
    sessions.delete(sessionId);

    if (activeSessionId === sessionId) {
      const first = sessions.keys().next();
      activeSessionId = null;
      if (!first.done) {
        activateSession(first.value);
      }
    }

    if (sessions.size === 0) {
      showSessionPicker();
    }
  }

  function killSession(sessionId) {
    api("DELETE", `/api/sessions/${encodeURIComponent(sessionId)}`)
      .then(() => {
        closeSessionUi(sessionId);
      })
      .catch((error) => {
        if ((error.message || "").toLowerCase().includes("not found")) {
          closeSessionUi(sessionId);
          return;
        }
        console.warn(`Failed to close session ${sessionId}:`, error.message);
      });
  }

  function toggleSessionAuthMode(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      return;
    }

    const nextMode = session.authMode === "user" ? "m2m" : "user";

    api("POST", `/api/sessions/${encodeURIComponent(sessionId)}/auth-mode`, {
      mode: nextMode,
    })
      .then((data) => {
        session.authMode = normalizeAuthMode(data.authMode);
        updateTabAuth(session);
      })
      .catch((error) => {
        console.warn(`Failed to switch auth mode (${sessionId}):`, error.message);
        session.terminal.writeln(`\r\n[error] ${error.message}`);
      });
  }

  function connectSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      return;
    }

    api("POST", `/api/sessions/${encodeURIComponent(sessionId)}/attach`, {})
      .then((data) => {
        const socket = new WebSocket(wsUrlFromPath(data.websocketPath));
        session.socket = socket;

        socket.addEventListener("open", () => {
          updateTabStatus(sessionId, "connected");
          fitAndResizeSession(session);
        });

        socket.addEventListener("message", (event) => {
          let msg;
          try {
            msg = JSON.parse(event.data);
          } catch {
            return;
          }

          if (msg.type === "ready") {
            updateTabStatus(sessionId, "connected");
            fitAndResizeSession(session);
            return;
          }

          if (msg.type === "auth_mode") {
            session.authMode = normalizeAuthMode(msg.mode);
            updateTabAuth(session);
            return;
          }

          if (msg.type === "output") {
            session.terminal.write(msg.data);
            return;
          }

          if (msg.type === "exit") {
            updateTabStatus(sessionId, "closed");
            session.terminal.writeln(`\r\n[process exited: code=${msg.exitCode}]`);
            return;
          }

          if (msg.type === "error") {
            session.terminal.writeln(`\r\n[error] ${msg.message}`);
          }
        });

        socket.addEventListener("close", () => {
          if (sessions.has(sessionId)) {
            updateTabStatus(sessionId, "disconnected");
          }
        });

        socket.addEventListener("error", () => {
          if (sessions.has(sessionId)) {
            updateTabStatus(sessionId, "disconnected");
          }
        });
      })
      .catch((error) => {
        console.warn(`Attach failed (${sessionId}):`, error.message);
      });
  }

  function mountSession(sessionId, authMode = "m2m", activate = true, agent = undefined) {
    if (sessions.has(sessionId)) {
      if (activate) {
        activateSession(sessionId);
      }
      return;
    }

    const tabEl = document.createElement("div");
    tabEl.className = "tab";

    const closeEl = document.createElement("button");
    closeEl.className = "tab-close";
    closeEl.type = "button";
    closeEl.setAttribute("aria-label", `Close ${sessionId}`);
    closeEl.textContent = "\u00d7";

    const authEl = document.createElement("button");
    authEl.className = "tab-auth";
    authEl.type = "button";
    authEl.setAttribute("aria-label", `Toggle auth mode for ${sessionId}`);

    const agentEl = document.createElement("span");
    if (agent) {
      agentEl.className = `tab-agent ${agent}`;
      agentEl.textContent = AGENT_LABELS[agent] || agent;
    }

    const labelEl = document.createElement("span");
    labelEl.className = "tab-label";

    const statusEl = document.createElement("span");
    statusEl.className = "tab-status disconnected";

    tabEl.appendChild(closeEl);
    if (agent) {
      tabEl.appendChild(agentEl);
    }
    tabEl.appendChild(authEl);
    tabEl.appendChild(labelEl);
    tabEl.appendChild(statusEl);
    tabsEl.appendChild(tabEl);

    const paneEl = document.createElement("section");
    paneEl.className = "terminal-pane";

    const hostEl = document.createElement("div");
    hostEl.className = "terminal-host";
    paneEl.appendChild(hostEl);
    terminalMainEl.appendChild(paneEl);

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 15,
      theme: {
        background: "#0b0d10",
      },
      scrollback: 2000,
    });

    const fitAddon = new FitAddon.FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(hostEl);

    const state = {
      sessionId,
      tabEl,
      closeEl,
      authEl,
      agentEl,
      labelEl,
      paneEl,
      statusEl,
      terminal,
      fitAddon,
      socket: null,
      status: "disconnected",
      authMode: normalizeAuthMode(authMode),
      dynamicTitle: "",
      agent: agent || null,
    };

    sessions.set(sessionId, state);
    updateTabTitle(state);
    updateTabAuth(state);

    terminal.onData((data) => {
      if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
        return;
      }

      state.socket.send(
        JSON.stringify({
          type: "input",
          data,
        }),
      );
    });

    if (typeof terminal.onTitleChange === "function") {
      terminal.onTitleChange((title) => {
        state.dynamicTitle = title || "";
        updateTabTitle(state);
      });
    }

    tabEl.addEventListener("click", () => {
      activateSession(sessionId);
    });

    closeEl.addEventListener("click", (event) => {
      event.stopPropagation();
      killSession(sessionId);
    });

    authEl.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleSessionAuthMode(sessionId);
    });

    connectSession(sessionId);

    if (activate || !activeSessionId) {
      activateSession(sessionId);
    }
  }

  // --- Session picker ---

  function showSessionPicker() {
    sessionPicker.style.display = "flex";
    sessionTypeOptions.style.display = "flex";
    modelPicker.style.display = "none";
    pickerBack.style.display = "none";
  }

  function hideSessionPicker() {
    sessionPicker.style.display = "none";
  }

  function showModelPicker(agentType) {
    const models = AGENT_MODELS[agentType];
    if (!models) return;

    sessionTypeOptions.style.display = "none";
    modelPicker.innerHTML = "";
    modelPicker.style.display = "flex";
    pickerBack.style.display = "inline-block";

    for (const m of models) {
      const btn = document.createElement("button");
      btn.className = "opt-btn";
      const nameSpan = document.createElement("span");
      nameSpan.className = "opt-name";
      nameSpan.textContent = m.name;
      const descSpan = document.createElement("span");
      descSpan.className = "opt-desc";
      descSpan.textContent = m.desc;
      btn.appendChild(nameSpan);
      btn.appendChild(descSpan);
      btn.addEventListener("click", () => {
        hideSessionPicker();
        createSession(agentType, m.id);
      });
      modelPicker.appendChild(btn);
    }
  }

  // Session type selection
  for (const btn of sessionTypeOptions.querySelectorAll(".opt-btn")) {
    btn.addEventListener("click", () => {
      const type = btn.getAttribute("data-type");
      if (type === "terminal") {
        hideSessionPicker();
        createSession();
      } else {
        showModelPicker(type);
      }
    });
  }

  pickerBack.addEventListener("click", () => {
    sessionTypeOptions.style.display = "flex";
    modelPicker.style.display = "none";
    pickerBack.style.display = "none";
  });

  function createSession(agent, model) {
    const body = {};
    if (agent) body.agent = agent;
    if (model) body.model = model;

    api("POST", "/api/sessions", body)
      .then((data) => {
        hideSessionPicker();
        const s = data.session;
        mountSession(s.sessionId, data.authMode || s.authMode || "m2m", true, s.agent);
      })
      .catch((error) => {
        console.warn("Create session failed:", error.message);
      });
  }

  function loadExistingSessions() {
    api("GET", "/api/sessions")
      .then((data) => {
        for (const session of data.sessions) {
          mountSession(session.sessionId, session.authMode || "m2m", false, session.agent);
        }

        if (sessions.size > 0) {
          const first = sessions.keys().next();
          if (!first.done) {
            activateSession(first.value);
          }
          return;
        }

        showSessionPicker();
      })
      .catch((error) => {
        console.warn("Loading sessions failed:", error.message);
      });
  }

  function handleNewTabShortcut(event) {
    const key = event.key.toLowerCase();
    const isNewTabShortcut = (event.metaKey || event.ctrlKey) && !event.altKey && key === "t";

    if (!isNewTabShortcut) {
      return;
    }

    event.preventDefault();
    showSessionPicker();
  }

  window.addEventListener("resize", () => {
    if (!activeSessionId) {
      return;
    }

    const session = sessions.get(activeSessionId);
    if (!session) {
      return;
    }

    fitAndResizeSession(session);
  });

  window.addEventListener("keydown", handleNewTabShortcut);
  createBtn.addEventListener("click", () => showSessionPicker());

  if (typeof ResizeObserver !== "undefined") {
    const resizeObserver = new ResizeObserver(() => {
      if (!activeSessionId) {
        return;
      }

      const session = sessions.get(activeSessionId);
      if (!session) {
        return;
      }

      fitAndResizeSession(session);
    });

    resizeObserver.observe(terminalMainEl);
  }

  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      if (!activeSessionId) {
        return;
      }

      const session = sessions.get(activeSessionId);
      if (!session) {
        return;
      }

      fitAndResizeSession(session);
    });
  }

  loadExistingSessions();
})();
