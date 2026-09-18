const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");

const NEIS_API_KEY = defineSecret("NEIS_API_KEY");
const REGION = "asia-northeast3";

/**
 * NEIS Open API는 데이터가 없거나 에러일 때도 200으로 응답하면서
 * 최상위 RESULT 필드로 상태를 알려준다. 그 경우 빈 배열을 반환한다.
 */
function extractRows(data, rootKey) {
  const root = data?.[rootKey];
  if (!root) return [];
  const rowsBlock = root.find?.((b) => Array.isArray(b?.row)) ?? root[1];
  return rowsBlock?.row || [];
}

exports.searchNeisSchool = onCall({ secrets: [NEIS_API_KEY], region: REGION, cors: true }, async (request) => {
  const schoolName = String(request.data?.schoolName || "").trim();
  if (!schoolName) throw new HttpsError("invalid-argument", "학교 이름을 입력해주세요.");

  const url = new URL("https://open.neis.go.kr/hub/schoolInfo");
  url.searchParams.set("KEY", NEIS_API_KEY.value());
  url.searchParams.set("Type", "json");
  url.searchParams.set("pIndex", "1");
  url.searchParams.set("pSize", "50");
  url.searchParams.set("SCHUL_NM", schoolName);

  let data;
  try {
    const res = await fetch(url);
    data = await res.json();
  } catch (e) {
    throw new HttpsError("unavailable", "나이스 서버에 연결할 수 없습니다: " + e.message);
  }

  const rows = extractRows(data, "schoolInfo");
  return rows.map((r) => ({
    officeCode: r.ATPT_OFCDC_SC_CODE,
    officeName: r.ATPT_OFCDC_SC_NM,
    schoolCode: r.SD_SCHUL_CODE,
    schoolName: r.SCHUL_NM,
    address: r.ORG_RDNMA || "",
  }));
});

exports.fetchNeisSchedule = onCall({ secrets: [NEIS_API_KEY], region: REGION, cors: true }, async (request) => {
  const { officeCode, schoolCode, fromYmd, toYmd } = request.data || {};
  if (!officeCode || !schoolCode || !fromYmd || !toYmd) {
    throw new HttpsError("invalid-argument", "학교 정보와 조회 기간이 필요합니다.");
  }

  const url = new URL("https://open.neis.go.kr/hub/SchoolSchedule");
  url.searchParams.set("KEY", NEIS_API_KEY.value());
  url.searchParams.set("Type", "json");
  url.searchParams.set("pIndex", "1");
  url.searchParams.set("pSize", "300");
  url.searchParams.set("ATPT_OFCDC_SC_CODE", officeCode);
  url.searchParams.set("SD_SCHUL_CODE", schoolCode);
  url.searchParams.set("AA_FROM_YMD", fromYmd);
  url.searchParams.set("AA_TO_YMD", toYmd);

  let data;
  try {
    const res = await fetch(url);
    data = await res.json();
  } catch (e) {
    throw new HttpsError("unavailable", "나이스 서버에 연결할 수 없습니다: " + e.message);
  }

  // SBTR_DD_SC_NM(수업공휴일구분): "휴업일"(재량휴업일 등)이나 "공휴일"(법정공휴일)일 때만
  // 공휴일로 분류한다. "해당없음"/"수업일" 등은 시업식·입학식 같은 실제 학교 행사이므로
  // 제외한다 — "수업일이 아니면 전부 공휴일" 식으로 판단하면 이런 실제 행사까지
  // 공휴일로 잘못 분류되므로 반드시 명시적으로 매칭해야 한다.
  const HOLIDAY_VALUES = new Set(["휴업일", "공휴일"]);
  const rows = extractRows(data, "SchoolSchedule");
  return rows
    .filter((r) => r.AA_YMD)
    .map((r) => ({
      date: `${r.AA_YMD.slice(0, 4)}-${r.AA_YMD.slice(4, 6)}-${r.AA_YMD.slice(6, 8)}`,
      title: r.EVENT_NM || "(제목 없음)",
      memo: r.EVENT_CNTNT || "",
      isHoliday: HOLIDAY_VALUES.has(r.SBTR_DD_SC_NM),
    }));
});
