import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { Server as SocketIOServer } from 'socket.io';
import Database from 'better-sqlite3';
import path from 'path';
import { randomUUID } from 'crypto';
import cronParser from 'cron-parser';

const dev      = process.env.NODE_ENV !== 'production';
const hostname = '0.0.0.0';
const port     = parseInt(process.env.PORT || '3001', 10);

// ── 서버 시작 시 중단된 작업 정리 (1회만 실행) ──────────────────────
// 서버가 재시작되면 실행 중이던 claude 프로세스는 모두 종료되므로
// running/analyzing 상태로 남아있는 미션·잡·태스크를 failed로 초기화한다.
try {
  const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), '.data');
  const cleanupDb = new Database(path.join(DATA_DIR, 'local.db'));
  cleanupDb.pragma('busy_timeout = 5000');
  cleanupDb.pragma('journal_mode = WAL');
  cleanupDb.exec(`
    UPDATE missions
       SET status = 'failed',
           error  = '서버 재시작으로 인해 중단됨',
           updated_at = unixepoch()
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

// ── 미션 스케줄러 ────────────────────────────────────────────────────
// app.prepare() 이후에 시작하면 db 모듈이 Next.js 컨텍스트 내에서만 열려
// server.ts에서 직접 import 할 수 없으므로 better-sqlite3 직접 사용
function startMissionScheduler() {
  const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), '.data');
  const schedDb = new Database(path.join(DATA_DIR, 'local.db'));
  schedDb.pragma('busy_timeout = 5000');
  schedDb.pragma('journal_mode = WAL');

  const POLL_MS = 60_000; // 1분마다 체크

  setInterval(() => {
    const ts = Math.floor(Date.now() / 1000);
    const due = schedDb.prepare(
      "SELECT * FROM mission_schedules WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at <= ? AND openclaw_cron_id IS NULL"
    ).all(ts) as any[];

    for (const sched of due) {
      try {
        // 새 미션 생성 (status='routed', 저장된 routing 재사용)
        const missionId = randomUUID();
        schedDb.prepare(
          "INSERT INTO missions(id,user_id,task,status,routing,steps,final_doc,images) VALUES(?,?,?,'routed',?,'[]','','[]')"
        ).run(missionId, sched.user_id, sched.task, sched.routing);

        // next_run_at 갱신
        const interval = cronParser.parseExpression(sched.cron_expr);
        const nextTs = Math.floor(interval.next().getTime() / 1000);
        schedDb.prepare(
          "UPDATE mission_schedules SET last_run_at=?, next_run_at=? WHERE id=?"
        ).run(ts, nextTs, sched.id);

        console.log(`[mission-scheduler] "${sched.name}" 미션 생성 → ${missionId}, 다음 실행: ${new Date(nextTs * 1000).toISOString()}`);

        // 백그라운드로 미션 실행 (동적 import로 next.js 컨텍스트 없이 실행)
        import('./src/lib/mission-runner.js').then(({ runMissionBackground }) => {
          runMissionBackground(missionId, sched.session_cookie || '').catch(err =>
            console.error(`[mission-scheduler] 미션 실행 실패 (${missionId}):`, err.message)
          );
        }).catch(err => console.error('[mission-scheduler] runner import 실패:', err.message));

      } catch (err: any) {
        console.error(`[mission-scheduler] 스케줄 처리 실패 (${sched.id}):`, err.message);
      }
    }
  }, POLL_MS);

  // ── 잡 타임아웃 감시 (5분마다, 30분 초과 실행 중 잡 강제 실패) ────
  const JOB_TIMEOUT_SEC = 30 * 60; // 30분
  setInterval(() => {
    const cutoff = Math.floor(Date.now() / 1000) - JOB_TIMEOUT_SEC;
    const stuck = schedDb.prepare(`
      SELECT j.*, m.user_id
        FROM mission_jobs j
        JOIN missions m ON m.id = j.mission_id
       WHERE j.status='running' AND j.started_at IS NOT NULL AND j.started_at < ?
    `).all(cutoff) as any[];

    for (const job of stuck) {
      schedDb.prepare(
        "UPDATE mission_jobs SET status='failed', error=?, finished_at=unixepoch() WHERE id=?"
      ).run('타임아웃: 30분 초과 (강제 실패)', job.id);

      schedDb.prepare(
        "UPDATE missions SET status='failed', updated_at=unixepoch() WHERE id=? AND status='running'"
      ).run(job.mission_id);

      // 알림 생성
      const notifId = randomUUID();
      schedDb.prepare(
        "INSERT OR IGNORE INTO notifications(id,user_id,type,title,message) VALUES(?,?,'warning',?,?)"
      ).run(notifId, job.user_id ?? '', `잡 타임아웃: ${job.agent_name}`, `30분 초과로 강제 실패 처리됨 (미션: ${job.mission_id.slice(0, 8)}...)`);

      console.warn(`[job-watchdog] 타임아웃 강제 실패: job=${job.id} agent=${job.agent_name}`);
    }
  }, 5 * 60 * 1000);

  console.log(`🕐 미션 스케줄러 시작 (${POLL_MS / 1000}초 간격)`);
}

app.prepare().then(() => {
  startMissionScheduler();

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

    // Gateway 로그 스트리밍 구독
    socket.on('gateway:subscribe', () => {
      socket.join('gateway:logs');
      // 기존 버퍼(히스토리) 전송
      import('./src/lib/gateway-manager.js').then(({ getLogBuffer }) => {
        socket.emit('gateway:history', getLogBuffer());
      }).catch(() => {});
    });

    socket.on('gateway:unsubscribe', () => {
      socket.leave('gateway:logs');
    });

    socket.on('disconnect', () => console.log('🔌 Client disconnected:', socket.id));
  });

  // Gateway 로그 EventEmitter → Socket.IO 브릿지
  import('./src/lib/gateway-manager.js').then(({ gatewayLogs }) => {
    gatewayLogs.on('log', (entry: unknown) => {
      io.to('gateway:logs').emit('gateway:log', entry);
    });
  }).catch(() => {});

  httpServer.listen(port, '0.0.0.0', () => {
    console.log(`\n🔨 AI 사업부 허브\n   ➜ http://localhost:${port}/\n`);
    // Gateway 자동 시작은 instrumentation.ts register()에서 처리
  });
});
