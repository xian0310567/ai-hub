import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { Server as SocketIOServer } from 'socket.io';
import Database from 'better-sqlite3';
import path from 'path';

const dev      = process.env.NODE_ENV !== 'production';
const hostname = '0.0.0.0';
const port     = parseInt(process.env.PORT || '3001', 10);

// ── 서버 시작 시 중단된 작업 정리 (1회만 실행) ──────────────────────
// 서버가 재시작되면 실행 중이던 claude 프로세스는 모두 종료되므로
// running/analyzing 상태로 남아있는 미션·잡·태스크를 failed로 초기화한다.
try {
  const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), '.data');
  const cleanupDb = new Database(path.join(DATA_DIR, 'hub.db'));
  cleanupDb.exec(`
    UPDATE missions
       SET status = 'failed', updated_at = unixepoch()
     WHERE status IN ('running', 'analyzing');

    UPDATE mission_jobs
       SET status = 'failed',
           error  = '서버 재시작으로 인해 중단됨',
           finished_at = unixepoch()
     WHERE status IN ('running', 'queued');

    UPDATE tasks
       SET status = 'failed',
           result = '서버 재시작으로 인해 중단됨',
           updated_at = unixepoch()
     WHERE status = 'running';
  `);
  cleanupDb.close();
  console.log('🧹 중단된 미션/작업 정리 완료');
} catch (e: any) {
  console.warn('⚠️  시작 시 정리 실패 (무시):', e.message);
}

const app    = next({ dev, hostname, port });
const handle = app.getRequestHandler();

// 처리되지 않은 예외로 서버가 죽지 않도록
process.on('uncaughtException', (err) => {
  console.error('⚠️  uncaughtException (서버 계속 실행):', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('⚠️  unhandledRejection (서버 계속 실행):', reason);
});

app.prepare().then(() => {
  const httpServer = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url!, true);
      await handle(req, res, parsedUrl);
    } catch (err: any) {
      console.error('⚠️  Request handler error:', err.message);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end('Internal Server Error');
      }
    }
  });

  const io = new SocketIOServer(httpServer, {
    cors: { origin: '*' },
    path: '/socket.io',
  });

  io.on('connection', (socket) => {
    console.log('🔌 Client connected:', socket.id);
    socket.on('disconnect', () => console.log('🔌 Client disconnected:', socket.id));
  });

  httpServer.listen(port, '0.0.0.0', () => {
    console.log(`\n🔨 AI 사업부 허브\n   ➜ http://localhost:${port}/\n`);
  });
});
