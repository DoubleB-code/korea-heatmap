# 보안 정책

## 지원 버전

| 버전 | 보안 패치 |
|------|----------|
| main 최신 | ✅ |
| 그 외     | ❌ |

## 적용된 방어 레이어

### 1. HTTP 보안 헤더 (`web/_headers` — Cloudflare Pages 자동 적용)
- `Content-Security-Policy`: 외부 스크립트 도메인 화이트리스트, inline script 차단
- `X-Content-Type-Options: nosniff` — MIME 스니핑 방지
- `X-Frame-Options: DENY` — clickjacking 방지
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy`: 카메라·마이크·결제·USB 등 모두 차단
- `Strict-Transport-Security`: HSTS 1년, preload
- `Cross-Origin-Opener-Policy / Resource-Policy`: same-origin 격리

### 2. 입력 검증
- 종목 코드: 정규식 `^\d{6}$` 강제 (서버·클라이언트 양쪽)
- 등락률: 절대값 ≤ 30% (한국 가격제한폭)
- 시가총액: 양수만 허용
- 사용자 입력 (포트폴리오 평단가·수량): `parseInt` + 양수 검증

### 3. XSS 방어
- 모든 동적 텍스트 출력에 `escapeHtml()` 적용
- `tooltip.html()` 사용처 모두 escape 처리됨 (`name`, `code`, `parent.name`)
- d3 `.text()` 우선 사용 (가능한 곳)

### 4. 공급망 (Supply Chain) 보호
- `requirements.txt` 핀 (정확한 버전)
- Dependabot weekly: 보안 패치 자동 PR
- CodeQL: Python·JS 자동 정적 분석 (주 1회)
- GitHub Actions 권한 최소화 (`contents: write` 만)

### 5. 민감 정보 처리
- API 키·시크릿 코드 미보관 (PyKRX 는 공개 KRX 데이터)
- `localStorage` 는 사용자 포트폴리오만 저장 (계정 정보·결제 정보 없음)
- DOM에 사용자 평단가·수량 노출되지만 이는 로컬 브라우저 한정

### 6. CI/CD 보안
- 워크플로우 토큰 권한 최소화
- 동시성 그룹 (`concurrency: kospi-update`) — race condition 방지
- 데이터 검증 게이트 (validate_output.py) 통과해야 commit
- 무결성 위반 시 `IntegrityError` → 기존 데이터 유지 (덮어쓰기 안 함)

## 광고 통합 시 추가 작업 (계획)

AdSense / 카카오 애드핏 도입 시 CSP 갱신 필요:
```
script-src + https://pagead2.googlesyndication.com https://t1.daumcdn.net
frame-src + https://googleads.g.doubleclick.net https://*.adfit.kakao.com
img-src + https://*.googlesyndication.com https://*.daumcdn.net
```
광고 도메인은 신뢰성 검증 후에만 화이트리스트 추가.

## 취약점 신고

보안 이슈 발견 시 이슈 트래커에 공개 보고하지 마시고 메일로 알려주세요:
- onsecon2@gmail.com

24시간 내 1차 응답, 48시간 내 patch 또는 mitigation 안내 목표.
