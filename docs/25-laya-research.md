# Laya 판단 모델 조사 — 2026-09-23

이 문서는 모델을 내려받거나 실행하지 않은 읽기 조사다. Inboxd의 한국어 답장 정확도나 M4 Pro 지연을 실측한 결과가 아니다.

## 확인된 사실

- [Laya 공식 설명](https://laya.convaiinnovations.com/)과 [공식 모델 카드](https://huggingface.co/convaiinnovations/laya-multilingual)에 따르면 Laya는 텍스트를 생성하지 않고 `choice`, `score`, `noul` 질문에 확률을 반환하는 인코더 기반 모델이다. 다국어판은 mmBERT 기반 322M 파라미터, 기본 1,024 토큰 문맥이다. 영어 기본판은 ModernBERT 기반 421M/512 토큰, typed-decisions판은 421M/1,024 토큰이다. 문맥 예산에는 질문·선택지와 대화 본문이 함께 들어간다. 모델과 [공식 코드](https://github.com/NandhaKishorM/laya)는 Apache 2.0이다.
- 한국어는 다국어판을 써야 한다. [공식 51개 언어 원시 벤치마크 요약](https://github.com/NandhaKishorM/laya/blob/main/BENCHMARKS.md)은 MASSIVE 한국어 의도 분류 20지선다에서 영어판 0.110, 다국어판 0.450을 기록한다(무작위 기준 0.050). [다국어 모델 카드](https://huggingface.co/convaiinnovations/laya-multilingual)는 다국어판을 0.490으로 적어 수치가 일치하지 않는다. 어느 수치도 Inboxd의 한국어 대화 화자·수신자·근거 판정 정확도가 아니다.
- 다국어 가중치는 보정된 신뢰도로 배포되지 않는다. [공식 모델 카드](https://huggingface.co/convaiinnovations/laya-multilingual)와 [벤치마크](https://github.com/NandhaKishorM/laya/blob/main/BENCHMARKS.md)는 배포 상태 ECE 0.314, 보류 데이터의 질문 유형·선택지 수별 temperature 재적합 후 0.106을 보고한다. typed-decisions 범용 사례의 다국어 기본판 정확도는 0.342로 다수 클래스 기준 0.461보다 낮고, 0.766은 별도 학습된 영어 typed-decisions 체크포인트의 결과다. 따라서 높은 출력 확률은 의미 판단의 정답 증명이 아니다.
- 공식 32.8ms 단일 질문 수치는 **Tesla T4, 사전 로드 상태**다. [공식 벤치마크](https://github.com/NandhaKishorM/laya/blob/main/BENCHMARKS.md)는 질문 10개를 묶어 72.3ms로 측정했다. 이는 이 Mac의 전체 답장 파이프라인 지연이 아니다. 체크포인트를 매번 바꾸면 [공식 README](https://github.com/NandhaKishorM/laya)는 7–10초 재로드를 보고한다.
- [공식 Python 런타임](https://github.com/NandhaKishorM/laya/blob/main/laya/agent.py)은 PyTorch CUDA/MPS/CPU를 선택하며 MPS에서는 float32를 쓴다. [독립 MLX 포트](https://github.com/xosi/laya)와 [별도 유지 저장소](https://github.com/mizorewww/laya-mlx)는 Apple Silicon FP16 추론을 제공하지만 공식 ConvAI 배포가 아니다. [독립 포트 측정](https://github.com/mizorewww/laya-mlx/blob/main/BENCHMARKS.md)은 M3 Max에서 다국어 단일 짧은 질문 p50 7.39ms, 1,024 토큰 전체 문맥 단일 질문 p50 43.50ms다. 같은 포트는 선택지 일치 63개 검증을 보고하며 한국어 답장 판단 정확도 검증은 아니다. MLX 포트는 추론용이고 RLCD 학습은 [공식 학습 노트북](https://github.com/NandhaKishorM/laya/blob/main/notebooks/laya_finetune_typed_decisions_2xT4_kaggle.ipynb) 쪽에 있다.

## Inboxd에 적용할 때의 가설과 평가

1. 다국어판으로 고정된 좁은 판단 머리(`상대 요청의 수행 주체`, `명시적 self 금지 존재`, `내 승인·일정 근거 존재`, `추가 검색 필요`)를 실험한다. Laya가 답장 문장이나 자유 형식의 근거 조회 계획을 만들 수는 없으므로 현재 9B 생성·근거 검사를 바로 대체하지 않는다.
2. 기존 한국어 오류에서 직접 만든 학습·보정·홀드아웃 세트를 서로 다른 대화/패러프레이즈로 분리한다. 수신자 반전, 타인에게 온 그룹 요청, 명시적 거절 약화, 근거 없는 일정 확정과 정상 후속 답변을 모두 포함한다. 보정 후 신뢰도별 오판, 특히 거짓 승인(false accept)과 정상 초안 거절(false reject)을 측정한다.
3. 같은 M4 Pro에서 모델 로드 제외/포함, 짧은 문맥/최대 문맥, 질문 1개/여러 개, 9B GPU 동시 실행의 p50/p95와 전체 준비 시간·정확도를 비교한다. 정확도가 확인된 저위험 판단만 빠른 경로로 보내고, 불확실하거나 의미가 복잡한 경우 기존 판단으로 넘기는 실험이 적절하다. 근거 검사는 검증 전까지 유지한다.

## 아직 확인되지 않은 것

- 한국어 메신저 역할·수신자 방향과 명시적 부정에 대한 Laya의 실제 정확도, 학습 필요량, 이 Mac의 지연 및 9B와의 GPU 경합.
- 1,024 토큰 안에 대화·질문·선택지를 넣을 때 중요한 과거 self 결정이 잘리는 비율.
- 독립 MLX 포트의 장기 유지·공식 모델 업데이트 호환성 및 이 제품의 전체 오류/지연 Pareto 개선.

모델 다운로드, 설치, 추론, 생산 코드 변경 및 사적 대화 전송은 수행하지 않았다.
