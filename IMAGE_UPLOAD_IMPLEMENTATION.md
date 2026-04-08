# 미션 이미지 업로드 기능 구현 완료

## 구현 개요
AI Hub 미션 시스템에 이미지 첨부 기능을 추가했습니다. 사용자는 미션 생성 시 최대 5개의 이미지를 base64 형식으로 전송할 수 있습니다.

## 변경 사항

### 1. DB 스키마 변경 (`src/lib/db.ts`)
```sql
ALTER TABLE missions ADD COLUMN images TEXT NOT NULL DEFAULT '[]'
```

**Mission 인터페이스 업데이트:**
```typescript
export interface Mission {
  id: string;
  user_id: string;
  task: string;
  status: string;
  routing: string;
  steps: string;
  final_doc: string;
  images?: string; // JSON 형식: [{path, filename, size}]
  created_at?: number;
  updated_at?: number;
}
```

### 2. API 엔드포인트 수정 (`src/app/api/missions/route.ts`)

#### 요청 형식
**POST /api/missions**
```json
{
  "task": "미션 설명",
  "images": [
    "data:image/png;base64,iVBORw0KGgo...",
    "/9j/4AAQSkZJRgABAQAA..."
  ]
}
```

#### 응답 형식
```json
{
  "ok": true,
  "mission": {
    "id": "uuid",
    "task": "미션 설명",
    "status": "analyzing",
    "images": [
      {
        "path": "/Users/zesty/project/ai-hub/.data/users/{user_id}/missions/{mission_id}/images/1733123456_0.png",
        "filename": "1733123456_0.png",
        "size": 123456
      }
    ]
  }
}
```

**GET /api/missions**
- 기존 미션 목록에 `images` 배열 포함 (JSON 파싱 후 반환)

### 3. 이미지 처리 로직

#### 저장 경로
```
.data/users/{user_id}/missions/{mission_id}/images/{timestamp}_{index}.{ext}
```

#### 파일명 규칙
- 형식: `{timestamp}_{index}.{ext}`
- 예: `1733123456_0.png`, `1733123456_1.jpg`

#### 지원 형식
- MIME 타입: `image/jpeg`, `image/png`, `image/gif`, `image/webp`
- 확장자: `.jpg`, `.png`, `.gif`, `.webp`

## 보안 검증

### 1. 입력 검증
- **이미지 개수 제한**: 최대 5개
- **파일 크기 제한**: 각 이미지 최대 5MB
- **MIME 타입 검증**: 허용된 이미지 형식만 처리
- **파일명 sanitization**: 경로 탐색 공격 방지 (`../`, `./` 제거)

### 2. 경로 보안
```typescript
// userId와 missionId에서 경로 탐색 문자 차단
if (userId.includes('..') || userId.includes('/') || userId.includes('\\')) {
  throw new Error('잘못된 사용자 ID입니다');
}
```

### 3. 인증/인가
- 모든 요청에서 `getSession` 검증
- 사용자별 디렉토리 격리

## 에러 처리

### 클라이언트 에러 (400)
- "최대 5개의 이미지만 업로드할 수 있습니다"
- "이미지 크기는 5MB를 초과할 수 없습니다"
- "지원하지 않는 이미지 형식입니다. 허용 형식: image/jpeg, image/png, image/gif, image/webp"
- "잘못된 사용자 ID입니다"
- "잘못된 미션 ID입니다"
- "이미지 저장 중 오류가 발생했습니다"

### 인증 에러 (401)
- "Unauthorized"

## 테스트 시나리오

### 1. 정상 케이스
```bash
curl -X POST http://localhost:3000/api/missions \
  -H "Content-Type: application/json" \
  -H "Cookie: session=..." \
  -d '{
    "task": "웹사이트 디자인 검토",
    "images": ["data:image/png;base64,iVBORw0KGgo..."]
  }'
```

**기대 결과**: 201, 이미지가 저장되고 mission 레코드에 images 정보 포함

### 2. 이미지 개수 초과
```json
{
  "task": "테스트",
  "images": ["...", "...", "...", "...", "...", "..."] // 6개
}
```

**기대 결과**: 400, "최대 5개의 이미지만 업로드할 수 있습니다"

### 3. 파일 크기 초과
- 6MB 이미지 전송

**기대 결과**: 400, "이미지 크기는 5MB를 초과할 수 없습니다"

### 4. 지원하지 않는 형식
```json
{
  "task": "테스트",
  "images": ["data:application/pdf;base64,JVBERi0..."]
}
```

**기대 결과**: 400, "지원하지 않는 이미지 형식입니다"

### 5. 인증 없이 요청
```bash
curl -X POST http://localhost:3000/api/missions \
  -H "Content-Type: application/json" \
  -d '{"task": "테스트", "images": []}'
```

**기대 결과**: 401, "Unauthorized"

### 6. 이미지 없이 미션 생성 (하위 호환)
```json
{
  "task": "이미지 없는 미션"
}
```

**기대 결과**: 201, 기존처럼 동작 (images: [])

## 구현 완료 체크리스트

- [x] DB 스키마에 `images` 컬럼 추가
- [x] Mission 인터페이스 업데이트
- [x] POST 핸들러에 이미지 업로드 로직 추가
- [x] 이미지 저장 함수 (`saveImages`) 구현
- [x] MIME 타입 감지 함수 (`detectMimeType`) 구현
- [x] 파일명 sanitization 함수 (`sanitizeFilename`) 구현
- [x] 입력 검증 (개수, 크기, 형식)
- [x] 경로 탐색 공격 방지
- [x] 디렉토리 자동 생성 (`fs.mkdirSync` with `recursive: true`)
- [x] 에러 처리 및 적절한 에러 메시지
- [x] GET 핸들러에서 images JSON 파싱
- [x] TypeScript 타입 체크 통과
- [x] 기존 미션 생성 로직 유지 (하위 호환)

## 추가 구현 완료 (2026-04-06)

### P0: 미션 실행 시 이미지 활용 (완료 ✅)
1. **runAgentTask에 이미지 전달**
   - `callClaude` 함수에 `imagePaths` 파라미터 추가
   - 미션 실행 시 이미지 메타데이터를 파싱하여 Claude CLI에 이미지 경로 전달
   - 에이전트가 이미지를 참고하여 작업 수행 가능

2. **최종 문서 통합 시 이미지 컨텍스트 반영**
   - `consolidateResults` 함수에 이미지 정보 추가
   - 최종 보고서 생성 시 첨부된 이미지를 고려하여 작성

### P1: 이미지 조회 및 정리 (완료 ✅)
3. **이미지 조회 API**
   - `GET /api/missions/{id}/images/{filename}` 엔드포인트 구현
   - 적절한 Content-Type 헤더 반환 (MIME 타입 자동 감지)
   - 캐싱 헤더 설정 (`Cache-Control: public, max-age=31536000, immutable`)
   - 권한 검증 및 경로 탐색 공격 방지

4. **미션 삭제 시 이미지 정리**
   - DELETE 핸들러에서 이미지 디렉토리 및 하위 파일 모두 삭제 (`fs.rmSync`)
   - 에러 발생 시에도 미션 삭제는 정상 진행

## 향후 개선 사항 (P2)

1. **이미지 최적화**
   - 자동 리사이징 (예: 최대 1920x1080)
   - WebP 변환으로 저장 공간 절약
   - 썸네일 생성

2. **프론트엔드 개선**
   - 미션 상세 조회 시 첨부된 이미지 표시
   - 대용량 이미지 업로드 시 진행률 피드백
