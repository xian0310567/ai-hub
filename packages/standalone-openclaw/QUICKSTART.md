# Standalone OpenClaw — Quickstart

코드를 통째로 받아서 바로 사용하는 가이드.
Tauri 런처 없이 셸 스크립트만으로 설치/실행합니다.

## 사전 준비

- **Node.js >= 22.12** ([다운로드](https://nodejs.org/en/download))
- **pnpm** 또는 **npm** (pnpm 권장: `npm install -g pnpm`)
- **Claude CLI** (선택, CLI 백엔드 사용 시): `npm install -g @anthropic-ai/claude-code`

## 1. 코드 받기

```bash
# 방법 A: 전체 레포 클론 후 standalone-openclaw 폴더 사용
git clone https://github.com/xian0310567/ai-hub.git
cd ai-hub/packages/standalone-openclaw

# 방법 B: 폴더만 복사해서 사용
cp -r packages/standalone-openclaw ~/my-openclaw
cd ~/my-openclaw
```

## 2. 설치 & 설정

```bash
# macOS / Linux
chmod +x setup.sh run.sh
./setup.sh

# Windows
setup.cmd
```

setup 스크립트가 하는 일:
1. Node.js 버전 확인
2. `node_modules` 의존성 설치 (없을 때)
3. Claude CLI 확인 (없으면 설치 안내)
4. `openclaw onboard` 대화형 위저드 실행 → 설정 파일 생성

## 3. 게이트웨이 실행

```bash
# macOS / Linux (크래시 시 자동 재시작)
./run.sh

# Windows
run.cmd
```

### 실행 옵션

| 옵션 | 설명 | 기본값 |
|------|------|--------|
| `--port <port>` | 게이트웨이 포트 | `18789` |
| `--bind <mode>` | 바인드 모드: `loopback` / `lan` / `all` | `loopback` |
| `--dev` | 개발 모드 (포트 19001, 격리된 상태) | off |
| `--force` | 기존 포트 점유 프로세스 종료 후 시작 | off |
| `--no-restart` | 자동 재시작 끄기 | on |

```bash
# 예시: LAN 접속 허용, 포트 9000
./run.sh --port 9000 --bind lan

# 예시: 개발 모드
./run.sh --dev

# 예시: 한 번만 실행 (재시작 없음)
./run.sh --no-restart
```

## 4. 유용한 CLI 명령

```bash
node openclaw.mjs doctor          # 상태 진단
node openclaw.mjs status          # 채널 상태 확인
node openclaw.mjs onboard         # 설정 위저드 다시 실행
node openclaw.mjs models          # 사용 가능한 모델 목록
node openclaw.mjs channels login  # 채널 로그인 (WhatsApp QR 등)
node openclaw.mjs tui             # 터미널 UI
node openclaw.mjs logs            # 게이트웨이 로그 보기
node openclaw.mjs --help          # 전체 도움말
```

## 5. 설정 파일

설정 파일 위치: `~/.openclaw/openclaw.json`

환경변수로 덮어쓸 수 있습니다:

```bash
# .env 파일 또는 환경변수
OPENCLAW_CONFIG_PATH=~/.openclaw/openclaw.json
OPENCLAW_STATE_DIR=~/.openclaw
OPENCLAW_GATEWAY_PORT=18789
```

채널 토큰 설정 예시 (`.env`):

```bash
TELEGRAM_BOT_TOKEN=123456:ABCDEF...
DISCORD_BOT_TOKEN=...
SLACK_BOT_TOKEN=xoxb-...
ANTHROPIC_API_KEY=sk-ant-...   # API 키 백엔드 사용 시
```

자세한 환경변수 목록은 `.env.example` 참고.

## 6. systemd / launchd 서비스 등록 (선택)

### macOS (launchd)

```bash
cat > ~/Library/LaunchAgents/ai.openclaw.gateway.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ai.openclaw.gateway</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>OPENCLAW_DIR/openclaw.mjs</string>
        <string>gateway</string>
        <string>run</string>
    </array>
    <key>WorkingDirectory</key>
    <string>OPENCLAW_DIR</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/openclaw-gateway.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/openclaw-gateway.err</string>
</dict>
</plist>
EOF

# OPENCLAW_DIR을 실제 경로로 바꾸세요
# 로드: launchctl load ~/Library/LaunchAgents/ai.openclaw.gateway.plist
# 언로드: launchctl unload ~/Library/LaunchAgents/ai.openclaw.gateway.plist
```

### Linux (systemd)

```bash
cat > ~/.config/systemd/user/openclaw-gateway.service << 'EOF'
[Unit]
Description=OpenClaw Gateway
After=network.target

[Service]
Type=simple
WorkingDirectory=OPENCLAW_DIR
ExecStart=/usr/bin/node OPENCLAW_DIR/openclaw.mjs gateway run
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

# OPENCLAW_DIR을 실제 경로로 바꾸세요
# systemctl --user enable openclaw-gateway
# systemctl --user start openclaw-gateway
# systemctl --user status openclaw-gateway
```

## 문제 해결

```bash
# 버전 확인
node openclaw.mjs --version

# 전체 진단
node openclaw.mjs doctor

# 설정 초기화
node openclaw.mjs reset

# 포트 점유 확인 (macOS/Linux)
lsof -i :18789

# 포트 점유 확인 (Windows)
netstat -ano | findstr 18789
```
