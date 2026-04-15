// src/main.ts
//
// Frontend entry point. This renders a tiny vanilla-DOM wizard — no framework,
// because the surface is small (four steps) and we want the bundle to stay
// light. The wizard drives a `WizardStateMachine` defined in `./wizard.ts`,
// which is exercised by unit tests.

import { createWizardStateMachine, type WizardState } from "./wizard.ts";
import { bridge } from "./ipc.ts";

const root = document.getElementById("app");
if (!root) {
  throw new Error("expected #app root element");
}

const machine = createWizardStateMachine();
let lastBootstrapPercent = 0;

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
  lastBootstrapPercent = progress.percent ?? lastBootstrapPercent;
  machine.setBootstrapMessage(progress.message);
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
    case "claude":
      root!.appendChild(renderClaudeStep(state));
      break;
    case "telegram":
      root!.appendChild(renderTelegramStep(state));
      break;
    case "workspace":
      root!.appendChild(renderWorkspaceStep(state));
      break;
    case "bootstrap":
      root!.appendChild(renderBootstrapStep(state));
      break;
    case "done":
      root!.appendChild(renderDoneStep(state));
      break;
  }
}

function renderHeader(state: WizardState): HTMLElement {
  const el = document.createElement("header");
  const steps = ["welcome", "claude", "telegram", "workspace", "bootstrap", "done"] as const;
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
      the gateway running in the background. We'll install a portable Node.js runtime,
      wire the local <code>claude</code> binary, collect your Telegram bot token, and
      pick a workspace folder. The whole thing takes about 2 minutes the first time.
    </p>
  `;
  const actions = document.createElement("div");
  actions.className = "actions";
  const next = button("Start setup", () => {
    machine.goto("claude");
    render();
  });
  actions.appendChild(document.createElement("div"));
  actions.appendChild(next);
  card.appendChild(actions);
  return card;
}

function renderClaudeStep(state: WizardState): HTMLElement {
  const card = document.createElement("section");
  card.className = "card";
  card.appendChild(h2("1. Local Claude CLI"));
  const hint = document.createElement("p");
  hint.className = "hint";
  hint.innerHTML = `
    We need the path to your local <code>claude</code> binary (Anthropic Claude Code).
    If it's already on PATH we detected it for you. Otherwise use <em>Pick file</em>
    to locate <code>claude.cmd</code>.
  `;
  card.appendChild(hint);

  const row = document.createElement("div");
  row.className = "row";
  const wrap = document.createElement("div");
  wrap.className = "grow";
  const label = document.createElement("label");
  label.textContent = "Claude binary path";
  const input = document.createElement("input");
  input.type = "text";
  input.value = state.claudeCliPath;
  input.placeholder = "C:/Users/you/AppData/Roaming/npm/claude.cmd";
  input.addEventListener("input", () => {
    machine.setField("claudeCliPath", input.value);
  });
  wrap.appendChild(label);
  wrap.appendChild(input);

  const pick = button("Pick file", async () => {
    const picked = await bridge.pickFile({
      title: "Select Claude binary",
      extensions: ["cmd", "exe", "bat"],
    });
    if (picked) {
      machine.setField("claudeCliPath", picked);
      render();
    }
  });
  pick.classList.add("secondary");

  row.appendChild(wrap);
  row.appendChild(pick);
  card.appendChild(row);

  if (state.claudeDetected) {
    const pill = document.createElement("span");
    pill.className = "pill ok";
    pill.textContent = "Detected on PATH";
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
    button("Back", () => {
      machine.goto("welcome");
      render();
    }, "secondary"),
  );
  actions.appendChild(
    button("Next", async () => {
      const report = await bridge.checkClaudeBinary(state.claudeCliPath);
      if (!report.exists) {
        machine.setError(`Claude binary not found at: ${state.claudeCliPath}`);
        render();
        return;
      }
      machine.setError(null);
      machine.goto("telegram");
      render();
    }),
  );
  card.appendChild(actions);
  return card;
}

function renderTelegramStep(state: WizardState): HTMLElement {
  const card = document.createElement("section");
  card.className = "card";
  card.appendChild(h2("2. Telegram bot"));

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
  card.appendChild(input("Bot token", state.telegramBotToken, (v) => machine.setField("telegramBotToken", v), "password"));

  if (state.error) {
    const err = document.createElement("div");
    err.className = "error";
    err.textContent = state.error;
    card.appendChild(err);
  }

  const actions = document.createElement("div");
  actions.className = "actions";
  actions.appendChild(
    button("Back", () => {
      machine.goto("claude");
      render();
    }, "secondary"),
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
  card.appendChild(h2("3. Workspace folder"));

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
    button("Pick folder", async () => {
      const picked = await bridge.pickFolder({ title: "Select workspace folder" });
      if (picked) {
        machine.setField("workspaceDir", picked);
        render();
      }
    }, "secondary"),
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
    button("Back", () => {
      machine.goto("telegram");
      render();
    }, "secondary"),
  );
  actions.appendChild(
    button("Install & start", async () => {
      machine.goto("bootstrap");
      render();
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
        await bridge.runBootstrap();
        machine.goto("done");
        render();
      } catch (err) {
        machine.setError(String(err));
        machine.goto("workspace");
        render();
      }
    }),
  );
  card.appendChild(actions);
  return card;
}

function renderBootstrapStep(state: WizardState): HTMLElement {
  const card = document.createElement("section");
  card.className = "card";
  card.appendChild(h2("Installing"));

  const msg = document.createElement("p");
  msg.className = "hint";
  msg.textContent = state.bootstrapMessage ?? "Starting bootstrap…";
  card.appendChild(msg);

  const progress = document.createElement("div");
  progress.className = "progress";
  const fill = document.createElement("div");
  fill.className = "fill";
  fill.style.width = `${lastBootstrapPercent}%`;
  progress.appendChild(fill);
  card.appendChild(progress);
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
    button("Close wizard", async () => {
      await bridge.closeWizard();
    }, "secondary"),
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

void hydrate();
