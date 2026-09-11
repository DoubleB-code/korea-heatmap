/**
 * KST (Asia/Seoul, UTC+9) 시간 유틸.
 */

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 현재 KST 기준 YYYY-MM-DD */
export function todayKST(): string {
  const now = new Date(Date.now() + KST_OFFSET_MS);
  return now.toISOString().slice(0, 10);
}

/** unix sec → KST YYYY-MM-DD */
export function dateKST(unixSec: number): string {
  const d = new Date(unixSec * 1000 + KST_OFFSET_MS);
  return d.toISOString().slice(0, 10);
}

/** KST 기준 HH:mm */
export function timeKST(): string {
  const now = new Date(Date.now() + KST_OFFSET_MS);
  return now.toISOString().slice(11, 16);
}

/**
 * 다음 영업일 (단순 평일 + 휴장일 set 가드).
 * 휴장일 데이터는 별도 호출자가 주입.
 */
export function nextBusinessDay(holidays: Set<string> = new Set()): string {
  let d = new Date(Date.now() + KST_OFFSET_MS);
  d.setUTCDate(d.getUTCDate() + 1);

  for (let i = 0; i < 10; i++) {
    const iso = d.toISOString().slice(0, 10);
    const dayOfWeek = d.getUTCDay();  // 0=일, 6=토
    if (dayOfWeek !== 0 && dayOfWeek !== 6 && !holidays.has(iso)) {
      return iso;
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  // fallback: 그냥 내일
  const tmrw = new Date(Date.now() + KST_OFFSET_MS + 86400000);
  return tmrw.toISOString().slice(0, 10);
}

/** 영업일 여부 (KRX 캘린더 set 주입) */
export function isBusinessDay(dateStr: string, holidays: Set<string>): boolean {
  const d = new Date(dateStr + "T00:00:00Z");
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  if (holidays.has(dateStr)) return false;
  return true;
}

export function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}
