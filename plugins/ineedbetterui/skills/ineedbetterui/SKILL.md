---
name: ineedbetterui
description: 사용자와 에이전트의 대화를 로컬 기록 파일에 남기고 브라우저 화면(목차·핀·노트·코드 강조)으로 보여 준다. 사용자가 ineedbetterui를 부르거나, 이 대화를 브라우저에서 보기 좋게 기록해 달라고 할 때 사용한다.
---

# I Need Better UI

에이전트 대화를 브라우저에서 다시 읽을 수 있는 기록 화면으로 남기는 스킬이다. 서버와 화면은 `ineedbetterui.mjs` 하나로 제공하고, 기록은 프로젝트 폴더의 `node_modules/.ineedbetterui/`에 append-only JSONL로 저장한다.

사용자가 이 스킬을 부른 세션에서만 아래 기록 절차를 적용한다. 기록하는 응답에는 내부 추론이나 도구 호출 원문을 넣지 않는다.

## 시작

서버 실행 파일 `ineedbetterui.mjs`는 이 `SKILL.md`와 같은 폴더(스킬 폴더)에 있다. 기록할 프로젝트 폴더를 작업 폴더로 둔 채, 실행 파일은 스킬 폴더 경로로 지정해 실행한다. 새 서버가 뜨면 프로세스가 계속 실행되므로 백그라운드로 실행한다.

~~~bash
node <스킬 폴더>/ineedbetterui.mjs                  # 브로드캐스트(LAN 공개) 켜짐
node <스킬 폴더>/ineedbetterui.mjs --no-broadcast   # 이 PC에서만 접속
~~~

작업 폴더가 곧 기록 대상 프로젝트다. 스킬 폴더로 이동해서 실행하면 스킬 폴더가 프로젝트로 기록되므로 그렇게 하지 않는다.

- 같은 프로젝트의 서버가 이미 실행 중이면 새로 띄우지 않고 `ineedbetterui already running on http://127.0.0.1:PORT/`를 출력하고 끝난다. 새로 띄우면 `ineedbetterui listening on http://127.0.0.1:PORT/`와 기록 파일 경로를 출력한다. 주소를 사용자에게 알려 준다.
- 포트를 기억하거나 지정하지 않는다. 주소가 필요하면 같은 명령을 다시 실행한다.
- 같은 프로젝트의 서버가 다른 브로드캐스트 모드로 실행 중이면 오류로 멈춘다. 사용자에게 알리고, 기존 서버를 종료할지 확인한다.
- 서버가 기록 폴더를 만들지 못하면(`EPERM` 등) 임의로 다른 위치에 기록하지 말고 오류 메시지를 사용자에게 알린다. 사용자가 일반 터미널에서 프로젝트 폴더로 이동해 `ineedbetterui`로 서버를 먼저 띄우면, 같은 시작 명령이 "already running"으로 주소를 받는다.
- 서버 종료는 사용자가 프로젝트 폴더에서 `ineedbetterui stop`으로 한다.
- 서버가 실행 중인 동안 프로젝트 폴더를 옮기거나 이름을 바꾸지 않는다. 서버를 끈 뒤 옮기면 기록 폴더도 함께 옮겨져 이어 쓴다.
- Node를 설치하기 위해 사용자 승인 없이 런타임을 추가하지 않는다.

브로드캐스트는 기본으로 켜진다. 서버를 `0.0.0.0`에 바인드하고, 새 서버를 띄울 때 LAN 접속 URL QR 코드가 담긴 `other` entry를 한 번 append한다. 인증이 없으므로 같은 네트워크의 누구나 기록을 보고 쓰기·초기화할 수 있다. 신뢰할 수 없는 네트워크에서는 `--no-broadcast`로 실행한다.

## 저장 위치

기록은 프로젝트 폴더의 `node_modules/.ineedbetterui/`(기록 폴더)에 저장한다. 프로젝트마다 하나다.

~~~text
<프로젝트>/node_modules/.ineedbetterui/
  .gitignore          `*` 한 줄. 기록 폴더 전체를 git에서 제외
  transcript.jsonl    기록
  server-<포트>.html   실행 중인 서버 정보. 열면 기록 화면으로 이동
  project.json        프로젝트 경로와 세션 ID
~~~

- 대부분의 프로젝트가 `node_modules`를 무시하고, 그 규칙이 없는 저장소에서도 기록 폴더의 `.gitignore`가 기록을 제외한다. 기록 때문에 사용자에게 `.gitignore` 수정을 요청하지 않는다.
- `node_modules`를 지우거나 새로 만드는 작업(`npm ci` 등)은 기록도 지운다. 사용자가 그런 작업을 요청하면 기록이 사라진다는 점을 먼저 알린다.
- 세션 ID는 프로젝트 폴더 실제 경로의 SHA-256 앞 12자리이며, 실행 중인 서버를 찾는 데 쓴다.

기존 데이터는 초기화 요청이 없는 한 유지하고 이어 쓴다. 초기화는 `POST /api/reset`에 `{"confirm":true}`를 보낼 때만 수행하며, 기존 줄을 삭제하지 않고 reset 이벤트를 추가한다.

## 동기화

서버는 기록의 모든 줄로 해시 체인을 만들고, 마지막 해시를 `head`로 알려 준다. 에이전트는 로그 전체를 받지 않고, 자신이 모르는 이벤트만 받는다.

- 모든 쓰기 요청 본문에 마지막으로 받은 `sync.head`를 `knownHead`로 넣는다. 응답의 `sync.head`를 새 값으로 기억한다. 처음이거나 값을 잊었으면 넣지 않는다.
- 응답의 `sync.status`에 따라 처리한다.
  - `current`: 모르는 이벤트가 없다.
  - `behind`: `sync.unseen`에 모르는 이벤트가 담겨 있다. 사용자의 핀·설정 변경, 다른 에이전트의 기록 등을 반영한다. `truncated`가 `true`면 최근 일부만 온 것이다.
  - `none`(knownHead 없음), `unknown`(체인에서 찾을 수 없음): 로그를 받지 않았다. 필요할 때만 명시적으로 요청한다.
- 명시적 요청
  - 모르는 이벤트 더 받기: `GET /api/sync?knownHead=<head>&limit=N`
  - 최근 이벤트 N개: `GET /api/sync?limit=N`
  - 최근 entry N개: `GET /api/entries?last=N&full=1`
  - 미리보기로 온 응답의 전문: `GET /api/entries/<id>`
- `unseen`의 응답과 수정본은 200자 미리보기(`preview`, `length`, `truncated`)로 온다. 질문, 노트, 핀, 목차, 설정은 전문으로 온다.
- 한 번에 받는 최대 개수는 사이드바 `Max unseen events`(기본 20, `0`은 무제한)로 정한다.

## 질문 기록 방식

화면 사이드바의 `Use AI-cleaned questions` 체크박스가 새 질문의 기록 방식을 정한다.

- 체크됨: cleaned — 사용자의 원문을 의미와 조건을 유지한 짧고 자연스러운 질문으로 정리한다.
- 체크 안 됨: raw — 사용자가 보낸 표현을 그대로 기록한다.

이 설정은 `settings` 이벤트로 저장되며 새로고침 후에도 유지된다. 기존 엔트리는 작성 당시의 표현을 유지한다. 질문 엔트리는 rawBody와 cleanedBody를 모두 보존하고, 화면과 API의 body에는 당시 선택된 표현을 넣는다.

이 서버는 외부 채팅창의 입력을 스스로 가로채지 않는다. 기록할 때 에이전트가 사용자 발화를 rawBody로 전달하고, 에이전트가 만든 cleanedBody도 함께 전달한다.

정리본은 다음 기준만 따른다.

- 질문의 의도, 조건, 요구 강도를 보존한다.
- 새로운 요구나 배경을 덧붙이지 않는다.
- “사용자가 질문함”, “다음과 같이 정리하면” 같은 메타 문구를 넣지 않는다.
- 불필요한 인사, 감탄, 반복을 제거한다.
- 한 문장 또는 필요한 경우 짧은 문단으로 끝낸다.

요청의 의미·조건·요구 강도를 충분히 이해하지 못한 경우에는 응답을 확인을 위한 의문형으로 작성할 수 있다. 이때 이해되지 않은 부분을 임의로 보완하거나 요청에 없는 내용을 추가하지 않는다.

clientRef가 같은 쓰기 요청은 중복 엔트리를 만들지 않는다. 재시도할 때 같은 응답에 같은 값을 사용한다.

## 엔트리 추가

질문·보고·판단·오류·완료·기타 중 하나를 kind(`question`, `report`, `decision`, `error`, `done`, `other`)로 사용한다. 본문은 마크다운 문자열로 보낸다.

~~~json
POST /api/entries
{"kind":"question","rawBody":"원문","cleanedBody":"정리한 질문","clientRef":"turn-14-question","knownHead":"3f9a1c2b7d4e5a60"}
~~~

응답의 `written`으로 저장 여부를 확인한다. 쓰기 실패 응답은 저장되지 않은 것이며 기존 기록은 보존한다.

응답 글자수 한도는 사이드바 `Max response chars`에서 정한다. 기본값은 3000이며 `0`은 무제한이다. 한도를 미리 조회하지 않고 기록한다. 한도 초과로 거부되면 반환된 `maxResponseChars`에 맞춰 임의로 자르지 말고 나누거나 다시 작성해 보낸다. 글자수는 `Array.from` 기준 Unicode code point 수다.

## 목차

설명이나 수정 세션을 시작하면 전체 항목을 원래 순서대로 `PATCH /api/outline`에 보낸다. 키는 no, title, type, status만 영어로 저장한다.

- status: pending | active | done
- 하위 항목은 2-1, 2-2처럼 번호를 붙인다.
- 현재 항목은 current:true로 표시한다.
- report는 설명이 끝나면 완료하고 다음 항목으로 간다.
- decision은 선택지의 영향과 권장안을 제시한 뒤 사용자 판단을 기다린다.
- 전체가 끝나면 {"done":true}를 보낸다.

## 핀·노트·수정

- 질문은 핀할 수 없고 응답만 핀할 수 있다. 핀은 `POST /api/pin`으로 설정하고 `{"target":null}`로 해제한다. 원본과 이력은 보존한다.
- 핀된 응답의 Add reply를 켜면 `POST /api/reply-target`로 다음 응답 하나를 해당 응답에 연결한다. 연결된 entry에는 replyTo가 기록되고, 한 번 연결하면 대기 상태가 자동으로 꺼진다.
- 핀된 응답에 연결된 replyTo entry는 핀 영역의 reply 목록에서만 표시하고 일반 응답 목록에는 중복 표시하지 않는다. 부모 핀을 해제하면 일반 응답 목록으로 돌아온다.
- 노트는 현재 핀된 응답에만 `POST /api/entries/:id/notes`로 추가한다. 핀되지 않은 응답이나 질문에는 서버가 거부한다. anchor가 없으면 응답의 anchorFound:false를 사용자에게 알린다.
- 수정은 `POST /api/entries/:id/revisions`로 최신 본문 전체를 보낸다. 부분 본문을 보내지 않는다.

CLI·데이터 모델·API·화면 동작과 알려진 제한은 [references/reference.md](references/reference.md)에 있다.
