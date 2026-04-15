// src/ipc.ts
//
// Thin typed wrapper around Tauri's invoke/event API. Keeps the wizard DOM
// code free of `@tauri-apps/api` import paths and makes it possible to stub
// the bridge in unit tests.

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { listen, type Event } from "@tauri-apps/api/event";
import { open as openDialog, save as _saveDialog } from "@tauri-apps/plugin-dialog";
import type { GatewayStatusSnapshot } from "./wizard.ts";

export interface ClaudeBinaryReport {
  path: string;
  exists: boolean;
  on_path: boolean;
  path_on_path: string | null;
}

export interface ClaudeAuthReport {
  credentials_path: string;
  credentials_exist: boolean;
  credentials_size: number;
}

export interface LauncherConfig {
  onboarded: boolean;
  claude_cli_path: string | null;
  default_workspace: string | null;
  autostart_gateway: boolean;
  gateway_port: number;
  telegram_account_id: string | null;
}

export interface WizardDefaults {
  config: LauncherConfig;
  summary: Record<string, string>;
  detected_claude: ClaudeBinaryReport;
  suggested_workspace: string;
}

export interface WizardAnswers {
  claude_cli_path: string;
  workspace_dir: string;
  telegram_bot_token: string;
  telegram_account_id: string;
  gateway_port: number;
  default_model?: string;
}

export interface BootstrapProgress {
  step: string;
  message: string;
  percent: number | null;
}

export interface Bridge {
  getStatus(): Promise<GatewayStatusSnapshot>;
  getWizardDefaults(): Promise<WizardDefaults>;
  checkClaudeBinary(path: string): Promise<ClaudeBinaryReport>;
  checkClaudeAuth(): Promise<ClaudeAuthReport>;
  launchClaudeLogin(claudePath: string): Promise<void>;
  saveWizardConfig(args: {
    answers: WizardAnswers;
    enable_autostart: boolean;
  }): Promise<void>;
  runBootstrap(): Promise<void>;
  openDashboard(): Promise<void>;
  openLogsDir(): Promise<void>;
  startGateway(): Promise<void>;
  stopGateway(): Promise<void>;
  restartGateway(): Promise<void>;
  setAutostart(enable: boolean): Promise<void>;
  getAutostart(): Promise<boolean>;
  quit(): Promise<void>;
  closeWizard(): Promise<void>;
  pickFile(options: { title: string; extensions: string[] }): Promise<string | null>;
  pickFolder(options: { title: string }): Promise<string | null>;
  onStatus(cb: (snap: GatewayStatusSnapshot) => void): void;
  onBootstrapProgress(cb: (p: BootstrapProgress) => void): void;
}

export const bridge: Bridge = {
  getStatus: () => invoke<GatewayStatusSnapshot>("get_status"),
  getWizardDefaults: () => invoke<WizardDefaults>("get_wizard_defaults"),
  checkClaudeBinary: (path) =>
    invoke<ClaudeBinaryReport>("check_claude_binary", { path: path || null }),
  checkClaudeAuth: () => invoke<ClaudeAuthReport>("check_claude_auth"),
  launchClaudeLogin: (claudePath) =>
    invoke<void>("launch_claude_login", { claudePath: claudePath || null }),
  saveWizardConfig: (args) => invoke<void>("save_wizard_config", { args }),
  runBootstrap: () => invoke<void>("run_bootstrap"),
  openDashboard: () => invoke<void>("open_dashboard"),
  openLogsDir: () => invoke<void>("open_logs_dir"),
  startGateway: () => invoke<void>("start_gateway"),
  stopGateway: () => invoke<void>("stop_gateway"),
  restartGateway: () => invoke<void>("restart_gateway"),
  setAutostart: (enable) => invoke<void>("set_autostart", { enable }),
  getAutostart: () => invoke<boolean>("get_autostart"),
  quit: () => invoke<void>("quit_launcher"),
  closeWizard: async () => {
    const win = getCurrentWebviewWindow();
    await win.hide();
  },
  pickFile: async ({ title, extensions }) => {
    const result = await openDialog({
      title,
      multiple: false,
      filters: [{ name: "Binary", extensions }],
    });
    return typeof result === "string" ? result : null;
  },
  pickFolder: async ({ title }) => {
    const result = await openDialog({ title, directory: true, multiple: false });
    return typeof result === "string" ? result : null;
  },
  onStatus: (cb) => {
    void listen<GatewayStatusSnapshot>("launcher://status", (event: Event<GatewayStatusSnapshot>) => {
      cb(event.payload);
    });
  },
  onBootstrapProgress: (cb) => {
    void listen<BootstrapProgress>("launcher://bootstrap-progress", (event) => {
      cb(event.payload);
    });
  },
};
