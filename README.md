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
