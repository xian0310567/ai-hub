/**
 * 통합 실행 인터페이스 테스트 — openclaw-executor.ts
 * AgentRunParams 확장 필드, Gateway/CLI 폴백 통합 검증
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────────
const { mockExecFile, mockFindBinary, mockGatewayReady } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
  mockFindBinary: vi.fn(),
  mockGatewayReady: vi.fn(),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

vi.mock('child_process', () => ({ execFile: mockExecFile }));
vi.mock('util', () => ({ promisify: () => mockExecFile }));

vi.mock('../lib/gateway-manager.js', () => ({
  findOpenClawBinary: mockFindBinary,
}));

vi.mock('../lib/openclaw-client.js', () => ({
  isGatewayAvailable: vi.fn(),
  isGatewayReady: mockGatewayReady,
}));

vi.mock('../lib/claude-cli.js', () => ({
  CLAUDE_CLI: '/usr/local/bin/claude',
  CLAUDE_ENV: { PATH: '/usr/local/bin', HOME: '/home/test' },
}));

// ── Import after mocks ────────────────────────────────────────────
import { agentRun } from '../lib/openclaw-executor.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Gateway 경유 실행 ─────────────────────────────────────────────
describe('agentRun (통합 실행)', () => {
  describe('Gateway 경유 실행', () => {
    it('기본 메시지를 Gateway로 전달하고 응답을 반환한다', async () => {
      mockGatewayReady.mockResolvedValue(true);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '결과입니다.' } }] }),
      });

      const result = await agentRun({ message: '작업 실행' });

      expect(result).toEqual({ ok: true, output: '결과입니다.' });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/v1/chat/completions'),
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('cwd, allowTools를 openclaw 확장 필드로 전달한다', async () => {
      mockGatewayReady.mockResolvedValue(true);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      });

      await agentRun({
        message: '코드 수정',
        cwd: '/path/to/workspace',
        allowTools: true,
      });

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.openclaw).toBeDefined();
      expect(callBody.openclaw.cwd).toBe('/path/to/workspace');
      expect(callBody.openclaw.allow_tools).toBe(true);
    });

    it('systemPrompt를 system role 메시지로 변환한다', async () => {
      mockGatewayReady.mockResolvedValue(true);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      });

      await agentRun({
        message: '작업',
        systemPrompt: '당신은 코드 리뷰 전문가입니다.',
      });

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.messages[0].role).toBe('system');
      expect(callBody.messages[0].content).toBe('당신은 코드 리뷰 전문가입니다.');
      expect(callBody.messages[1].role).toBe('user');
    });

    it('imagePaths를 멀티모달 content로 변환한다', async () => {
      mockGatewayReady.mockResolvedValue(true);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      });

      await agentRun({
        message: '이미지 분석',
        imagePaths: ['/tmp/img1.png', '/tmp/img2.jpg'],
      });

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const userMsg = callBody.messages[0]; // no system prompt → first is user
      expect(Array.isArray(userMsg.content)).toBe(true);
      expect(userMsg.content[0]).toEqual({ type: 'text', text: '이미지 분석' });
      expect(userMsg.content[1].type).toBe('image_url');
      expect(userMsg.content[1].image_url.url).toBe('file:///tmp/img1.png');
      expect(userMsg.content[2].image_url.url).toBe('file:///tmp/img2.jpg');
    });

    it('extraEnv는 보안상 Gateway HTTP body에 포함하지 않는다', async () => {
      mockGatewayReady.mockResolvedValue(true);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      });

      await agentRun({
        message: '작업',
        extraEnv: { SLACK_TOKEN: 'xoxb-test' },
      });

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      // extraEnv만으로는 openclaw 블록이 생성되지 않아야 함
      expect(callBody.openclaw).toBeUndefined();
    });

    it('extraEnv와 cwd가 함께 있으면 cwd만 openclaw 블록에 포함한다', async () => {
      mockGatewayReady.mockResolvedValue(true);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      });

      await agentRun({
        message: '작업',
        cwd: '/workspace',
        extraEnv: { SECRET: 'value' },
      });

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.openclaw.cwd).toBe('/workspace');
      expect(callBody.openclaw.extra_env).toBeUndefined();
    });

    it('Gateway 500 에러 시 CLI 폴백으로 전환한다', async () => {
      mockGatewayReady.mockResolvedValue(true);
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });
      mockExecFile.mockResolvedValueOnce({ stdout: 'CLI 폴백 결과' });

      const result = await agentRun({ message: '작업' });
      expect(result).toEqual({ ok: true, output: 'CLI 폴백 결과' });
      expect(mockExecFile).toHaveBeenCalled();
    });
  });

  // ── CLI 폴백 실행 ─────────────────────────────────────────────────
  describe('CLI 폴백 실행', () => {
    it('Gateway 미가용 시 claude CLI를 직접 실행한다', async () => {
      mockGatewayReady.mockResolvedValue(false);
      mockExecFile.mockResolvedValueOnce({ stdout: 'CLI 결과' });

      const result = await agentRun({ message: '테스트' });

      expect(result).toEqual({ ok: true, output: 'CLI 결과' });
      expect(mockExecFile).toHaveBeenCalledWith(
        '/usr/local/bin/claude',
        ['-p', '테스트'],
        expect.objectContaining({ encoding: 'utf8' }),
      );
    });

    it('allowTools가 true면 --allowedTools 플래그를 추가한다', async () => {
      mockGatewayReady.mockResolvedValue(false);
      mockExecFile.mockResolvedValueOnce({ stdout: 'ok' });

      await agentRun({ message: '코드 수정', allowTools: true });

      const args = mockExecFile.mock.calls[0][1];
      expect(args).toContain('--allowedTools');
      expect(args).toContain('Edit,Write,Read,Bash');
      expect(args).toContain('--dangerously-skip-permissions');
    });

    it('cwd를 execFile 옵션으로 전달한다', async () => {
      mockGatewayReady.mockResolvedValue(false);
      mockExecFile.mockResolvedValueOnce({ stdout: 'ok' });

      await agentRun({ message: '작업', cwd: '/path/to/workspace' });

      const options = mockExecFile.mock.calls[0][2];
      expect(options.cwd).toBe('/path/to/workspace');
    });

    it('imagePaths를 인자 끝에 추가한다', async () => {
      mockGatewayReady.mockResolvedValue(false);
      mockExecFile.mockResolvedValueOnce({ stdout: 'ok' });

      await agentRun({
        message: '이미지 분석',
        imagePaths: ['/tmp/img1.png'],
      });

      const args = mockExecFile.mock.calls[0][1];
      expect(args[args.length - 1]).toBe('/tmp/img1.png');
    });

    it('타임아웃 시 1회 재시도한다', async () => {
      mockGatewayReady.mockResolvedValue(false);
      const timeoutErr = Object.assign(new Error('timeout'), { killed: true });
      mockExecFile.mockRejectedValueOnce(timeoutErr);
      mockExecFile.mockResolvedValueOnce({ stdout: '재시도 성공' });

      const result = await agentRun({ message: '작업', timeout: 60 });

      expect(result).toEqual({ ok: true, output: '재시도 성공' });
      expect(mockExecFile).toHaveBeenCalledTimes(2);
    });

    it('maxBuffer 초과 시 부분 출력을 반환한다', async () => {
      mockGatewayReady.mockResolvedValue(false);
      const bufErr = Object.assign(new Error('maxBuffer exceeded'), {
        code: 'ERR_CHILD_PROCESS_STDOUT_MAX_BUFFER_SIZE',
        stdout: '부분 출력 결과가 여기에 있습니다. 이것은 충분히 긴 텍스트입니다. 최소 50자를 넘어야 부분 출력이 반환됩니다. 그래서 더 긴 문장을 작성합니다.',
      });
      mockExecFile.mockRejectedValueOnce(bufErr);

      const result = await agentRun({ message: '대용량 작업' });

      expect(result.ok).toBe(true);
      expect(result.output).toContain('부분 출력 결과');
    });

    it('systemPrompt를 --append-system-prompt로 전달한다', async () => {
      mockGatewayReady.mockResolvedValue(false);
      mockExecFile.mockResolvedValueOnce({ stdout: 'ok' });

      await agentRun({
        message: '작업',
        systemPrompt: '코드 전문가 소울',
      });

      const args = mockExecFile.mock.calls[0][1];
      expect(args).toContain('--append-system-prompt');
      expect(args).toContain('코드 전문가 소울');
    });

    it('mcpConfigPath를 --mcp-config로 전달한다', async () => {
      mockGatewayReady.mockResolvedValue(false);
      mockExecFile.mockResolvedValueOnce({ stdout: 'ok' });

      await agentRun({
        message: '작업',
        mcpConfigPath: '/tmp/mcp-config.json',
      });

      const args = mockExecFile.mock.calls[0][1];
      expect(args).toContain('--mcp-config');
      expect(args).toContain('/tmp/mcp-config.json');
    });

    it('extraEnv를 execFile env에 병합한다', async () => {
      mockGatewayReady.mockResolvedValue(false);
      mockExecFile.mockResolvedValueOnce({ stdout: 'ok' });

      await agentRun({
        message: '작업',
        extraEnv: { CUSTOM_VAR: 'value' },
      });

      const options = mockExecFile.mock.calls[0][2];
      expect(options.env.CUSTOM_VAR).toBe('value');
    });
  });
});
