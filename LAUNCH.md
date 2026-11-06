# 출시 가이드 (LAUNCH)

> 처음 운영을 시작할 때 이 문서를 따라하세요. 약 30분 내에 `https://korea-heatmap.pages.dev` 가 라이브 됩니다.

---

## 사전 준비 (이미 있는 것)

- [x] GitHub 계정
- [x] Cloudflare 계정
- [x] 로컬 폴더: `C:\Users\Doubleb\Documents\Claude\kospi-heatmap\project\`
- [x] Git 설치 (없으면 https://git-scm.com/download/win 에서 설치)

---

## STEP 1 — GitHub 저장소 생성 (5분)

1. https://github.com/new 접속
2. 다음 값으로 입력:
   - **Repository name**: `korea-heatmap`
   - **Description**: `코리아 히트맵 — 코스피 200 시총 가중 트리맵`
   - **Visibility**: **Public** (무료 GitHub Actions·Pages 활용)
   - **Initialize**: 아무것도 체크하지 말 것 (README, .gitignore, license 모두 OFF)
3. **Create repository** 클릭

---

## STEP 2 — 로컬 코드 푸시 (5분)

PowerShell 또는 명령 프롬프트에서:

```powershell
cd C:\Users\Doubleb\Documents\Claude\kospi-heatmap\project
git init
git config user.name "당신이름"
git config user.email "onsecon2@gmail.com"
git add .
git commit -m "feat: 코리아 히트맵 v1 출시"
git branch -M main
git remote add origin https://github.com/<당신GitHubID>/korea-heatmap.git
git push -u origin main
```

`<당신GitHubID>` 자리에 본인 GitHub ID를 정확히 넣으세요.

처음 push 시 GitHub 인증 창이 뜹니다 — 브라우저에서 로그인 → 권한 승인.

---

## STEP 3 — Actions 권한 활성화 (필수 ⚠️, 2분)

이거 안 하면 자동 갱신이 동작하지 않습니다.

1. GitHub 저장소 페이지 → **Settings** 탭 (저장소 우상단)
2. 좌측 메뉴 → **Actions** → **General**
3. 페이지 하단 **Workflow permissions** 섹션:
   - ✅ **Read and write permissions** 선택
   - ✅ **Allow GitHub Actions to create and approve pull requests** 체크
4. **Save** 클릭

---

## STEP 4 — Cloudflare Pages 배포 (10분)

1. https://dash.cloudflare.com 접속
2. 좌측 메뉴 → **Workers & Pages** → **Create application** → **Pages** 탭 → **Connect to Git**
3. **Connect GitHub account** → GitHub 인증 → `korea-heatmap` 저장소 선택
4. **Setup builds and deployments**:
   - **Project name**: `korea-heatmap` (이게 서브도메인이 됨 → `korea-heatmap.pages.dev`)
   - **Production branch**: `main`
   - **Framework preset**: None
   - **Build command**: (비워둠)
   - **Build output directory**: `web`
5. **Save and Deploy** 클릭 → 1~2분 후 첫 배포 완료
6. 표시되는 URL `https://korea-heatmap.pages.dev` 클릭해서 확인

이 시점에는 아직 데이터가 없어서 "데이터를 불러올 수 없습니다" 표시됨. 다음 단계로.

---

## STEP 5 — 첫 데이터 수집 트리거 (5분)

1. GitHub 저장소 → **Actions** 탭
2. 좌측 워크플로우 목록에서 **Update KOSPI 200** 클릭
3. 우측 **Run workflow** 드롭다운 → **main** 브랜치 → **Run workflow** 버튼
4. 3~5분 대기 — 다음 순서로 진행됩니다:
   - pytest 95개 통과 검증
   - PyKRX가 KRX에서 KOSPI 200 데이터 수집
   - `web/data/treemap.json` 자동 커밋 → push
   - Cloudflare Pages가 push 감지 → 자동 재배포

5. `https://korea-heatmap.pages.dev` 새로고침 → **실데이터 표시 확인** 🎉

---

## STEP 6 — 검증 체크리스트

브라우저에서 열고 다음 항목 모두 작동하는지 확인:

- [ ] 트리맵이 200종목 모두 표시됨
- [ ] 호버 시 큰 툴팁 (sparkline + peer 5종목 + 회사명) 표시
- [ ] 박스 클릭 → 네이버 금융 페이지 새 탭 열림
- [ ] 우상단 "내 주식" 버튼 → 포트폴리오 패널 슬라이드
- [ ] 종목 추가 (예: 삼성전자 70000원 10주) → 카드 표시 + 합계 갱신
- [ ] 좌측 광고 자리에 placeholder 표시
- [ ] 검색창에 "삼성" 입력 → 다른 박스 흐려짐

---

## STEP 7 — 검색엔진 등록 (다음 날, 30분)

### Google Search Console

1. https://search.google.com/search-console
2. **속성 추가** → URL 접두어: `https://korea-heatmap.pages.dev`
3. 소유권 확인: **HTML 태그** 방법 → 제공된 메타 태그를 `web/index.html` `<head>`에 추가 → git commit & push
4. **Sitemaps** 메뉴 → 사이트맵 URL: `sitemap.xml` 입력 → 제출 (현재 robots.txt만 있음, sitemap.xml은 추후 자동 생성 예정)

### Naver Search Advisor (한국 트래픽 핵심)

1. https://searchadvisor.naver.com
2. 사이트 등록 → 동일 절차

---

## STEP 8 — 모니터링

- **Cloudflare Pages Analytics**: 자동 활성화. 일일 PV·국가·디바이스 무료 확인
- **GitHub 알림**: Settings → Notifications → email 알림 활성화. 워크플로우 실패 시 자동 Issue 생성 + 메일
- **`web/data/_meta.json`**: `last_success_iso`, `consecutive_failures` 추적 데이터

---

## 트러블슈팅

### 첫 워크플로우 실행이 실패할 때

**원인 1**: Actions 권한 미활성화 (STEP 3 누락)
- 해결: STEP 3 다시 확인 → "Read and write permissions" 체크

**원인 2**: PyKRX가 일시적으로 KRX 차단
- 해결: Actions 탭에서 **Re-run failed jobs** 클릭. 재시도 3회 후에도 실패하면 1시간 뒤 다시.

**원인 3**: 휴장일 또는 주말
- 정상. 휴장일은 자동 SKIP (commit 없음).

### Cloudflare Pages 배포 안 됨

- Build output directory가 `web` 인지 확인
- 첫 배포는 1~2분 소요. 무한 대기 상태면 새 commit 푸시.

---

## 다음 마일스톤

| 일 PV | 다음 액션 |
|---|---|
| 1~500 | 그냥 운영. 콘텐츠·종목 분석 글 추가 |
| 500+ | Google AdSense 신청. 광고 슬롯 활성화 |
| 5,000+ | 한투/키움/토스 리퍼럴 제휴 |
| 10,000+ | 도메인 구입 (`heatmap.kr`, `kospi.live` 등 1~3만원/년) → Cloudflare에 커스텀 도메인 연결 |

---

## 출시 후 7일 체크 항목

- [ ] 일 3회 cron 모두 작동 (Actions 탭에서 success 확인)
- [ ] Cloudflare Analytics에 트래픽 카운트 시작
- [ ] Google Search Console 인덱싱 시작 (1~2일)
- [ ] Naver Search Advisor 검토 완료
- [ ] 첫 사용자 피드백 수집 (지인·SNS·커뮤니티)
