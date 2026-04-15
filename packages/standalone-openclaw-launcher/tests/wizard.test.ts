// tests/wizard.test.ts
//
// Unit tests for the wizard state machine. Step ordering is enforced here so
// accidental refactors can't silently drop a dependency — e.g. moving
// "claude-login" before "install" would break, since the bundled claude.cmd
// only exists after install runs.

import { describe, expect, it } from "vitest";
import { createWizardStateMachine, STEP_ORDER } from "../src/wizard.ts";

describe("wizard state machine", () => {
  it("starts on welcome step with empty fields", () => {
    const m = createWizardStateMachine();
    expect(m.state.step).toBe("welcome");
    expect(m.state.claudeCliPath).toBe("");
    expect(m.state.gatewayPort).toBe(18789);
    expect(m.state.completed.size).toBe(0);
    expect(m.state.bootstrapComplete).toBe(false);
    expect(m.state.claudeAuthOk).toBe(false);
  });

  it("declares install → claude-login as a hard ordering", () => {
    // If this order ever changes, the bundled claude.cmd suggestion logic in
    // `main.ts`'s renderInstallStep will be wrong.
    expect(STEP_ORDER).toEqual([
      "welcome",
      "install",
      "claude-login",
      "telegram",
      "workspace",
      "done",
    ]);
  });

  it("marks earlier steps as completed when going forward", () => {
    const m = createWizardStateMachine();
    m.goto("workspace");
    expect(m.state.completed.has("welcome")).toBe(true);
    expect(m.state.completed.has("install")).toBe(true);
    expect(m.state.completed.has("claude-login")).toBe(true);
    expect(m.state.completed.has("telegram")).toBe(true);
    expect(m.state.completed.has("workspace")).toBe(false);
  });

  it("preserves completed markers when going back", () => {
    const m = createWizardStateMachine();
    m.goto("workspace");
    m.goto("claude-login");
    expect(m.state.step).toBe("claude-login");
    expect(m.state.completed.has("welcome")).toBe(true);
    expect(m.state.completed.has("install")).toBe(true);
  });

  it("clears error on step transition", () => {
    const m = createWizardStateMachine();
    m.setError("boom");
    expect(m.state.error).toBe("boom");
    m.goto("install");
    expect(m.state.error).toBeNull();
  });

  it("records bootstrap progress and completion separately", () => {
    const m = createWizardStateMachine();
    m.setBootstrapProgress("downloading", 40);
    expect(m.state.bootstrapPercent).toBe(40);
    expect(m.state.bootstrapComplete).toBe(false);
    m.markBootstrapComplete();
    expect(m.state.bootstrapComplete).toBe(true);
    expect(m.state.bootstrapPercent).toBe(100);
  });

  it("records claude auth ok state independently", () => {
    const m = createWizardStateMachine();
    expect(m.state.claudeAuthOk).toBe(false);
    m.markClaudeAuthOk();
    expect(m.state.claudeAuthOk).toBe(true);
  });

  it("hydrates from persisted config", () => {
    const m = createWizardStateMachine();
    m.hydrate({
      claudeCliPath: "C:/bin/claude.cmd",
      workspaceDir: "C:/work",
      gatewayPort: 19000,
      telegramAccountId: "bot-a",
      onboarded: false,
      claudeDetected: true,
    });
    expect(m.state.claudeCliPath).toBe("C:/bin/claude.cmd");
    expect(m.state.gatewayPort).toBe(19000);
    expect(m.state.claudeDetected).toBe(true);
    expect(m.state.step).toBe("welcome");
  });

  it("jumps to done step when already onboarded", () => {
    const m = createWizardStateMachine();
    m.hydrate({
      claudeCliPath: "C:/bin/claude.cmd",
      workspaceDir: "C:/work",
      gatewayPort: 18789,
      telegramAccountId: "default",
      onboarded: true,
      claudeDetected: true,
    });
    expect(m.state.step).toBe("done");
    expect(m.state.completed.has("workspace")).toBe(true);
  });

  it("typed setField updates string fields", () => {
    const m = createWizardStateMachine();
    m.setField("telegramBotToken", "123:abc");
    expect(m.state.telegramBotToken).toBe("123:abc");
  });

  it("typed setField updates numeric fields", () => {
    const m = createWizardStateMachine();
    m.setField("gatewayPort", 20000);
    expect(m.state.gatewayPort).toBe(20000);
  });

  it("ignores unknown step ids", () => {
    const m = createWizardStateMachine();
    // @ts-expect-error intentionally invalid id
    m.goto("nope");
    expect(m.state.step).toBe("welcome");
  });
});
