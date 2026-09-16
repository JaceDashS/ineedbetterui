# I Need Better UI 레퍼런스

에이전트 대화를 프로젝트 밖의 JSONL 파일에 기록하고 브라우저에서 다시 읽을 수 있게 하는 단일 파일 도구의 표준 문서다.

- **기준**: 서버 `plugins/ineedbetterui/skills/ineedbetterui/ineedbetterui.mjs`와 명령 `bin/ineedbetterui.mjs`의 현재 코드. 이 문서와 코드가 다르면 코드가 실제 동작이며, 문서를 고친다.
- **확인 환경**: Windows 11, Node.js v24.14.0, npm 11.9

## 목차

1. [개요](#1-개요)
2. [파일 구성](#2-파일-구성)
3. [실행](#3-실행)
4. [데이터 모델](#4-데이터-모델)
5. [HTTP API](#5-http-api)
6. [기능별 규칙](#6-기능별-규칙)
7. [화면](#7-화면)
8. [마크다운 렌더링](#8-마크다운-렌더링)
9. [스타일](#9-스타일)
10. [브로드캐스트](#10-브로드캐스트)
11. [에이전트 연동 가이드](#11-에이전트-연동-가이드)
12. [테스트 도구](#12-테스트-도구)
13. [알려진 제한](#13-알려진-제한)

---

## 1. 개요

프로젝트명은 **I Need Better UI**이고, 스킬·npm 패키지·명령 이름은 이를 소문자로 붙인 `ineedbetterui`다.

I Need Better UI는 세 부분으로 이루어진다.

| 구성 | 역할 |
|---|---|
| 로컬 HTTP 서버 | 기록 API를 제공하고 JSONL 파일에 이벤트를 append한다. |
| 기록 화면 | 서버가 내려주는 단일 HTML 페이지. 2초마다 상태를 조회해 갱신한다. |
| JSONL 기록 파일 | 한 줄에 이벤트 하나. 파일 전체를 처음부터 재생해 현재 상태와 해시 체인을 만든다. |

**설계 원칙**

- 서버·API·화면·QR 인코더가 `ineedbetterui.mjs` 한 파일에 들어 있다. Node 내장 모듈(`crypto`, `fs`, `http`, `os`, `path`)만 사용하며 npm 의존성, 외부 CDN, 외부 폰트가 없다.
- 기록은 프로젝트의 `node_modules/.ineedbetterui/`에 저장하고, 그 폴더에 `*`만 담은 `.gitignore`를 둔다. 프로젝트 저장소에 커밋될 파일을 만들지 않는다.
- 기록 파일은 append-only다. 초기화도 기존 줄을 지우지 않고 `reset` 이벤트를 추가한다.
- 에이전트에게는 로그 전체를 반복해서 보내지 않는다. 해시 체인으로 에이전트가 모르는 이벤트만 골라 보낸다.
- 서버는 AI 모델을 호출하지 않는다. 질문 정리본(`cleanedBody`)은 기록하는 에이전트가 만든다.
- 서버는 채팅 입력을 가로채지 않는다. 에이전트가 API를 호출해야 기록된다.
- 화면 UI 문자열은 영어만 사용한다. 기록 본문은 입력된 언어 그대로 표시한다.

## 2. 파일 구성

### 2.1 저장소

| 경로 | 설명 |
|---|---|
| `package.json` | npm 패키지 `ineedbetterui` (명령 `ineedbetterui`, 설치 스크립트) |
| `bin/ineedbetterui.mjs` | 명령 진입점: 서버 시작, `stop`, `install`, `uninstall` ([3.3절](#33-npm-명령)) |
| `plugins/ineedbetterui/skills/ineedbetterui/` | 스킬 원본. npm 패키지와 (2단계) 마켓플레이스가 같은 폴더를 쓴다 |
| `…/ineedbetterui.mjs` | 서버, API, 화면 HTML·CSS·클라이언트 JS, QR 인코더 |
| `…/SKILL.md` | 에이전트가 따르는 실행·기록 지침. 스킬 이름 `ineedbetterui` |
| `…/references/reference.md` | 이 문서 |
| `README.md` | npm 페이지용 설명 |
| `tests/` | 자동 테스트([12.2절](#122-자동-테스트)) |
| `tester/restart-ineedbetterui.ps1` | 통합 테스트용 서버 재시작 스크립트 |
| `tester/start-codex-test.ps1` | Codex 테스트 프로젝트 준비·실행기([12.3절](#123-codex-테스트-실행기)) |

npm 패키지에는 `package.json`, `README.md`, `bin/`, `plugins/ineedbetterui/skills/`만 들어간다. `tests/`, `tester/`는 들어가지 않는다. 배포는 저장소 루트에서 `npm publish`로 하며, 넣을 파일은 `package.json`의 `files`가 정한다. 이름에 `.private.`가 들어간 파일(개발 메모 등)은 `.gitignore` 대상이라 저장소에도 올리지 않는다.

설치된 스킬 폴더의 구조는 다음과 같다. 폴더 이름이 스킬 이름이며 Codex에서는 `$ineedbetterui`, Claude Code에서는 `/ineedbetterui`로 부른다.

~~~text
ineedbetterui/
|-- ineedbetterui.mjs
|-- SKILL.md
|-- .ineedbetterui-install.json   (ineedbetterui install이 만든 표시 파일)
|-- references/
    |-- reference.md
~~~

### 2.2 실행 중 만들어지는 파일

~~~text
<프로젝트>/node_modules/.ineedbetterui/   (기록 폴더)
  .gitignore          `*` 한 줄. 기록 폴더 전체를 git에서 제외
  transcript.jsonl    기록
  server-<포트>.html   실행 중인 서버 정보
  project.json        프로젝트 정보
~~~

- 기록 폴더와 `.gitignore`는 서버를 시작할 때나 첫 기록을 쓸 때 만든다. `.gitignore`가 이미 있으면 건드리지 않는다.
- 대부분의 저장소는 `node_modules`를 무시하고, 그 규칙이 없는 저장소에서도 기록 폴더의 `.gitignore`가 기록을 제외한다.
- `node_modules`를 지우거나 새로 만드는 작업(`npm ci` 등)은 기록도 지운다.
- 경로를 바꾸는 옵션이나 환경 변수는 없다.

`project.json` 예시:

~~~json
{
  "app": "ineedbetterui",
  "sessionId": "3f9a1c2b7d4e",
  "projectPath": "C:\\projects\\my-app",
  "createdAt": "2026-09-14T22:40:01.120+09:00",
  "lastStartedAt": "2026-09-14T23:05:12.004+09:00"
}
~~~

`createdAt`은 `project.json`을 처음 만든 시각이고, `lastStartedAt`은 새 서버를 띄울 때마다 갱신한다.

## 3. 실행

기록할 프로젝트 폴더를 작업 폴더로 두고 실행한다. 서버 파일은 스킬 폴더 안의 `ineedbetterui.mjs`다(저장소에서는 `plugins/ineedbetterui/skills/ineedbetterui/`). npm으로 설치했다면 `ineedbetterui` 명령도 같은 서버를 시작한다.

~~~bash
node <스킬 폴더>/ineedbetterui.mjs               # 이 PC에서만 접속(기본)
node <스킬 폴더>/ineedbetterui.mjs --broadcast   # LAN 공개 상태로 시작
ineedbetterui [--broadcast]                     # npm 설치 시 같은 동작
~~~

작업 폴더가 곧 기록 대상 프로젝트이므로, 실행 파일이 있는 폴더로 이동해서 실행하지 않는다.

### 3.1 옵션과 고정값

| 항목 | 값 |
|---|---|
| `--broadcast` | 브로드캐스트를 켠 상태로 시작해 `0.0.0.0`에 바인드한다. 없으면 `127.0.0.1`에만 바인드하며, 화면의 설정에서 켤 수 있다([10절](#10-브로드캐스트)). `--no-broadcast`는 그대로 받아들이고 무시한다. |
| 프로젝트 | 실행 폴더(작업 폴더). 경로를 바꾸는 옵션은 없다. |
| 기록 파일 | `<프로젝트>/node_modules/.ineedbetterui/transcript.jsonl`. 없으면 첫 쓰기 때 만든다. 경로를 바꾸는 옵션은 없다. |
| 포트 | 자동. 지정하는 옵션은 없다([3.2절](#32-세션-자동-이어쓰기)). |

- 알 수 없는 인자는 오류 없이 무시한다. 이전 버전의 `--port`, `--data`, `--export`, `--broadcast`, `--max-response-chars`도 무시된다.
- 새 서버를 띄우면 프로세스가 계속 실행된다. 에이전트는 백그라운드로 실행한다.

**콘솔 출력**

| 상황 | 출력 |
|---|---|
| 새 서버 | `ineedbetterui listening on http://127.0.0.1:PORT/` 다음 줄에 `records <기록 파일 경로>` |
| `--broadcast`로 시작한 새 서버 | 위 두 줄 다음에 `broadcast access on http://LAN-IP:PORT/` |
| 이미 실행 중 | `ineedbetterui already running on http://127.0.0.1:PORT/` (종료 코드 0) |
| 오류 | 오류 메시지 한 줄 (종료 코드 1) |

### 3.2 세션 자동 이어쓰기

같은 프로젝트 폴더에서 명령을 다시 실행하면, 그 프로젝트의 서버가 실행 중이면 그 서버를 쓰고 없으면 새로 띄운다. 포트를 기억하거나 지정할 필요가 없다.

**세션 ID**

프로젝트 폴더 실제 경로의 SHA-256 앞 12자리(16진수)다. 경로는 실제 경로로 정규화하고(Windows 8.3 짧은 이름 포함), Windows에서는 소문자로 바꾼 뒤 계산한다. 같은 폴더면 항상 같은 값이다.

**서버 정보 파일**

새 서버가 뜨면 기록 폴더에 `server-<포트>.html`을 만든다.

- 브라우저로 열면 `http://127.0.0.1:<포트>/`로 이동한다.
- `body`에 `data-app`, `data-session-id`, `data-port`, `data-pid`가 들어 있다.
- 정상 종료(Ctrl+C, SIGTERM 등) 때 지운다. 강제 종료하면 남고, 다음 실행 때 정리된다.

**시작 절차**

1. 기록 폴더에서 `server-<포트>.html` 파일을 모두 찾는다.
2. 파일마다 `GET http://127.0.0.1:<포트>/api/health`를 보낸다(제한 시간 600ms). `app`이 `ineedbetterui`이고 `sessionId`가 같으면 그 서버를 이어서 쓴다.
   - `already running` 줄을 출력하고 종료 코드 0으로 끝난다. 브로드캐스트는 실행 중인 서버의 현재 상태를 따르며, 시작 옵션이 달라도 오류가 아니다.
3. 이어 쓸 서버가 없으면 기록 폴더의 서버 정보 파일을 모두 지운다.
4. 지운 파일의 포트를 먼저 시도하고, 모두 사용 중이면 운영체제가 주는 빈 포트를 쓴다.
5. 기록 폴더와 `.gitignore`를 만들고 `project.json`을 만들거나 갱신하고, 서버 정보 파일을 만든 뒤 콘솔에 주소를 출력한다. `--broadcast`로 시작했으면 접속 주소도 출력한다.

| 상황 | 결과 |
|---|---|
| 서버 없음, 정보 파일 없음 | 빈 포트로 새로 시작 |
| 같은 프로젝트 서버가 실행 중 | 새로 띄우지 않고 주소 출력 |
| 강제 종료로 정보 파일만 남음 | 옛 파일을 지우고 가능하면 같은 포트로 새로 시작 |
| 옛 포트를 다른 프로그램이 사용 중 | 옛 파일을 지우고 빈 포트로 새로 시작 |
| 같은 프로젝트 서버가 다른 브로드캐스트 상태로 실행 중 | 오류 없이 주소만 출력 |
| 서버를 끄고 프로젝트 폴더를 옮기거나 이름을 바꾼 뒤 실행 | 기록 폴더가 함께 옮겨져 **기록을 이어 쓴다**. 세션 ID는 새 경로 기준으로 바뀐다 |

**폴더 이동**

서버의 작업 폴더가 프로젝트 폴더이므로, Windows에서는 서버가 실행 중인 동안 그 폴더를 옮기거나 이름을 바꿀 수 없다(`EBUSY`). macOS·Linux는 막지 않으므로 서버를 종료한 뒤 옮긴다.

### 3.3 npm 명령

`npm install -g ineedbetterui`로 설치하면 `ineedbetterui` 명령이 생긴다.

| 명령 | 동작 |
|---|---|
| `ineedbetterui [--no-broadcast]` | 현재 폴더 프로젝트의 서버를 시작하거나, 실행 중인 서버 주소를 출력한다. 스킬 폴더의 서버 파일을 그대로 실행한다 |
| `ineedbetterui stop` | 현재 폴더 프로젝트의 서버를 찾아(헬스체크로 세션 ID 확인) 종료하고 서버 정보 파일을 지운다 |
| `ineedbetterui install` | 스킬 등록 |
| `ineedbetterui uninstall` | 스킬 제거. 기록은 각 프로젝트에 남는다 |
| `ineedbetterui --version`, `--help` | 버전, 도움말 |

**설치 스크립트(`postinstall`)**

- npm이 설치할 때마다 실행한다. `npm_config_global`이 `true`인 전역 설치에서만 `install`과 같은 등록을 하고, 프로젝트 안 설치에서는 아무것도 하지 않는다.
- 등록에 실패해도 npm 설치를 실패시키지 않고, `ineedbetterui install`로 다시 시도하라고 출력한다.

**`install`**

| 대상 | 위치 |
|---|---|
| Codex 스킬 | `~/.agents/skills/ineedbetterui/` |
| Claude Code 스킬 | `~/.claude/skills/ineedbetterui/` |

- 패키지의 스킬 폴더 전체를 복사하고 `.ineedbetterui-install.json` 표시 파일을 만든다.
- 같은 이름의 폴더가 있는데 표시 파일이 없으면(사용자가 만든 폴더) 덮어쓰지 않고 건너뛴다.
- 다시 실행하면 표시 파일이 있는 폴더를 지우고 새로 복사한다.

**`uninstall`**

- 표시 파일이 있는 스킬 폴더만 지운다.
- 기록은 지우지 않는다. 각 프로젝트의 `node_modules/.ineedbetterui/`에 남으며, 지우려면 그 폴더를 직접 지운다.
- npm v7부터 제거 스크립트가 실행되지 않으므로 `npm uninstall -g ineedbetterui` 전에 실행해야 한다.

## 4. 데이터 모델

### 4.1 파일 형식

- UTF-8 텍스트, 한 줄에 JSON 객체 하나, 줄 끝은 `\n`
- JSON으로 읽을 수 없는 줄과 빈 줄은 상태 재생에서 건너뛴다. 빈 줄이 아닌 줄은 JSON이 아니어도 해시 체인에는 포함된다.
- 이벤트 종류는 `t` 필드로 구분한다. 키와 열거값은 영어이고, 사용자 언어는 `body`, `heading`, `title`, `text` 같은 콘텐츠 필드에만 들어간다.
- 시각(`time`)은 서버의 로컬 시간대 오프셋과 밀리초를 포함한 ISO 8601 문자열이다. 예: `2026-09-14T21:30:05.123+09:00`

~~~json
{"t":"entry","id":"a-12","kind":"question","time":"...","heading":"","body":"정리된 질문","rawBody":"원문","cleanedBody":"정리된 질문","questionMode":"cleaned","clientRef":"turn-14-q"}
{"t":"entry","id":"a-13","kind":"report","time":"...","heading":"응답","body":"설명 본문"}
{"t":"pin","time":"...","target":"a-13","source":"user"}
{"t":"reply-target","time":"...","target":"a-13","source":"user"}
{"t":"entry","id":"a-14","kind":"report","time":"...","heading":"","body":"추가 응답","replyTo":"a-13"}
{"t":"note","id":"n-1757853005123-k3x9a","target":"a-13","time":"...","anchor":"추정값","title":"추정값이란?","text":"..."}
{"t":"revision","id":"r-1757853005456-p2m7q","target":"a-13","time":"...","body":"수정된 전체 본문"}
{"t":"outline","time":"...","done":false,"items":[{"no":"1","title":"항목","type":"report","status":"active","current":true}]}
{"t":"settings","time":"...","questionMode":"raw","maxResponseChars":2000,"maxUnseenEvents":20}
{"t":"reset","time":"..."}
~~~

### 4.2 이벤트

| `t` | 필드 | 효과 |
|---|---|---|
| `entry` | `id`, `kind`, `time`, `heading`, `body`, 질문이면 `rawBody`·`cleanedBody`·`questionMode`, 선택 `clientRef`·`replyTo`, 브로드캐스트면 `broadcastId`·`broadcastUrl`·`broadcastPort`·`qr` | 대화 목록 끝에 entry 추가. 질문이 아닌 entry는 대기 중인 reply-target을 해제한다. |
| `note` | `id`, `target`, `time`, `anchor`, `title`, `text` | 대상 entry에 노트 누적 |
| `revision` | `id`, `target`, `time`, `body` | 대상 entry의 표시 본문을 교체하고 수정 이력에 추가 |
| `pin` | `time`, `target`(ID 또는 `null`), `source`(`user`·`agent`) | 현재 핀 교체·해제. 핀 대상이 바뀌면 reply-target 해제 |
| `reply-target` | `time`, `target`(ID 또는 `null`), `source` | 다음 비질문 entry를 연결할 대기 상태 설정. 현재 핀 대상과 같을 때만 유효 |
| `outline` | `time`, `done`, `items` | 현재 목차 교체 |
| `settings` | `time`, 선택 `questionMode`, `maxResponseChars`, `maxUnseenEvents` | 유효한 필드만 현재 설정에 반영 |
| `broadcast` | `time`, `enabled`, `url`, `port`, `source`, 실패 시 `error` | 브로드캐스트 상태 기록([10절](#10-브로드캐스트)) |
| `reset` | `time` | 현재 상태를 비움 |

### 4.3 식별자와 해시

| 대상 | 형식 | 생성 규칙 |
|---|---|---|
| entry | `a-N` | 파일 전체(초기화 이전 포함)의 최대 N + 1. 초기화 후에도 번호를 다시 쓰지 않는다. |
| note | `n-<epoch ms>-<5자 난수>` | 서버 생성 |
| revision | `r-<epoch ms>-<5자 난수>` | 서버 생성 |
| broadcast | `broadcast-<epoch ms>-<5자 난수>` | 서버 시작 시 생성 |
| 이벤트 해시 | 16자리 16진수 | `sha256(<이전 해시> + "\n" + <줄 원문>)`의 앞 16자리 |
| head | 16자리 16진수 | 마지막 줄의 해시. 기록이 비어 있으면 `0000000000000000` |

해시는 파일에 저장하지 않는다. 서버가 파일을 읽을 때마다 처음부터 계산하므로, 같은 파일이면 재시작 후에도 같은 값이 나온다. 이미 있는 줄을 한 글자라도 바꾸면 그 줄 이후의 해시가 모두 달라진다.

### 4.4 열거값

| 필드 | 값 |
|---|---|
| `kind` | `question`, `report`, `decision`, `error`, `done`, `other` |
| `questionMode` | `cleaned`, `raw` |
| outline `status` | `pending`, `active`, `done` (화면에는 이 세 값만 라벨로 바꿔 표시) |
| `source` | `user`(요청에 `X-Ineedbetterui-UI: 1` 헤더), `agent`(그 외) |

### 4.5 재생 규칙

서버는 시작할 때와 쓰기 직후마다 파일 전체를 처음부터 다시 읽어 상태와 해시 체인을 만든다.

1. 파일 순서가 정본이다. entry는 파일에 쓰인 순서대로 목록에 쌓인다.
2. `revision`이 있으면 마지막 revision의 `body`가 표시 본문이다.
3. `pin`, `reply-target`, `outline`은 마지막 이벤트가 현재 상태다.
4. `settings`는 필드별로 마지막 유효값이 현재 상태다.
5. `reset`을 만나면 entry 목록, 목차, 핀, reply-target, 브로드캐스트 상태를 비우고, `questionMode`는 `cleaned`, `maxResponseChars`는 3000, `maxUnseenEvents`는 20으로 되돌린 뒤 이후 이벤트를 적용한다.
6. `clientRef` 중복 판정과 entry 번호는 초기화 이전 줄까지 포함해 계산한다.

### 4.6 현재 상태 기본값

| 항목 | 기본값 |
|---|---|
| `questionMode` | `cleaned` |
| `maxResponseChars` | `3000` (`0`은 무제한) |
| `maxUnseenEvents` | `20` (`0`은 무제한) |
| 목차 | `{done:false, items:[]}` |
| 핀, reply-target, 브로드캐스트 | 없음 |

## 5. HTTP API

### 5.1 공통 규칙

- 모든 API 응답은 `application/json; charset=utf-8`, `Cache-Control: no-store`다.
- 요청 본문은 JSON이며 최대 2,000,000바이트다. 본문이 비어 있으면 `{}`로 처리한다.
- 인증이 없다. 기본은 `127.0.0.1`에만 바인드한다. 브로드캐스트를 켜면 `0.0.0.0`에 바인드하므로 LAN에서도 모든 API를 호출할 수 있다. `POST /api/broadcast`만 예외로 loopback 요청에서만 받는다.
- 브라우저 화면이 보내는 쓰기 요청은 `X-Ineedbetterui-UI: 1` 헤더를 붙이며, 핀·reply-target 이벤트의 `source`가 `user`가 된다.
- 모든 쓰기 요청 본문은 선택 필드 `knownHead`를 받는다([6.3절](#63-동기화)).

**실패 응답**

~~~json
{"ok":false,"error":"설명","written":false}
~~~

| 상태 코드 | 경우 |
|---|---|
| `400` | 검증 실패, JSON 파싱 실패, 본문 크기 초과, 대상 없음, 글자수 한도 초과 |
| `404` | 없는 API 경로, 지원하지 않는 entry 하위 경로, 화면이 아닌 경로 |
| `500` | 처리 중 예외 |

글자수 한도 초과일 때만 `maxResponseChars`와 `length`가 추가된다([6.2절](#62-응답-글자수-한도)).

**쓰기 성공 응답의 공통 필드**

| 필드 | 설명 |
|---|---|
| `ok` | `true` |
| `written` | 이번 요청으로 JSONL에 줄이 추가됐으면 `true` |
| `state` | 쓰기 직후의 `GET /api/state` 결과 |
| `sync` | 동기화 결과([5.3절](#53-sync-객체)) |
| `entry` | entry 관련 API만. 새 entry와 중복 요청은 전체 표현, 노트·수정본은 요약 표현 |

### 5.2 엔드포인트 요약

| 메서드 | 경로 | 용도 | 성공 코드 |
|---|---|---|---|
| `GET` | `/api/health` | 헬스체크, 세션 확인 | `200` |
| `GET` | `/api/state` | 현재 상태 요약 | `200` |
| `GET` | `/api/sync` | 모르는 이벤트 조회, 최근 이벤트 명시 요청 | `200` |
| `GET` | `/api/entries` | entry 목록 | `200` |
| `GET` | `/api/entries/:id` | entry 하나의 전체 표현 | `200` |
| `POST` | `/api/entries` | entry 추가 | `201`, 중복 `clientRef`는 `200` |
| `POST` | `/api/entries/:id/notes` | 노트 추가 | `201` |
| `POST` | `/api/entries/:id/revisions` | 본문 수정 | `201` |
| `PATCH` | `/api/settings` | 질문 모드·글자수 한도·동기화 최대 개수 변경 | `200` |
| `POST` | `/api/broadcast` | 브로드캐스트 켜기·끄기(loopback 전용) | `200`, 이미 같은 상태면 `written:false` |
| `PATCH` | `/api/outline` | 목차 교체 | `200` |
| `POST` | `/api/pin` | 핀 설정·해제 | `200` |
| `POST` | `/api/reply-target` | Add reply 대기 설정·해제 | `200` |
| `POST` | `/api/reset` | 초기화 | `200` |
| `GET` | `/`, `*.html` | 기록 화면 | `200` |

### 5.3 sync 객체

~~~json
{
  "head": "9c1f0b7a2e4d3c58",
  "eventCount": 42,
  "status": "behind",
  "unseenCount": 2,
  "truncated": false,
  "unseen": [
    {"hash":"5d2e...","t":"settings","time":"...","questionMode":"raw"},
    {"hash":"9c1f...","t":"entry","time":"...","id":"a-31","kind":"report","heading":"","preview":"앞 200자...","length":1280,"truncated":true}
  ]
}
~~~

| 필드 | 설명 |
|---|---|
| `head` | 현재 마지막 해시. 에이전트는 이 값을 다음 `knownHead`로 쓴다. |
| `eventCount` | 해시 체인의 줄 수 |
| `status` | `current`, `behind`, `none`, `unknown` ([6.3절](#63-동기화)) |
| `unseenCount` | 모르는 이벤트 수. `none`·`unknown`이면 `null` |
| `truncated` | `unseen`이 모르는 이벤트 중 최근 일부만 담았으면 `true` |
| `unseen` | 이벤트 요약 배열, 파일 순서 |

**이벤트 요약**

모든 요약에는 `hash`, `t`, `time`이 있다. JSON이 아닌 줄은 `{"hash":"...","t":"invalid"}`다.

| `t` | 추가 필드 |
|---|---|
| `entry` (질문) | `id`, `kind`, `heading`, `body`(전문), `questionMode`, 있으면 `replyTo` |
| `entry` (그 외) | `id`, `kind`, `heading`, 있으면 `replyTo`·`broadcastUrl`, 본문 표현 |
| `note` | `id`, `target`, `anchor`, `title`, `text`(전문) |
| `revision` | `id`, `target`, 대상이 질문이면 `body`(전문), 아니면 본문 표현 |
| `pin`, `reply-target` | `target`, `source` |
| `outline` | `done`, `items` |
| `settings` | 이벤트에 있던 `questionMode`, `maxResponseChars`, `maxUnseenEvents` |
| `broadcast` | `enabled`, `url`, `port` |
| `reset` | 없음 |

본문 표현은 200 code point 이하면 `{"body": 전문}`, 넘으면 `{"preview": 앞 200자, "length": 전체 길이, "truncated": true}`다. 전문은 `GET /api/entries/:id`로 받는다. QR 모듈 데이터는 요약에 넣지 않는다.

### 5.4 GET /api/health

서버가 살아 있는지와 어느 프로젝트의 서버인지 확인한다. 시작 절차([3.2절](#32-세션-자동-이어쓰기))가 사용한다.

~~~json
{"ok":true,"app":"ineedbetterui","sessionId":"3f9a1c2b7d4e","pid":1234,"port":47823,"broadcast":true}
~~~

### 5.5 GET /api/state

~~~json
{
  "mode": "record",
  "outline": [{"no":"2-2","title":"...","type":"report","status":"active","current":true}],
  "outlineDone": false,
  "pin": {"target":"a-13","source":"user","revisionCount":1},
  "replyTarget": null,
  "questionMode": "cleaned",
  "broadcast": null,
  "maxResponseChars": 3000,
  "maxUnseenEvents": 20,
  "head": "9c1f0b7a2e4d3c58",
  "eventCount": 42,
  "lastEntry": {"id":"a-14","kind":"report","time":"..."},
  "entryCount": 14
}
~~~

- `pin`: 대상이 현재 목록에 있고 질문이 아닐 때만 객체, 아니면 `null`
- `replyTarget`: 현재 핀 대상과 같을 때만 ID, 아니면 `null`
- `broadcast`: 브로드캐스트가 켜져 있으면 `{enabled:true, url, port, qr}`, 꺼져 있으면 `null`

### 5.6 GET /api/sync

| 쿼리 | 설명 |
|---|---|
| `knownHead` | 에이전트가 마지막으로 받은 head. 없으면 `none` |
| `limit` | 돌려받을 최대 개수. 없으면 설정값 `maxUnseenEvents`. `0`이면 무제한 |

~~~json
{"ok":true,"head":"...","eventCount":42,"status":"behind","unseenCount":5,"truncated":false,"unseen":[...]}
~~~

- `knownHead`가 체인에 있으면 그 이후 이벤트 중 최근 `limit`개를 돌려준다.
- `knownHead`가 없거나 체인에 없으면, `limit`을 1 이상으로 지정한 경우에만 최근 `limit`개 이벤트를 돌려주고 그 외에는 빈 배열이다. `unseenCount`는 `null`이다.

### 5.7 GET /api/entries

| 쿼리 | 기본값 | 설명 |
|---|---|---|
| `after` | 없음 | 이 ID 다음부터 반환. 찾지 못하면 처음부터 |
| `limit` | `50` | 1–1000으로 제한 |
| `last` | 없음 | 1 이상이면 최근 `last`개(최대 1000)를 반환. `after`, `limit`보다 우선 |
| `full` | 없음 | `1`이면 본문과 부가 정보 포함 |

~~~json
{"ok":true,"entries":[...],"nextAfter":"a-14","hasMore":false}
~~~

| 표현 | 필드 |
|---|---|
| 기본 | `id`, `kind`, `time`, `heading`, 있으면 `replyTo` |
| `full=1` | 기본 + `body`, `notes[]`, `revisions[]`, 있으면 `clientRef`. 질문이면 `rawBody`, `cleanedBody`, `questionMode`. 브로드캐스트 entry면 `broadcastId`, `broadcastUrl`, `broadcastPort`, `qr` |

### 5.8 GET /api/entries/:id

현재 목록에 있는 entry 하나를 `full=1` 표현으로 돌려준다. 없는 ID는 `400`이다.

~~~json
{"ok":true,"entry":{"id":"a-31","kind":"report","time":"...","heading":"","body":"전문","notes":[],"revisions":[]}}
~~~

### 5.9 POST /api/entries

~~~json
{"kind":"question","rawBody":"원문","cleanedBody":"정리본","heading":"","clientRef":"turn-14-q","knownHead":"..."}
{"kind":"report","body":"응답 본문","heading":"제목","clientRef":"turn-14-a","knownHead":"..."}
~~~

| 필드 | 필수 | 설명 |
|---|---|---|
| `kind` | 예 | [4.4절](#44-열거값)의 값 |
| `body` / `rawBody` / `cleanedBody` | 하나 이상 | 문자열 |
| `heading` | 아니오 | 문자열이 아니면 빈 문자열 |
| `clientRef` | 아니오 | 재시도 중복 방지 키 |
| `knownHead` | 아니오 | 동기화 기준 해시 |

**처리 순서**

1. `kind` 검증 → 본문 필드가 하나도 없으면 거부
2. 본문 결정
   - 질문: 빠진 `rawBody`·`cleanedBody`는 `body` → `rawBody` → `cleanedBody` 순서로 있는 값으로 채운다. 현재 `questionMode`가 `raw`면 `rawBody`, 아니면 `cleanedBody`를 `body`로 쓴다.
   - 그 외: `body` → `rawBody` → `cleanedBody` 순서로 있는 값을 쓴다.
3. 결정된 본문이 비어 있거나 공백뿐이면 거부
4. `clientRef`가 이미 있으면 새 줄을 쓰지 않고 `200 {ok, written:false, deduplicated:true, entry, state, sync}`
5. 질문이 아니면 글자수 한도 검사
6. 질문이 아니고 유효한 reply-target이 있으면 `replyTo`를 붙인다.
7. `201 {ok, written:true, entry, state, sync}`. `sync`에서 방금 쓴 entry는 모르는 이벤트로 치지 않는다.

### 5.10 POST /api/entries/:id/notes

~~~json
{"anchor":"추정값","title":"추정값이란?","text":"주어진 정보로 예상한 값입니다.","knownHead":"..."}
~~~

- `text`는 필수이며 공백뿐이면 거부한다. `anchor`, `title`은 선택이다.
- 대상은 **현재 핀된 응답**이어야 한다. 질문 entry이거나 현재 핀 대상이 아니면 `400`으로 거부한다. 새 entry를 만들지 않는다.
- 응답의 `anchorFound`는 `anchor`가 비어 있지 않고 대상 표시 본문에 그 문자열이 들어 있을 때만 `true`다.
- 응답의 `entry`는 요약 표현 `{id, kind, time, heading, replyTo?, noteCount, revisionCount}`이다.
- 노트에는 글자수 한도를 적용하지 않는다. 핀을 해제하거나 다른 응답으로 바꿔도 이미 추가한 노트는 남는다.

### 5.11 POST /api/entries/:id/revisions

~~~json
{"body":"최신 본문 전체","knownHead":"..."}
~~~

- `body`는 필수이며 **최신 본문 전체**를 보낸다. 서버는 부분 문자열인지 판별하지 않고 받은 값으로 교체한다.
- 대상이 질문이 아니면 글자수 한도를 검사한다.
- 원본과 이전 수정본은 `revisions[]`에 남는다. 응답의 `entry`는 5.10절과 같은 요약 표현이다.

### 5.12 PATCH /api/settings

~~~json
{"questionMode":"raw"}
{"maxResponseChars":2000}
{"maxUnseenEvents":50}
~~~

- 세 필드 중 하나 이상 필요하다.
- `questionMode`는 `cleaned`·`raw`, `maxResponseChars`와 `maxUnseenEvents`는 0 이상의 정수만 허용한다.
- 보낸 필드만 담은 `settings` 이벤트를 쓴다. 다음 요청부터 바로 적용되고 재시작 후에도 유지된다.

### 5.13 PATCH /api/outline

~~~json
{"done":false,"items":[{"no":"1","title":"항목","type":"report","status":"done"},{"no":"2","title":"다음","type":"decision","status":"active","current":true}]}
{"done":true}
~~~

- `done`은 boolean이어야 한다. `done:true`면 `items`를 빈 배열로 저장한다.
- `items`는 배열이면 그대로 저장하고, 항목 내부는 검증하지 않는다. 화면이 읽는 키는 `no`, `title`, `type`, `status`, `current`다.

### 5.14 POST /api/pin

~~~json
{"target":"a-13"}
{"target":null}
~~~

- `target`은 entry ID 문자열 또는 `null`이다. 없는 ID와 질문 entry는 거부한다.
- 핀은 최대 하나다. 새로 핀하면 이전 핀을 대체한다.

### 5.15 POST /api/reply-target

~~~json
{"target":"a-13"}
{"target":null}
~~~

- 현재 핀된 응답만 지정할 수 있다.
- 설정되면 다음에 기록되는 **질문이 아닌** entry 하나에 `replyTo`가 붙고 대기가 자동 해제된다. 질문 entry는 대기를 소비하지 않는다.

### 5.16 POST /api/reset

~~~json
{"confirm":true}
~~~

`confirm`이 `true`가 아니면 거부한다. 기존 줄은 그대로 두고 `reset` 이벤트만 추가한다.

## 6. 기능별 규칙

### 6.1 질문 표현 모드

| 사이드바 체크박스 | `questionMode` | 질문 entry의 `body` |
|---|---|---|
| 체크(기본) | `cleaned` | `cleanedBody` |
| 해제 | `raw` | `rawBody` |

- 질문 entry에는 두 표현과 기록 당시 모드가 함께 저장된다.
- 모드를 바꿔도 과거 entry는 바뀌지 않는다.
- 화면의 질문 카드에는 `AI-cleaned` 또는 `Original` 라벨이 붙는다.

**정리본 작성 기준 (에이전트용)**

- 의도, 조건, 요구 강도를 보존한다.
- 새 요구, 배경, 판단을 추가하지 않는다.
- 인사, 감탄, 반복, "사용자가 질문함" 같은 메타 문구를 넣지 않는다.
- 한 문장 또는 짧은 문단으로 쓴다.
- 이해되지 않는 부분은 임의로 보완하지 않고 확인이 필요한 부분만 의문형으로 남긴다.

### 6.2 응답 글자수 한도

- **적용 대상**: 질문이 아닌 새 entry의 본문, 질문이 아닌 entry의 revision 본문
- **미적용**: 질문, `heading`, 노트
- **계산**: `Array.from(body).length` (Unicode code point 수)
- **기본값**: 3000. `0`은 무제한
- **설정**: 화면 설정 패널의 `Max response chars` 또는 `PATCH /api/settings`. 실행 인자는 없다.
- **검사 시점**: 서버가 쓰기 요청을 받은 시점의 한도. 에이전트가 미리 조회할 필요는 없다.
- **초과 시**: 저장하지 않고 본문도 자르지 않는다.

~~~json
{"ok":false,"error":"응답 본문은 최대 2000자까지 기록할 수 있습니다. (현재 2450자)","written":false,"maxResponseChars":2000,"length":2450}
~~~

에이전트는 반환된 `maxResponseChars`에 맞춰 응답을 나누거나 다시 작성해서 보낸다.

### 6.3 동기화

에이전트가 로그 전체를 반복해서 받지 않도록, 서버는 에이전트가 마지막으로 본 지점(`knownHead`) 이후의 이벤트만 돌려준다.

| `status` | 조건 | `unseen` |
|---|---|---|
| `current` | `knownHead` 이후 이벤트가 없음(이번 요청이 쓴 이벤트 제외) | 빈 배열 |
| `behind` | `knownHead` 이후 다른 이벤트가 있음 | 최근 최대 `maxUnseenEvents`개. 넘으면 `truncated: true` |
| `none` | `knownHead`를 보내지 않음 | 빈 배열(`GET /api/sync`에서 `limit` 지정 시 최근 `limit`개) |
| `unknown` | `knownHead`가 체인에 없음(다른 기록의 해시, 파일의 기존 줄 변경 등) | 빈 배열(`GET /api/sync`에서 `limit` 지정 시 최근 `limit`개) |

- 브라우저에서 사용자가 한 핀·설정 변경, 초기화, 다른 에이전트의 기록이 모두 이벤트로 잡힌다.
- `maxUnseenEvents`는 설정 패널의 `Max unseen events`(기본 20, `0`은 무제한) 또는 `PATCH /api/settings`로 정한다.
- 명시적 요청 방법은 [11.1절](#111-기본-흐름)에 있다.

### 6.4 핀과 Add reply

- 핀 대상은 질문이 아닌 entry 하나다.
- 핀된 응답은 본문 위쪽의 고정 영역에 표시되고, 일반 목록에서도 그대로 보인다.
- Add reply를 켜면 다음 비질문 응답이 `replyTo`로 연결된다.
- 부모가 핀된 동안 그 `replyTo` entry는 **핀 영역의 reply 목록에만** 표시되고 일반 목록에서는 빠진다. 핀을 해제하거나 다른 응답으로 바꾸면 일반 목록으로 돌아온다. 데이터는 어느 경우에도 삭제되지 않는다.

### 6.5 노트

- 본문 안에서 `anchor` 문자열이 처음 나오는 위치 바로 뒤에 `<aside class="note">`로 들어간다. 위치를 찾지 못하면 본문 끝에 붙는다.
- 제목이 없으면 `Note`로 표시한다. 노트 텍스트도 마크다운으로 렌더링한다.

### 6.6 목차

- `no`에 `-`가 들어 있으면 하위 항목으로 들여쓴다(예: `2-1`).
- `current:true` 행은 굵게 표시하고 `aria-current="step"`을 붙인다.
- `done:true`이거나 항목이 없으면 목차 영역을 숨긴다.
- 에이전트 운영 규칙: 설명·수정 세션을 시작하면 전체 항목을 원래 순서대로 보내고, 상태가 바뀔 때마다 전체 목록을 다시 보낸다. 끝나면 `{"done":true}`를 보낸다.

## 7. 화면

### 7.1 레이아웃

| 영역 | 동작 |
|---|---|
| 사이드바 | 화면 왼쪽 고정. 닫히면 56px 레일, 열리면 오버레이. 초기 상태는 닫힘. 배경을 클릭하면 닫힌다. |
| 핀 영역 | 본문 상단 `position: sticky`. 하단 핸들로 높이 96px–80vh 조절. 내용이 넘치면 내부 스크롤 |
| 대화 목록 | 오래된 entry가 위, 최신이 아래. 질문은 오른쪽, 응답은 왼쪽으로 치우친 채팅 형태 |

### 7.2 사이드바 구성 (위에서 아래)

| 요소 | 열린 상태 | 닫힌 레일 |
|---|---|---|
| 제목 `I Need Better UI`, 열기·닫기 버튼 | 표시, X 아이콘 | 햄버거 아이콘 |
| `Pinned` 체크박스 | 핀 영역 표시 여부(화면 전용) | `P` |
| `Use AI-cleaned questions` 체크박스와 힌트 | 질문 모드 전환 | `AI`, 힌트 숨김 |
| `Entry colors` 범례 | 종류 이름과 설명 | `Q/R/D/E/D/O` |
| `Outline` 표 | 열 경계 드래그로 너비 조절, 하단 핸들로 높이 조절 | 숨김 |
| 하단 테마 버튼 | 아이콘과 `Dark Mode`·`Light Mode` | 아이콘만 |
| 하단 설정(톱니바퀴) 버튼 | 테마 버튼 오른쪽 끝에 배치. 누르면 설정 패널 열림 | 숨김 |

**설정 패널**

톱니바퀴를 누르면 푸터 위에 열린다. `Esc`, 바깥 클릭, 사이드바를 접으면 닫힌다. 사이드바가 접혀 있으면 버튼과 패널 모두 보이지 않는다.

| 항목 | 동작 |
|---|---|
| `Max response chars` 숫자 입력과 힌트 | 글자수 한도 변경. 다음 응답부터 적용된다 |
| `Max unseen events` 숫자 입력과 힌트 | 동기화 최대 개수 변경 |
| `Broadcast access` 체크박스와 힌트 | `POST /api/broadcast`로 켜고 끈다. 상태에 따라 힌트 문구가 바뀐다 |
| QR 코드·주소 링크·복사 버튼 | 브로드캐스트가 켜져 있을 때만 표시 |

- 사이드바 폭은 오른쪽 경계를 드래그하거나 포커스 후 `←`·`→`(16px), `Home`·`End`로 조절한다. 범위는 `min(84vw, 320px)`부터 그 두 배(화면 폭 이내)까지다.
- 숫자 입력은 `change`(Enter 또는 포커스 이탈) 때 저장한다. 0 이상의 정수가 아니거나 서버가 거부하면 이전 값으로 되돌린다. 입력칸에 포커스가 있는 동안에는 polling이 값을 덮어쓰지 않는다.

### 7.3 entry 카드

- 상단에 시각(영어 `Intl.DateTimeFormat`, medium 날짜 + short 시간), 종류 라벨, 질문이면 모드 라벨을 표시한다.
- `heading`이 있으면 제목으로 표시한다(인라인 마크다운 적용).
- 일반 목록의 비질문 entry 오른쪽 위에 핀 버튼이 있다. 빈 윤곽선은 미선택, 채워진 아이콘은 현재 핀이다.
- 핀 영역의 entry에는 `Add reply` 버튼과 핀 아이콘이 붙는다. Add reply가 켜지면 버튼이 accent 색으로 채워진다.

### 7.4 갱신과 스크롤

- 2초마다 `GET /api/state`를 `cache: "no-store"`로 조회한다. entry 수, 마지막 ID, 핀, reply-target, 브로드캐스트, 목차, 질문 모드, 글자수 한도, 동기화 최대 개수가 모두 같으면 아무것도 하지 않는다.
- entry 수나 마지막 ID가 바뀌면 `GET /api/entries?after=<마지막 ID>&limit=1000&full=1`로 새 entry를 받아 기존 목록 뒤에 붙인다. `hasMore`가 `true`인 동안 `nextAfter`로 다음 페이지를 이어 받는다.
- 합친 개수가 `entryCount`와 맞지 않으면(초기화 등) 처음부터 모든 페이지를 다시 받는다.
- 갱신 전 위치를 기억해 복원한다.
  - 문서 하단(24px 이내)을 보고 있었으면 하단으로 이동
  - 상단(80px 이내)이면 상단 유지
  - 그 외에는 화면에 보이던 entry의 위치를 유지
  - 핀 영역 내부 스크롤도 같은 방식으로 유지
- 새로고침 직전 위치는 `sessionStorage`에 저장했다가 복원한다. 저장값이 없으면 최신 하단에서 시작한다.

### 7.5 브라우저 저장소 키

모든 키 뒤에는 페이지 경로(`location.pathname`)가 붙는다. 브라우저 저장소는 origin(주소와 포트)별로 나뉘므로 포트가 바뀌면 이전 값이 보이지 않는다.

| 키 접두사 | 저장소 | 값 |
|---|---|---|
| `agent-theme:` | localStorage | `light`·`dark`. 없으면 시스템 설정을 따른다. |
| `agent-vis:` | localStorage | `{"pin":true}` |
| `agent-sidebar:v3:` | localStorage | `open`·`closed` |
| `agent-sidebar-width:` | localStorage | 사이드바 폭(px) |
| `agent-outline-h:` | localStorage | 목차 높이 |
| `agent-outline-columns:` | localStorage | 목차 네 열의 너비 비율 배열 |
| `agent-pinned-h:` | localStorage | 핀 영역 높이(px) |
| `agent-view:` | sessionStorage | 새로고침 직전 스크롤 위치 |

## 8. 마크다운 렌더링

렌더링은 브라우저에서 한다. 모든 텍스트는 먼저 HTML 이스케이프되므로 본문의 `<script>`나 이벤트 속성은 실행되지 않는다.

### 8.1 지원 문법

| 문법 | 규칙 |
|---|---|
| 문단 | 빈 줄로 구분. 문단 안의 줄바꿈은 `<br>` |
| 굵게 | `**텍스트**` |
| 인라인 코드 | 백틱 한 쌍. 구문 강조 없음 |
| 링크 | `[라벨](URL)`. URL이 `http://`, `https://`, `mailto:`, `/`, `#`로 시작할 때만 링크. 새 탭으로 연다. 그 외는 라벨만 표시 |
| 목록 | `- 항목`, `1. 항목`. 중첩 없음 |
| 표 | 헤더 줄 다음에 `---` 구분 줄. 가로 스크롤 |
| 코드 블록 | 백틱 세 개 또는 `~~~` 펜스 |

제목(`#`), 기울임, 인용문, 중첩 목록, 이미지는 지원하지 않으며 텍스트로 표시된다.

### 8.2 코드 블록

- 여는 펜스 줄이 백틱 세 개 또는 `~~~`로 시작하면 코드 블록이 시작된다. 닫는 펜스는 여는 펜스와 같은 종류여야 한다. 닫히지 않으면 본문 끝까지 코드다.
- 펜스 안은 마크다운으로 해석하지 않는다.
- 여는 펜스 뒤 첫 단어를 소문자로 읽어 언어 태그로 쓴다.
- 출력: `<pre class="code-block" data-lang="언어"><code>…</code></pre>`. `data-lang`에는 8.3절에서 정규화한 언어 이름(`js`, `json`, `py`, `bash`, `ps1`, `html`, `css`)이 들어간다. 태그가 없거나 인식하지 못하면 붙이지 않는다.

### 8.3 구문 강조

| 언어 | 인식하는 태그 |
|---|---|
| `js` | `js`, `javascript`, `mjs`, `cjs`, `jsx`, `ts`, `typescript`, `tsx` |
| `json` | `json`, `jsonl` |
| `py` | `py`, `python` |
| `bash` | `sh`, `bash`, `zsh`, `shell` |
| `ps1` | `ps1`, `powershell`, `pwsh` |
| `html` | `html`, `xml`, `svg` |
| `css` | `css` |

태그는 대소문자를 구분하지 않는다. 그 밖의 태그나 태그 없음은 강조 없이 이스케이프한 원문만 출력한다.

**판정 순서 (html 제외)**

토크나이저는 코드를 앞에서부터 한 번 훑으며 위치마다 아래 순서로 판정한다. 어느 것에도 해당하지 않는 문자는 이스케이프만 해서 출력한다.

| 순서 | 판정 | js | json | py | bash | ps1 | css |
|---|---|---|---|---|---|---|---|
| 1 | 여러 줄 주석 → `tok-comment` | `/* */` | — | — | — | `<# #>` | `/* */` |
| 2 | 한 줄 주석 → `tok-comment` | `//` | — | `#` | `#` ¹ | `#` ¹ | — |
| 3 | 문자열 → `tok-string` | 따옴표, 템플릿 | 따옴표 ² | 따옴표 | 따옴표 | 따옴표 | 따옴표 |
| 4 | 이름 → 아래 표 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 5 | 숫자 → `tok-number` | 정수·소수 | 정수·소수 | 정수·소수 | 정수·소수 | 정수·소수 | 단위 포함 ³ |

1. 코드 맨 앞이거나 앞 글자가 공백일 때만 주석이다. `${#arr}`의 `#`는 주석이 아니다.
2. 뒤에 `:`가 오는 JSON 문자열은 키로 보고 `tok-function`이다.
3. `px`, `em`, `rem`, `vh`, `vw`, `ms`, `s`, `%`

따옴표 문자열은 큰따옴표·작은따옴표이며 백슬래시 이스케이프를 인식한다. 닫는 따옴표가 없으면 그 줄 끝에서 끝난다. JS 템플릿 문자열(백틱)은 여러 줄에 걸칠 수 있다.

**이름 분류**

| 조건 | 토큰 |
|---|---|
| 언어별 키워드 | `tok-keyword` |
| CSS에서 `@`로 시작(`@media` 등) | `tok-keyword` |
| CSS의 `{ }` 안에서 뒤에 `:`가 옴 | `tok-function` (속성 이름) |
| PowerShell의 `Verb-Noun` 형태(`Write-Host` 등) | `tok-function` |
| js·py·bash·ps1에서 뒤에 `(`가 옴 | `tok-function` |
| 그 외 | 강조 없음 |

| 언어 | 키워드 |
|---|---|
| js | `as async await break case catch class const continue debugger default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while with yield` |
| json | `true false null` |
| py | `False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return self try while with yield` |
| bash | `case do done echo elif else esac exit export fi for function if in local return then until while` |
| ps1 (대소문자 무시) | `$false $null $true begin break catch class continue do else elseif end exit filter finally for foreach function if in param process return switch throw trap try until while` |
| css | `!important` |

**HTML**

| 대상 | 토큰 |
|---|---|
| `<!-- -->` | `tok-comment` |
| `<`·`</` 바로 뒤의 태그 이름 | `tok-keyword` |
| 태그 안의 속성 이름 | `tok-function` |
| 태그 안의 따옴표 값 | `tok-string` |
| 태그 밖의 텍스트 | 강조 없음 |

토크나이저에서 예외가 나면 강조 없이 이스케이프한 원문을 출력한다. 각 토큰은 이스케이프한 뒤 고정 클래스의 `span`으로만 감싸므로, 강조 여부와 관계없이 코드 내용이 HTML로 해석되지 않는다.

## 9. 스타일

### 9.1 테마

- 라이트·다크 테마는 CSS 변수로 정의하고 `<html data-theme>` 값으로 전환한다.
- 저장된 선택이 없으면 `prefers-color-scheme`을 따르고, 시스템 설정이 바뀌면 함께 바뀐다.

| 변수 | 용도 | light | dark |
|---|---|---|---|
| `--bg` | 페이지 배경 | `#f5f6fa` | `#141820` |
| `--fg` | 기본 글자 | `#202532` | `#eef1f7` |
| `--card` | 메시지 카드 | `#fff` | `#202632` |
| `--muted` | 보조 글자 | `#606879` | `#a8b2c4` |
| `--line` | 경계선 | `#d9dfea` | `#394456` |
| `--accent` | 강조, report 테두리 | `#245ac7` | `#94b7ff` |
| `--nested-bg` | 중첩 메시지 배경 | `#eef2f9` | `#283142` |
| `--code-bg` | 코드 블록 배경 | `#f6f8fa` | `#161b22` |

### 9.2 entry 종류 색

종류 색은 카드와 범례의 왼쪽 4px 테두리에만 쓴다.

| kind | 의미 | light | dark |
|---|---|---|---|
| `question` | 사용자 메시지 | `#8a92a3` | `#7d8699` |
| `report` | 진행·설명 | `#245ac7` | `#94b7ff` |
| `decision` | 사용자 판단 대기 | `#bb8b22` | `#d9a441` |
| `error` | 실패·막힌 단계 | `#de5964` | `#e8828b` |
| `done` | 완료 | `#329b77` | `#5fc79d` |
| `other` | 기타 | `#7a5ec2` | `#a98ff0` |

### 9.3 중첩 메시지

메시지 안에 들어가는 메시지는 바깥 카드와 배경을 다르게 한다.

| 대상 | 배경 | 테두리 |
|---|---|---|
| 본문 안의 노트 `.note` | `--nested-bg` | accent 3px 왼쪽 |
| 핀 영역 reply 목록의 entry `.reply-entry` | `--nested-bg` | kind 색 4px 왼쪽 |
| reply entry 안의 노트 | `--card` | accent 3px 왼쪽 |

### 9.4 코드 토큰 색

| 변수 | light | dark | 비고 |
|---|---|---|---|
| `--tok-comment` | `#656d76` | `#8b949e` | 기울임 |
| `--tok-string` | `#1a7f37` | `#7ee787` | |
| `--tok-keyword` | `#8250df` | `#c792ea` | |
| `--tok-number` | `#b35900` | `#ffa657` | |
| `--tok-function` | `#245ac7` | `#94b7ff` | |

코드 블록(`.entry pre.code-block`)은 `--code-bg` 배경, `1px solid var(--line)` 테두리, 8px 모서리, 줄바꿈 없음, 가로 스크롤이다. 노트나 reply 안에 있어도 배경은 `--code-bg`다.

## 10. 브로드캐스트

브로드캐스트는 같은 네트워크의 다른 기기에서 기록 화면을 열 수 있게 한다. **기본으로 꺼져 있으며**, 화면의 설정(사이드바 톱니바퀴)에서 켠다. `--broadcast`로 시작하면 처음부터 켜진 상태다.

**켜고 끄기**

1. `POST /api/broadcast`에 `{"on":true}` 또는 `{"on":false}`를 보낸다. **loopback(이 PC) 요청만 받는다.** LAN에서 온 요청은 400으로 거부한다.
2. 서버는 프로세스를 다시 시작하지 않고 바인딩만 바꾼다. `close()` 뒤 같은 포트로 `listen(port, '0.0.0.0' | '127.0.0.1')`을 한다. 포트, 기록, 서버 정보 파일은 그대로다.
3. 응답을 보낸 **뒤에** 바인딩을 바꾼다. 주소를 바꾸면 열려 있던 연결이 끊기기 때문이다. 화면과 에이전트는 다음 요청에서 자동으로 다시 연결한다.
4. 상태 변화는 `broadcast` 이벤트로 기록에 남아 `sync.unseen`으로 에이전트에게 전달된다.
5. 바인딩 변경이 실패하면 이전 상태로 되돌리고, `error`가 담긴 `broadcast` 이벤트를 남긴다.

~~~json
{"t":"broadcast","time":"...","enabled":true,"url":"http://192.168.0.77:47823/","port":47823,"source":"user"}
~~~

**접속 주소**

네트워크 인터페이스 중 **처음 나오는** 내부용이 아니고 `169.254.`로 시작하지 않는 IPv4 주소로 `http://IP:PORT/`를 만든다. 찾지 못하면 `127.0.0.1`을 쓴다.

**화면**

켜져 있으면 설정 패널에 QR 코드(흰 배경, 4모듈 여백의 SVG), 주소 링크, 복사 버튼을 표시한다. 복사는 보안 컨텍스트가 아니면(다른 기기에서 `http`로 열었을 때) 실패하며, 주소를 직접 선택해 복사하라고 안내한다. 기록에는 QR entry를 남기지 않는다. 이전 버전이 남긴 QR entry는 대화 목록에 그대로 표시한다.

**QR 인코더**

- 서버에 내장된 byte 모드 인코더이며 버전 4, 오류 정정 L로 고정이다(33×33 모듈).
- URL은 UTF-8 기준 **78바이트 이하**여야 한다. 넘으면 `브로드캐스트 URL이 QR 코드 용량을 초과합니다.` 예외로 시작이 실패한다.
- 8가지 마스크 중 벌점이 가장 낮은 것을 고른다.

**보안**

인증과 암호화가 없다. 기본은 이 PC에서만 접속할 수 있으므로, 브로드캐스트를 켜기 전에는 LAN에서 닿지 않는다. 켜는 순간부터 같은 네트워크의 누구나 화면을 보고 모든 쓰기 API(초기화 포함)를 호출할 수 있다. 켜고 끄는 것은 이 PC의 화면에서만 가능하다. Windows에서는 처음 실행할 때 방화벽이 `node.exe`의 네트워크 허용 여부를 물을 수 있다.

## 11. 에이전트 연동 가이드

### 11.1 기본 흐름

1. 스킬이 불리면 다른 요청이 없어도 되묻지 않고 곧바로 시작한다. 프로젝트 폴더를 작업 폴더로 두고 `node <스킬 폴더>/ineedbetterui.mjs`를 백그라운드로 실행하고 출력된 주소를 사용자에게 알려 준다. 주소를 모르거나 새 세션이면 같은 명령을 다시 실행한다. 서버가 실행 중이면 주소만 출력하고 끝난다.
2. 사용자 질문을 받으면 `POST /api/entries`로 질문을 기록한다. 마지막으로 받은 `sync.head`가 있으면 `knownHead`로 함께 보낸다.
3. 응답을 사용자에게 전달할 때 같은 API로 응답을 기록한다.
4. 모든 쓰기 응답의 `sync.head`를 기억하고, `sync.status`를 확인한다.
   - `behind`: `sync.unseen`을 읽어 사용자의 핀·설정 변경이나 다른 에이전트의 기록을 반영한다.
   - `none`·`unknown`: 로그를 받지 않았다. 필요할 때만 아래 명시적 요청을 쓴다.
5. 거부 응답(`written:false`)은 저장되지 않은 것이다. 글자수 한도 초과면 다시 작성해 보낸다. 재시도할 때는 같은 `clientRef`를 쓴다.

**명시적 요청**

| 필요한 것 | 요청 |
|---|---|
| 모르는 이벤트를 더 받기 (`truncated`) | `GET /api/sync?knownHead=<이전 head>&limit=N` |
| 최근 이벤트 N개 | `GET /api/sync?limit=N` |
| 최근 entry N개 | `GET /api/entries?last=N&full=1` |
| 미리보기로 온 응답의 전문 | `GET /api/entries/<id>` |

### 11.2 호출 예시 (PowerShell)

~~~powershell
$base = 'http://127.0.0.1:47823'
$knownHead = $null

function Send-Entry($payload) {
  if ($script:knownHead) { $payload.knownHead = $script:knownHead }
  $json = $payload | ConvertTo-Json -Depth 5
  $result = Invoke-RestMethod -Method Post -Uri "$base/api/entries" -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($json))
  $script:knownHead = $result.sync.head
  if ($result.sync.status -eq 'behind') { $result.sync.unseen | ForEach-Object { "unseen: $($_.t) $($_.id)" } }
  $result
}

Send-Entry @{ kind = 'question'; rawBody = '원문 질문'; cleanedBody = '정리한 질문'; clientRef = 'turn-14-q' }
Send-Entry @{ kind = 'report'; heading = '결과'; body = "응답 본문`n~~~js`nconst a = 1;`n~~~"; clientRef = 'turn-14-a' }
~~~

`Invoke-RestMethod`는 `4xx` 응답에서 예외를 던진다. 한도 초과 본문을 읽으려면 예외의 `ErrorDetails.Message`를 JSON으로 파싱한다.

### 11.3 권장 프롬프트

**기록 공통**

~~~text
이 스레드의 사용자 질문과 사용자에게 전달할 응답을 ineedbetterui에 기록한다.
질문은 실제 원문을 rawBody로 보존하고, 의미·조건·요구 강도를 유지한 cleanedBody를 함께 만든다.
cleanedBody에는 인사·메타 문구·새로운 요구를 추가하지 않는다.
응답에는 내부 추론과 도구 호출 원문을 넣지 않는다.
같은 요청을 재시도할 때는 같은 clientRef를 사용한다.
쓰기 요청마다 마지막으로 받은 sync.head를 knownHead로 보내고, 로그 전체를 요청하지 않는다.
기록 실패는 저장되지 않은 것으로 보고하고 기존 기록은 변경하지 않는다.
~~~

**질문 정리**

~~~text
다음 사용자 입력을 한 문장 또는 짧은 문단의 cleanedBody로 정리하라.
- 의도, 조건, 요구 강도를 유지하라.
- 새로운 요구, 배경, 판단을 추가하지 마라.
- 인사, 감탄, 반복, 메타 문구를 제거하라.
- 입력이 불명확하면 임의로 보완하지 말고 확인이 필요한 부분만 의문형으로 남겨라.
출력은 정리된 질문 본문만 작성하라.

rawBody:
{{USER_RAW_BODY}}
~~~

**응답 기록**

~~~text
다음 응답을 사용자에게 전달할 공개 본문으로 기록하라.
- 내부 추론, 도구 호출 원문, 실행 환경의 비공개 세부사항은 제외하라.
- 사용자가 요청한 조건·강도·결과를 누락하거나 임의로 완화하지 마라.
- 글자수 한도를 미리 조회하지 않는다. 서버가 한도 초과로 거부하면 응답에 담긴 maxResponseChars에 맞춰, 임의로 자르지 말고 나누거나 다시 작성해 보낸다.
kind: {{KIND}}
body:
{{PUBLIC_RESPONSE}}
~~~

### 11.4 Codex(ChatGPT)에서 사용

같은 스킬 폴더를 OpenAI Codex에서도 쓸 수 있다. 아래는 2026-09-14에 Codex CLI 0.154.0(Windows, `elevated` 샌드박스)과 `codex sandbox` 명령으로 확인한 내용이다.

| 항목 | 내용 |
|---|---|
| 스킬 위치 | 프로젝트의 `.agents/skills/ineedbetterui/` 또는 `~/.agents/skills/ineedbetterui/` |
| 호출 | CLI·IDE 확장: `$ineedbetterui` (목록은 `/skills`). 데스크톱 앱: `@`를 입력하고 스킬 선택. 스킬 이름만 보내도 에이전트가 되묻지 않고 서버를 시작해 주소를 알려 준다(`SKILL.md` 규칙) |
| 기록 쓰기 | 기록 폴더가 작업 폴더 안(`node_modules/.ineedbetterui`)이라 `workspace-write` 샌드박스에서도 추가 설정 없이 쓸 수 있다. 샌드박스가 작업 폴더 쓰기를 허용하는 것은 확인했지만, 이 위치로 바꾼 뒤 실제 Codex 세션에서는 아직 확인하지 않았다 |
| 쓰기가 막힐 때 | 사용자가 일반 터미널에서 서버를 먼저 띄운다. 샌드박스 안의 에이전트도 그 서버에 기록할 수 있음을 확인했다 |
| localhost | 샌드박스 안에서도 포트 열기(`127.0.0.1`, `0.0.0.0`)와 `127.0.0.1` 접속이 된다 |
| 백그라운드 프로세스 | `codex sandbox`로 실행한 명령이 끝난 뒤에도 분리 실행한 자식 프로세스는 계속 실행됐다. 실제 에이전트 세션에서의 동작은 확인하지 않았다 |
| LAN 접속 | 샌드박스 사용자의 방화벽 규칙 때문에 다른 기기에서 접속하지 못할 수 있다. 확인하지 않았다 |

~~~powershell
codex -C <프로젝트> -c 'sandbox_mode="workspace-write"'
~~~

- `sandbox_mode`는 `config.toml`에도 쓸 수 있다. 신뢰한 프로젝트의 `.codex/config.toml`도 읽는다.
- 저장소의 `tester/start-codex-test.ps1`이 테스트 프로젝트 준비와 이 실행을 대신한다([12.3절](#123-codex-테스트-실행기)).

## 12. 테스트 도구

### 12.1 테스터 서버 스크립트

`tester/restart-ineedbetterui.ps1`은 저장소의 최신 `ineedbetterui.mjs`를 `tester` 폴더를 프로젝트로 삼아 다시 띄운다.

~~~powershell
.\tester\restart-ineedbetterui.ps1
.\tester\restart-ineedbetterui.ps1 -NoBroadcast
~~~

| 매개변수 | 기본값 | 설명 |
|---|---|---|
| `-NoBroadcast` | 꺼짐 | `--no-broadcast` 추가 |

**동작**

1. `tester` 폴더가 프로젝트이므로 기록은 `tester/node_modules/.ineedbetterui/`에 쌓인다. 저장소 `.gitignore`의 `node_modules/` 대상이다.
2. 그 폴더의 서버 정보 파일마다 헬스체크해서, 응답하는 서버를 PID로 종료하고 파일을 지운다.
3. `tester` 폴더에서 `node ..\plugins\ineedbetterui\skills\ineedbetterui\ineedbetterui.mjs [--no-broadcast]`를 같은 콘솔로 실행한다.
4. 서버가 뜨면 `/api/state`를 확인해 목차가 비어 있을 때 예시 목차를 `PATCH /api/outline`으로 넣는다.
5. 서버 프로세스가 끝날 때까지 기다리고 그 종료 코드로 끝난다.

### 12.2 자동 테스트

~~~bash
node tests/run-all.mjs
~~~

| 파일 | 확인하는 것 |
|---|---|
| `tests/sync-test.mjs` | 저장 위치와 git 제외, 세션 이어쓰기, 해시 동기화, `GET /api/entries/:id`, 재시작 후 해시 유지, 폴더 이동, 브로드캐스트 기본 꺼짐과 전환, 설정 패널 요소, 화면 스크립트 컴파일 |
| `tests/render-test.mjs` | 구문 강조, 마크다운 이스케이프, 노트 규칙, 1000개가 넘는 entry 페이징 |
| `tests/core-test.mjs` | 질문 모드, 중복 방지, 글자수 한도, 핀·Add reply, 수정본, 목차, 재시작 후 상태 유지, 초기화 |
| `tests/cli-test.mjs` | npm 패키지 내용, `npm pack`, 임시 위치 전역 설치, 설치 스크립트의 스킬 등록, 사용자 폴더 보호, `ineedbetterui` 시작·`stop`과 기록 위치, 프로젝트 안 설치, `uninstall`, `npm uninstall -g` |

- 각 파일은 따로 실행할 수도 있다. 예: `node tests/sync-test.mjs`
- `cli-test.mjs`는 `USERPROFILE`·`HOME`, `CODEX_HOME`을 임시 폴더로 바꾸고 전역 설치 위치도 임시 `--prefix`로 지정한다. 실제 사용자 폴더와 전역 npm을 건드리지 않는다.
- 테스트마다 임시 폴더에 프로젝트 폴더를 만들고 끝나면 지운다. 기록은 그 프로젝트 안에 생기므로 실제 프로젝트와 `tester/`의 기록은 건드리지 않는다.
- 항목마다 `PASS`·`FAIL`을 출력하고, 하나라도 실패하면 종료 코드 1로 끝난다. `run-all.mjs`는 네 파일을 차례로 실행하고 하나라도 실패하면 종료 코드 1로 끝난다.
- 실행 중인 폴더 이동 차단은 Windows에서만, git 제외 확인은 `git` 명령이 있을 때만 실행한다.
- 브로드캐스트 전환 확인은 `0.0.0.0`에 바인드하므로 Windows 방화벽이 허용 여부를 물을 수 있다.
- 브라우저 화면의 실제 표시와 정상 종료 시 서버 정보 파일 삭제는 자동 테스트 범위 밖이다.

### 12.3 Codex 테스트 실행기

`tester/start-codex-test.ps1`은 Codex CLI로 스킬을 가볍게 시험할 수 있게 준비하고 실행한다. 사용자 전역 설정이나 전역 스킬 폴더는 바꾸지 않는다.

~~~powershell
.\tester\start-codex-test.ps1             # 준비하고 Codex 실행
.\tester\start-codex-test.ps1 -NoLaunch   # 준비만 하고 실행 명령 출력
~~~

1. 저장소의 스킬 원본 폴더를 복사해 `tester/codex-project/.agents/skills/ineedbetterui/`를 최신으로 바꾼다.
2. `tester/codex-project`를 작업 폴더로 두고 `sandbox_mode="workspace-write"`로 Codex CLI를 실행한다. 이 설정은 그 실행에만 적용된다. 기록은 `tester/codex-project/node_modules/.ineedbetterui/`에 쌓인다.

`tester/codex-project/`는 `.gitignore` 대상이다.

## 13. 알려진 제한

현재 코드의 한계와, 의도한 설계와 다르게 동작하는 부분이다. 고치면 이 목록과 해당 절을 함께 갱신한다.

### 13.1 렌더링

| 항목 | 현재 동작 |
|---|---|
| 구문 강조 정확도 | 정규식 기반의 가벼운 토크나이저라 JS 정규식 리터럴, Python 삼중 따옴표 문자열, 셸 heredoc, TypeScript 타입 이름 등은 정확히 칠하지 못한다. |
| 마크다운 범위 | 제목, 기울임, 인용문, 중첩 목록, 이미지를 지원하지 않는다. |
| 노트·수정본 실시간 반영 | 노트나 revision을 추가해도 entry 수와 마지막 ID가 바뀌지 않으므로, 열려 있는 화면은 entry 목록을 다시 받지 않는다. 새로고침해야 보인다. |

### 13.2 API와 데이터

| 항목 | 현재 동작 |
|---|---|
| revision | 부분 본문 여부를 판별하지 않는다. 질문 entry도 수정할 수 있다. |
| `clientRef` | 초기화 이전 기록의 `clientRef`와 같으면 새로 쓰지 않고 이전 entry를 돌려준다. |
| 성능 | 쓰기마다 파일 전체를 다시 읽고 해시를 다시 계산한다. 기록이 커질수록 쓰기 지연이 늘어난다. |
| 파일 직접 수정 | 해시를 파일에 저장하지 않으므로, 기존 줄이 바뀌면 `unknown`으로만 알 수 있고 어느 줄이 바뀌었는지는 알려 주지 않는다. |
| 이전 이름의 기록 | 이전 버전이 만든 `agent-transcript.private.jsonl`(프로젝트 폴더)이나 `i-need-better-ui` 데이터 폴더의 기록을 새 위치로 옮기지 않는다. |
| 기록 삭제 | `node_modules`를 지우거나 새로 만드는 작업(`npm ci` 등)을 하면 기록도 지워진다. 백업이나 경고는 없다. |
| JS가 아닌 프로젝트 | 기록 때문에 `node_modules` 폴더가 생긴다. git에서는 제외되지만 에디터나 도구가 JS 프로젝트로 볼 수 있다. |

### 13.3 서버와 네트워크

| 항목 | 현재 동작 |
|---|---|
| 동시 시작 | 같은 프로젝트에서 거의 동시에 두 번 실행하면 둘 다 실행 중인 서버가 없다고 판단해 같은 기록 파일을 쓰는 서버가 둘 뜰 수 있다. 서로 상태를 모르므로 entry ID가 겹칠 수 있다. |
| 종료 | npm으로 설치했으면 `ineedbetterui stop`으로 종료한다. 스킬 폴더만 쓸 때는 프로세스를 직접 종료한다. Windows에서 `stop`은 프로세스를 강제 종료하며, 남은 서버 정보 파일은 `stop`이 지운다. |
| 인증 | 없음. 브로드캐스트를 켜 두면 LAN의 누구나 쓰기·초기화할 수 있다. |
| 브로드캐스트 전환 | 바인딩을 바꾸는 동안 열려 있던 연결이 끊긴다. 화면과 에이전트는 다음 요청에서 다시 연결한다. 전환 직후 한 번의 요청이 실패할 수 있다. |
| 복사 버튼 | 보안 컨텍스트가 아닌 `http` 접속에서는 클립보드 API가 막혀 복사가 실패한다. 주소를 직접 선택해 복사해야 한다. |
| 폴더 이동 보호 | Windows에서만 동작한다. macOS·Linux에서는 실행 중에 폴더를 옮겨도 서버가 막지 않는다. 서버는 옛 경로로 계속 쓰려고 하므로, 서버를 끈 뒤 옮긴다. |
| 접속 주소 | 처음 찾은 IPv4를 쓴다. VPN, WSL, Hyper-V 가상 어댑터가 먼저 잡히면 다른 기기에서 접속할 수 없는 주소가 될 수 있다. |
| QR 용량 | 78바이트를 넘는 URL은 인코딩할 수 없다. |
### 13.4 npm 배포

| 항목 | 현재 동작 |
|---|---|
| 설치 스크립트 차단 | `--ignore-scripts`처럼 설치 스크립트를 실행하지 않는 환경에서는 스킬이 등록되지 않는다. `ineedbetterui install`을 직접 실행한다. pnpm·Bun에서는 확인하지 않았다. |
| 제거 | npm은 제거 스크립트를 실행하지 않는다. `ineedbetterui uninstall`을 먼저 실행하지 않으면 스킬 폴더와 Codex 설정 블록이 남는다. |
| 스킬 복사본 | 스킬은 복사로 등록한다. 패키지를 업데이트하면 설치 스크립트가 다시 복사하지만, 스크립트가 실행되지 않으면 이전 SKILL.md가 남는다. |
| 지원 Node 버전 | Node.js v24에서만 확인했다. `engines`는 `>=24`다. |
| 운영체제 | 전체 흐름은 Windows에서만 확인했다. macOS·Linux 경로는 코드에 있지만 실제로 확인하지 않았다. |
