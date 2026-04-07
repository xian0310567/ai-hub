import { NextRequest } from 'next/server';
import { Missions } from '@/lib/db';
import { getSession } from '@/lib/auth';
import fs from 'fs';
import path from 'path';

// GET /api/missions/[id]/images/[filename] — 미션 이미지 조회
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; filename: string }> }
) {
  const user = getSession(req);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const { id, filename } = await params;

  // 미션 조회 및 권한 확인
  const mission = Missions.get(id);
  if (!mission || mission.user_id !== user.id) {
    return Response.json({ ok: false, error: '미션 없음' }, { status: 404 });
  }

  // 파일명 검증 (경로 탐색 공격 방지)
  if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return Response.json({ ok: false, error: '잘못된 파일명입니다' }, { status: 400 });
  }

  // 이미지 경로 구성
  const imagesDir = path.join(
    process.env.DATA_DIR || path.join(process.cwd(), '.data'),
    'users',
    user.id,
    'missions',
    id,
    'images'
  );
  const imagePath = path.join(imagesDir, filename);

  // 파일 존재 여부 확인
  if (!fs.existsSync(imagePath)) {
    return Response.json({ ok: false, error: '이미지를 찾을 수 없습니다' }, { status: 404 });
  }

  // MIME 타입 감지
  const ext = path.extname(filename).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
  };
  const contentType = mimeTypes[ext] || 'application/octet-stream';

  // 이미지 읽기 및 반환
  try {
    const imageBuffer = fs.readFileSync(imagePath);
    return new Response(imageBuffer, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Length': imageBuffer.length.toString(),
      },
    });
  } catch (err) {
    return Response.json({ ok: false, error: '이미지 읽기 실패' }, { status: 500 });
  }
}
