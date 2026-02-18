# Agent

`more-connect` 프로젝트 분석 기반 작업 메모입니다.

## 목적
- VS Code 확장(`More Connect`)의 구조/명령/운영 정보를 빠르게 참조
- 유지보수 및 릴리즈 작업 시 공통 컨텍스트 제공

## 프로젝트 요약
- 이름: `more-connect`
- 타입: VS Code Extension (Node.js + TypeScript)
- 설명: MySQL/MariaDB/PostgreSQL/SQLite/Oracle/Redis 연결 및 쿼리 실행 도구
- 엔트리: `dist/extension.js` (소스: `src/extension.ts`)
- 최소 VS Code 버전: `^1.85.0`

## 기술 스택
- 언어: TypeScript
- 번들링: `esbuild` (`scripts/esbuild.mjs`)
- 주요 의존성: `mysql2`, `pg`, `ssh2`
- 선택 런타임 드라이버: `sqlite3`, `oracledb` (global storage drivers 경로 설치)

## 주요 디렉터리
- `src/db`: DB 클라이언트 구현 (mysql/postgres/sqlite/oracle/redis + factory)
- `src/ui`: Explorer 트리, 결과 패널, 정보 패널, 연결 위저드
- `src/ssh`: SSH 설정/저장소/터널 관리
- `scripts/esbuild.mjs`: 빌드 및 watch
- `dist`: 빌드 산출물

## 자주 쓰는 명령
- 의존성 설치: `npm i`
- 빌드: `npm run build`
- 개발 watch: `npm run dev`
- 패키징: `npm run vsc:pac`
- 퍼블리시: `npm run vsc:pub`

## 확장 주요 기능
- 연결 추가/수정/복제/삭제, 연결/해제
- SQL 실행 (입력/에디터 선택영역/현재 라인)
- 테이블 미리보기, 스키마 갱신, DB/테이블 정보 조회
- SSH 연결 추가/수정/삭제, `~/.ssh/config` import
- SQL 파일 실행/저장, 즐겨찾기 SQL 실행

## 운영 메모
- 비밀번호는 VS Code Secret Storage 사용
- `vsc:pub`는 버전 patch 증가 후 패키징+배포 수행
- 퍼블리시 실패 시 PAT 만료 여부 우선 확인 (`vsce login` 재인증)

## 메모
- TODO:
  - 테스트/검증 체크리스트 문서화
  - DB별 에러 처리 일관성 점검
  - 명령별 UX(메시지/로딩/실패 케이스) 정리
