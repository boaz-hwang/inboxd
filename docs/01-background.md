# 01 — Background

## 출발점

인간용 TUI + 에이전트용 MCP/CLI를 하나의 메시징 추상화 위에 올리려는 구상에서 시작.
Slack, Teams, Discord, Telegram, KakaoTalk을 하나의 inbox/search/reply 흐름으로 묶는 것이 목표.

## 문제 정의

멀티메신저 통합의 어려움은 UI가 아니라 아래 3개다.

1. **검색 비대칭**: 절반 플랫폼에 서버 검색 API가 없다.
2. **세션 휘발성**: 토큰 만료(Teams 60~90분), 세션 무효화, DB 스키마 변경이 수시로 발생.
3. **쓰기 위험**: 에이전트 오발송이 문서 주의사항 수준으로만 다뤄짐.

## 결론 방향

TUI 자체를 제품 본체로 두지 않는다. TUI/MCP/CLI 아래의 런타임 층을 제품으로 둔다.

```text
Messaging Runtime
  ├─ TUI (human)
  ├─ MCP (agent)
  └─ CLI (automation)
```
