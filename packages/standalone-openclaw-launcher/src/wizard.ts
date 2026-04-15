// src/wizard.ts
//
// Pure state machine for the setup wizard. No DOM access here so we can unit
// test it with vitest. The DOM side (`main.ts`) calls `machine.goto` /
// `machine.setField` and re-renders.

export type StepId =
  | "welcome"
  | "claude"
  | "telegram"
  | "workspace"
  | "bootstrap"
  | "done";

export interface GatewayStatusSnapshot {
  state: string;
  pid: number | null;
  restarts: number;
  last_error: string | null;
  gateway_port: number;
}

export interface WizardState {
  step: StepId;
  completed: Set<StepId>;
  claudeCliPath: string;
  claudeDetected: boolean;
  telegramAccountId: string;
  telegramBotToken: string;
  workspaceDir: string;
  gatewayPort: number;
  bootstrapMessage: string | null;
  gatewayStatus: GatewayStatusSnapshot | null;
  error: string | null;
}

export interface HydrateArgs {
  claudeCliPath: string;
  workspaceDir: string;
  gatewayPort: number;
  telegramAccountId: string;
  onboarded: boolean;
  claudeDetected: boolean;
}

export interface WizardStateMachine {
  readonly state: WizardState;
  goto(step: StepId): void;
  setField<K extends FieldKey>(key: K, value: FieldValue<K>): void;
  setError(message: string | null): void;
  setBootstrapMessage(message: string): void;
  updateGatewayStatus(snap: GatewayStatusSnapshot): void;
  hydrate(args: HydrateArgs): void;
}

type FieldKey =
  | "claudeCliPath"
  | "telegramAccountId"
  | "telegramBotToken"
  | "workspaceDir"
  | "gatewayPort";

type FieldValue<K extends FieldKey> = K extends "gatewayPort" ? number : string;

const STEP_ORDER: readonly StepId[] = [
  "welcome",
  "claude",
  "telegram",
  "workspace",
  "bootstrap",
  "done",
];

export function createWizardStateMachine(): WizardStateMachine {
  const state: WizardState = {
    step: "welcome",
    completed: new Set<StepId>(),
    claudeCliPath: "",
    claudeDetected: false,
    telegramAccountId: "default",
    telegramBotToken: "",
    workspaceDir: "",
    gatewayPort: 18789,
    bootstrapMessage: null,
    gatewayStatus: null,
    error: null,
  };

  return {
    get state() {
      return state;
    },
    goto(step: StepId) {
      if (!STEP_ORDER.includes(step)) {
        return;
      }
      const currentIdx = STEP_ORDER.indexOf(state.step);
      const nextIdx = STEP_ORDER.indexOf(step);
      // Mark everything strictly before the target step as completed.
      for (let i = 0; i < nextIdx; i += 1) {
        state.completed.add(STEP_ORDER[i]!);
      }
      if (nextIdx < currentIdx) {
        // Going back: preserve completed markers, just move the cursor.
      }
      state.step = step;
      state.error = null;
    },
    setField<K extends FieldKey>(key: K, value: FieldValue<K>): void {
      (state as unknown as Record<FieldKey, unknown>)[key] = value;
    },
    setError(message: string | null) {
      state.error = message;
    },
    setBootstrapMessage(message: string) {
      state.bootstrapMessage = message;
    },
    updateGatewayStatus(snap: GatewayStatusSnapshot) {
      state.gatewayStatus = snap;
    },
    hydrate(args: HydrateArgs) {
      if (args.claudeCliPath) state.claudeCliPath = args.claudeCliPath;
      if (args.workspaceDir) state.workspaceDir = args.workspaceDir;
      if (args.gatewayPort) state.gatewayPort = args.gatewayPort;
      if (args.telegramAccountId) state.telegramAccountId = args.telegramAccountId;
      state.claudeDetected = args.claudeDetected;
      if (args.onboarded) {
        state.completed = new Set(STEP_ORDER.slice(0, -1));
        state.step = "done";
      }
    },
  };
}
