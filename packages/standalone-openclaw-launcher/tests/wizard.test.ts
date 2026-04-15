// tests/wizard.test.ts
//
// Unit tests for the wizard state machine. This is the one piece of frontend
// logic that benefits from isolated testing — everything else is bridge glue.

import { describe, expect, it } from "vitest";
import { createWizardStateMachine } from "../src/wizard.ts";

describe("wizard state machine", () => {
  it("starts on welcome step with empty fields", () => {
    const m = createWizardStateMachine();
    expect(m.state.step).toBe("welcome");
    expect(m.state.claudeCliPath).toBe("");
    expect(m.state.gatewayPort).toBe(18789);
    expect(m.state.completed.size).toBe(0);
  });

  it("marks earlier steps as completed when going forward", () => {
    const m = createWizardStateMachine();
    m.goto("workspace");
    expect(m.state.completed.has("welcome")).toBe(true);
    expect(m.state.completed.has("claude")).toBe(true);
    expect(m.state.completed.has("telegram")).toBe(true);
    expect(m.state.completed.has("workspace")).toBe(false);
  });

  it("preserves completed markers when going back", () => {
    const m = createWizardStateMachine();
    m.goto("workspace");
    m.goto("claude");
    expect(m.state.step).toBe("claude");
    expect(m.state.completed.has("welcome")).toBe(true);
  });

  it("clears error on step transition", () => {
    const m = createWizardStateMachine();
    m.setError("boom");
    expect(m.state.error).toBe("boom");
    m.goto("claude");
    expect(m.state.error).toBeNull();
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
