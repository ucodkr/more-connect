# More Connect (VS Code Extension)

MySQL/MariaDB/PostgreSQL/SQLite/Oracle/Redis에 연결하고 쿼리를 실행하는 간단한 DB 클라이언트 확장입니다.

## Features
- 연결 추가/삭제, 연결/해제
- 쿼리 실행 (입력창) + 결과 테이블 뷰
- 에디터 선택영역(또는 현재 라인) 쿼리 실행
- 비밀번호는 VS Code Secret Storage에 저장
- Redis는 별도 패키지 없이(순수 TS + RESP) 연결
- SQLite/Oracle은 런타임 의존성이 필요할 수 있음 (아래 참고)

## Notes (Drivers)
- `Redis`: 확장에 내장(추가 설치 불필요)
- `SQLite`: 필요 시 `sqlite3`를 확장 global storage에 설치합니다: `npm i --prefix "<globalStorage>/drivers" sqlite3`
- `Oracle`: 필요 시 `oracledb`(node-oracledb)를 확장 global storage에 설치합니다: `npm i --prefix "<globalStorage>/drivers" oracledb` (Thin 모드로는 Instant Client 없이도 접속 가능)

## Usage
1. `npm i`
2. `npm run build`
3. VS Code에서 `Run and Debug` → `Run Extension`
4. Explorer의 `More Connect` 뷰에서 연결 추가 후 쿼리 실행

## Publish (VSCE / PAT)
- `vsce publish` 실패 시 `The Personal Access Token used has expired.` 에러가 나오면, 기존 PAT 만료 연장은 불가하며 **새 PAT 발급 후 교체**해야 합니다.
- 기본 절차:
  1. Azure DevOps 로그인: `https://dev.azure.com`
  2. PAT 생성 페이지: `https://dev.azure.com/<조직명>/_usersSettings/tokens`
  3. 새 토큰 생성(만료 기간/권한 설정) 후 복사
     - 필수 권한: **Marketplace > Manage**
  4. 로컬 갱신:
     - `vsce logout ucodkr`
     - `vsce login ucodkr`
  5. 재배포: `npx vsce publish`

### 토큰 페이지 접속이 안 될 때
- 퍼블리셔 소유 계정(`ucodkr`)과 동일한 Microsoft 계정으로 로그인했는지 확인
- 시크릿 모드에서 `https://dev.azure.com` 먼저 로그인 후 토큰 페이지 접근
- 조직 미존재/권한 없음 상태인지 확인(조직 생성 또는 초대 필요)
- 사내망/보안 정책으로 `dev.azure.com` 차단 여부 확인(개인망으로 테스트)
