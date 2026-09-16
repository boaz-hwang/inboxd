# 01 — Background

## 출발점

인간용 TUI + 에이전트용 MCP/CLI를 하나의 메시징 추상화 위에 올리려는 구상에서 시작.
Slack, Teams, Discord, Telegram, KakaoTalk을 하나의 inbox/search/reply 흐름으로 묶는 것이 목표.

## 문제 정의

멀티메신저 통합의 어려움은 UI가 아니라 아래 3개다.

1. **검색 비대칭**: 절반 플랫폼에 서버 검색 API가 없다.
2. **세션 휘발성**: 토큰 만료(Teams 60~90분), 세션 무효화, DB 스키마 변경이 수시로 발생.
3. **쓰기 위험**: 에이전트 오발송이 문서 주의사항 수준으로만 다뤄짐.

2번의 귀결: 진단은 복구가 아니다. 휘발성에 대한 답은 doctor가 아니라
sync 백필 + coverage 표기 + 깨지는 어댑터의 격리이며, 상세는 03-proposal의
sync·coverage·테스트 전략에 있다.

## 범위 (MVP)

- 아키텍처 증명 후보 어댑터: **Slack** (서버 검색·스냅샷·공식 API에 가장 가까움).
  현재 wrapper-first Spike A는 PARTIAL이다. 제한된 live read와 합성 검색·재개는
  확인했지만 wrapper가 pagination metadata를 버려 완전 이력과 cursor 복구는 증명하지 못했다.
- **카카오 DB 읽기**: 먼저 아키텍처 증명과 분리해 해독·셀렉터 생존율을 측정한다.
  측정 이후 읽기 어댑터를 sync·store·TUI에 연결하고 실제 질문으로 검증해야 전체 MVP가 완료된다.
  MVP에서 카카오 발송은 지원하지 않는다.
  별도의 KakaoTalk·Telegram wrapper 합성 확장은 원래 Spike B의 DB KDF·schema·AX 측정을
  대체하지 않으며, 두 계정이 미설정이어서 live 제품 증거도 아니다.
- **Teams는 phase 2.** 배경 목표에는 있지만 MVP에서 제외한다. 넣으면 MVP 완료 기준이 Teams 토큰 만료에 종속된다.
- Discord/Telegram은 MVP 이후. 한 번에 N개 어댑터를 늘리지 않는다.
- 인터페이스 순서: **CLI → TUI → MCP.** Slack TUI가 첫 제품 마일스톤이고,
  전체 MVP는 MCP·카카오 읽기 통합과 두 플랫폼의 실질문 검증까지다. 셋 다 데몬 1개의
  로컬 소켓 클라이언트로 구성한다(06-architecture).
- 승인 보호는 MVP에서 **MCP-only 에이전트(등급 a)**에 한해 주장한다. 셸 접근
  에이전트(등급 b)는 phase 2.
