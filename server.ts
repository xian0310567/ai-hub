import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { Server as SocketIOServer } from 'socket.io';

const dev      = process.env.NODE_ENV !== 'production';
const hostname = '0.0.0.0';
const port     = parseInt(process.env.PORT || '3001', 10);

const app    = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const httpServer = createServer(async (req, res) => {
    const parsedUrl = parse(req.url!, true);
    await handle(req, res, parsedUrl);
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
