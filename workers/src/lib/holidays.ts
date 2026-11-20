/**
 * KRX 휴장일 (한국거래소 휴장).
 *
 * 매년 12월 말 KRX 공식 발표 후 갱신 필요.
 * 출처: https://open.krx.co.kr/contents/MKD/01/0110/01100305/MKD01100305.jsp
 */

export const KRX_HOLIDAYS: Record<number, string[]> = {
  2026: [
    "2026-01-01",                          // 신정
    "2026-02-16", "2026-02-17", "2026-02-18", // 설날 연휴
    "2026-03-02",                          // 삼일절 대체공휴일 (3/1 일)
    "2026-05-05",                          // 어린이날
    "2026-05-25",                          // 부처님오신날 대체공휴일 (5/24 일)
    "2026-06-03",                          // 제9회 전국동시지방선거
    "2026-08-17",                          // 광복절 대체공휴일 (8/15 토)
    "2026-09-24", "2026-09-25",            // 추석
    "2026-10-09",                          // 한글날
    "2026-12-25",                          // 성탄절
    "2026-12-31",                          // 연말 휴장
  ],
  2027: [
    // TBD — 매년 갱신 필요
    "2027-01-01",
  ],
};

/** 지정 연도의 휴장일 Set */
export function getHolidaySet(year: number): Set<string> {
  return new Set(KRX_HOLIDAYS[year] || []);
}

/** 다년도 통합 Set (현재 + 다음 해) */
export function getActiveHolidaySet(): Set<string> {
  const now = new Date();
  const y = now.getUTCFullYear();
  const all = [...(KRX_HOLIDAYS[y] || []), ...(KRX_HOLIDAYS[y + 1] || [])];
  return new Set(all);
}
