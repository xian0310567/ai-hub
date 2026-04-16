// src/main.ts
//
// Frontend entry point. Renders a vanilla-DOM wizard that walks through:
//
//   welcome → install → claude-login → telegram → workspace → done
//
// All business logic lives in `wizard.ts`; this file is pure rendering +
// IPC plumbing.

import { createWizardStateMachine, type WizardState } from "./wizard.ts";
import { bridge } from "./ipc.ts";

const root = document.getElementById("app");
if (!root) {
  throw new Error("expected #app root element");
}

const machine = createWizardStateMachine();

async function hydrate(): Promise<void> {
  try {
    const defaults = await bridge.getWizardDefaults();
    machine.hydrate({
      claudeCliPath: defaults.detected_claude.path,
      workspaceDir: defaults.suggested_workspace,
      gatewayPort: defaults.config.gateway_port,
      telegramAccountId: defaults.config.telegram_account_id ?? "default",
      onboarded: defaults.config.onboarded,
      claudeDetected: defaults.detected_claude.exists,
    });
    // If we already have credentials we can skip the login step on reruns.
    const auth = await bridge.checkClaudeAuth();
    if (auth.credentials_exist && auth.credentials_size > 0) {
      machine.markClaudeAuthOk();
    }
  } catch (err) {
    machine.setError(String(err));
  }
  render();
}

bridge.onStatus((snap) => {
  machine.updateGatewayStatus(snap);
  render();
});

bridge.onBootstrapProgress((progress) => {
  if (progress.step === "npm-log") {
    machine.appendLog(progress.message);
  } else {
    machine.setBootstrapProgress(progress.message, progress.percent);
    if (progress.step === "done") {
      machine.markBootstrapComplete();
    }
  }
  render();
});

function render(): void {
  const state = machine.state;
  root!.innerHTML = "";
  root!.appendChild(renderHeader(state));
  switch (state.step) {
    case "welcome":
      root!.appendChild(renderWelcome(state));
      break;
    case "install":
      root!.appendChild(renderInstallStep(state));
      break;
    case "claude-login":
      root!.appendChild(renderClaudeLoginStep(state));
      break;
    case "telegram":
      root!.appendChild(renderTelegramStep(state));
      break;
    case "workspace":
      root!.appendChild(renderWorkspaceStep(state));
      break;
    case "done":
      root!.appendChild(renderDoneStep(state));
      break;
  }
}

function renderHeader(state: WizardState): HTMLElement {
  const el = document.createElement("header");
  const steps = ["welcome", "install", "claude-login", "telegram", "workspace", "done"] as const;
  const stepper = document.createElement("div");
  stepper.className = "stepper";
  steps.forEach((stepId, index) => {
    const dot = document.createElement("div");
    dot.className = "dot";
    dot.textContent = String(index + 1);
    if (stepId === state.step || state.completed.has(stepId)) {
      dot.classList.add("active");
    }
    stepper.appendChild(dot);
    if (index < steps.length - 1) {
      const bar = document.createElement("div");
      bar.className = "bar";
      stepper.appendChild(bar);
    }
  });
  const title = document.createElement("h1");
  title.textContent = "Standalone OpenClaw Launcher";
  el.appendChild(title);
  el.appendChild(stepper);
  return el;
}

function renderWelcome(_state: WizardState): HTMLElement {
  const card = document.createElement("section");
  card.className = "card";
  card.innerHTML = `
    <h2>Welcome</h2>
    <p class="hint">
      This launcher sets up <code>standalone-openclaw</code> on this machine and keeps
      the gateway running in the background.
    </p>
    <p class="hint">
      We'll: (1) install a portable Node.js runtime and the Claude CLI,
      (2) walk you through <code>claude auth login</code>,
      (3) collect your Telegram bot token, and (4) pick a workspace folder.
    </p>
  `;
  const actions = document.createElement("div");
  actions.className = "actions";
  const next = button("Start setup", () => {
    machine.goto("install");
    render();
    void startInstall();
  });
  actions.appendChild(document.createElement("div"));
  actions.appendChild(next);
  card.appendChild(actions);
  return card;
}

async function startInstall(): Promise<void> {
  // Idempotent: if bootstrap already ran, `needs_bootstrap` returns false and
  // `run_bootstrap` is a no-op other than emitting "done".
  try {
    await bridge.runBootstrap();
    machine.markBootstrapComplete();
    render();
  } catch (err) {
    machine.setError(String(err));
    render();
  }
}

function renderInstallStep(state: WizardState): HTMLElement {
  const card = document.createElement("section");
  card.className = "card";
  card.appendChild(h2("1. Installing runtime + dependencies"));

  const msg = document.createElement("p");
  msg.className = "hint";
  msg.textContent = state.bootstrapMessage ?? "Preparing…";
  card.appendChild(msg);

  const progress = document.createElement("div");
  progress.className = "progress";
  const fill = document.createElement("div");
  fill.className = "fill";
  fill.style.width = `${state.bootstrapPercent}%`;
  progress.appendChild(fill);
  card.appendChild(progress);

  if (state.bootstrapLogs.length > 0) {
    card.appendChild(renderLogPanel(state.bootstrapLogs));
  }

  if (state.error) {
    const err = document.createElement("div");
    err.className = "error";
    err.textContent = state.error;
    card.appendChild(err);
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.appendChild(
      button("Retry", () => {
        machine.setError(null);
        render();
        void startInstall();
      }),
    );
    card.appendChild(actions);
    return card;
  }

  if (state.bootstrapComplete) {
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.appendChild(document.createElement("div"));
    actions.appendChild(
      button("Continue", async () => {
        // Re-probe the binary now that npm install has finished; the bundled
        // path is the canonical default after this point.
        const report = await bridge.checkClaudeBinary("");
        if (report.exists) {
          machine.setField("claudeCliPath", report.path);
        }
        machine.goto("claude-login");
        render();
      }),
    );
    card.appendChild(actions);
  }
  return card;
}

function renderClaudeLoginStep(state: WizardState): HTMLElement {
  const card = document.createElement("section");
  card.className = "card";
  card.appendChild(h2("2. Authenticate with Anthropic"));

  const hint = document.createElement("p");
  hint.className = "hint";
  hint.innerHTML = `
    We'll open a console running <code>claude auth login</code>.
    Complete the browser OAuth flow there, then come back and click
    <em>I finished login</em>. Credentials are stored by Claude at
    <code>~/.claude/.credentials.json</code> and read by OpenClaw at runtime.
  `;
  card.appendChild(hint);

  const pathRow = document.createElement("div");
  pathRow.className = "mono";
  pathRow.textContent = state.claudeCliPath || "(using bundled Claude CLI)";
  card.appendChild(pathRow);

  if (state.claudeAuthOk) {
    const pill = document.createElement("span");
    pill.className = "pill ok";
    pill.textContent = "Credentials detected";
    card.appendChild(pill);
  }

  if (state.error) {
    const err = document.createElement("div");
    err.className = "error";
    err.textContent = state.error;
    card.appendChild(err);
  }

  const actions = document.createElement("div");
  actions.className = "actions";
  actions.appendChild(
    button(
      "Back",
      () => {
        machine.goto("install");
        render();
      },
      "secondary",
    ),
  );

  const rightGroup = document.createElement("div");
  rightGroup.style.display = "flex";
  rightGroup.style.gap = "8px";
  rightGroup.appendChild(
    button(
      "Launch claude auth login",
      async () => {
        try {
          await bridge.launchClaudeLogin(state.claudeCliPath);
        } catch (err) {
          machine.setError(String(err));
          render();
        }
      },
      "secondary",
    ),
  );
  rightGroup.appendChild(
    button("I finished login", async () => {
      const auth = await bridge.checkClaudeAuth();
      if (auth.credentials_exist && auth.credentials_size > 0) {
        machine.markClaudeAuthOk();
        machine.setError(null);
        machine.goto("telegram");
        render();
      } else {
        machine.setError(
          `No credentials found at ${auth.credentials_path}. Complete the OAuth flow, then try again.`,
        );
        render();
      }
    }),
  );
  if (state.claudeAuthOk) {
    rightGroup.appendChild(
      button("Skip (already logged in)", () => {
        machine.goto("telegram");
        render();
      }, "secondary"),
    );
  }
  actions.appendChild(rightGroup);
  card.appendChild(actions);
  return card;
}

function renderTelegramStep(state: WizardState): HTMLElement {
  const card = document.createElement("section");
  card.className = "card";
  card.appendChild(h2("3. Telegram bot"));

  const hint = document.createElement("p");
  hint.className = "hint";
  hint.innerHTML = `
    Paste the Telegram bot token from
    <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">@BotFather</a>.
    The account id is a short nickname you'll use later to refer to this bot
    from the OpenClaw CLI; leave it as <code>default</code> if unsure.
  `;
  card.appendChild(hint);

  card.appendChild(input("Account id", state.telegramAccountId, (v) => machine.setField("telegramAccountId", v)));
  card.appendChild(
    input("Bot token", state.telegramBotToken, (v) => machine.setField("telegramBotToken", v), "password"),
  );

  if (state.error) {
    const err = document.createElement("div");
    err.className = "error";
    err.textContent = state.error;
    card.appendChild(err);
  }

  const actions = document.createElement("div");
  actions.className = "actions";
  actions.appendChild(
    button(
      "Back",
      () => {
        machine.goto("claude-login");
        render();
      },
      "secondary",
    ),
  );
  actions.appendChild(
    button("Next", () => {
      if (!state.telegramBotToken.trim()) {
        machine.setError("Telegram bot token is required");
        render();
        return;
      }
      machine.setError(null);
      machine.goto("workspace");
      render();
    }),
  );
  card.appendChild(actions);
  return card;
}

function renderWorkspaceStep(state: WizardState): HTMLElement {
  const card = document.createElement("section");
  card.className = "card";
  card.appendChild(h2("4. Workspace folder"));

  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = "This is where Claude will do its work. It needs read/write access.";
  card.appendChild(hint);

  const row = document.createElement("div");
  row.className = "row";
  const wrap = document.createElement("div");
  wrap.className = "grow";
  wrap.appendChild(input("Workspace path", state.workspaceDir, (v) => machine.setField("workspaceDir", v)));
  row.appendChild(wrap);
  row.appendChild(
    button(
      "Pick folder",
      async () => {
        const picked = await bridge.pickFolder({ title: "Select workspace folder" });
        if (picked) {
          machine.setField("workspaceDir", picked);
          render();
        }
      },
      "secondary",
    ),
  );
  card.appendChild(row);

  card.appendChild(
    input(
      "Gateway port",
      String(state.gatewayPort),
      (v) => machine.setField("gatewayPort", Number.parseInt(v, 10) || 18789),
      "number",
    ),
  );

  if (state.error) {
    const err = document.createElement("div");
    err.className = "error";
    err.textContent = state.error;
    card.appendChild(err);
  }

  const actions = document.createElement("div");
  actions.className = "actions";
  actions.appendChild(
    button(
      "Back",
      () => {
        machine.goto("telegram");
        render();
      },
      "secondary",
    ),
  );
  actions.appendChild(
    button("Save & start gateway", async () => {
      try {
        await bridge.saveWizardConfig({
          answers: {
            claude_cli_path: state.claudeCliPath,
            workspace_dir: state.workspaceDir,
            telegram_bot_token: state.telegramBotToken,
            telegram_account_id: state.telegramAccountId,
            gateway_port: state.gatewayPort,
            default_model: "claude-cli/claude-sonnet-4-6",
          },
          enable_autostart: true,
        });
        machine.goto("done");
        render();
      } catch (err) {
        machine.setError(String(err));
        render();
      }
    }),
  );
  card.appendChild(actions);
  return card;
}

function renderDoneStep(state: WizardState): HTMLElement {
  const card = document.createElement("section");
  card.className = "card";
  card.appendChild(h2("All set"));

  const p = document.createElement("p");
  p.className = "hint";
  p.innerHTML = `
    The gateway is starting on port <code>${state.gatewayPort}</code>.
    Standalone OpenClaw will auto-start on login. Use the tray icon to pause,
    restart, or open the dashboard.
  `;
  card.appendChild(p);

  const actions = document.createElement("div");
  actions.className = "actions";
  actions.appendChild(
    button("Open dashboard", async () => {
      await bridge.openDashboard();
    }),
  );
  actions.appendChild(
    button(
      "Close wizard",
      async () => {
        await bridge.closeWizard();
      },
      "secondary",
    ),
  );
  card.appendChild(actions);
  return card;
}

function button(label: string, onClick: () => void | Promise<void>, variant?: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  if (variant) {
    b.classList.add(variant);
  }
  b.addEventListener("click", () => void onClick());
  return b;
}

function input(
  labelText: string,
  value: string,
  onChange: (v: string) => void,
  type: "text" | "password" | "number" = "text",
): HTMLElement {
  const wrap = document.createElement("div");
  const label = document.createElement("label");
  label.textContent = labelText;
  const el = document.createElement("input");
  el.type = type;
  el.value = value;
  el.addEventListener("input", () => onChange(el.value));
  wrap.appendChild(label);
  wrap.appendChild(el);
  return wrap;
}

function h2(text: string): HTMLElement {
  const el = document.createElement("h2");
  el.textContent = text;
  return el;
}

const LOG_PANEL_LINES = 14;

function renderLogPanel(logs: string[]): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "log-panel";
  const visible = logs.slice(-LOG_PANEL_LINES);
  for (const line of visible) {
    const row = document.createElement("div");
    row.className = "log-line";
    row.textContent = line;
    panel.appendChild(row);
  }
  return panel;
}

void hydrate();
