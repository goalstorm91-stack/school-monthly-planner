/* ============================================================
   초등학교 교무부장 월중계획 대시보드 (다중 학교 / 참여코드 전용판)
   - 로그인 없이 "참여코드"만으로 학교별 실시간 공유 데이터(Firestore)에 접근
   - 행사 / 복무(출장·연수 등) / 공문 세 가지 항목을 날짜별로 관리
   ============================================================ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  addDoc,
  onSnapshot,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-functions.js";
import { firebaseConfig } from "./firebase-config.js";

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);
const functions = getFunctions(firebaseApp, "asia-northeast3");

const VIEW_PREF_KEY = "schoolMonthlyPlanner.viewPref";
const LOCAL_KEY = "schoolMonthlyPlanner.local"; // { schoolId, displayName }

function todayStr() {
  return formatDate(new Date());
}
function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function parseDate(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function loadViewPref() {
  try {
    const raw = localStorage.getItem(VIEW_PREF_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  const now = new Date();
  return { viewYear: now.getFullYear(), viewMonth: now.getMonth() + 1 };
}
function saveViewPref() {
  localStorage.setItem(VIEW_PREF_KEY, JSON.stringify({ viewYear: state.viewYear, viewMonth: state.viewMonth }));
}
function loadLocal() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return { schoolId: null, displayName: "" };
}
function saveLocal(patch) {
  const merged = { ...loadLocal(), ...patch };
  localStorage.setItem(LOCAL_KEY, JSON.stringify(merged));
  return merged;
}
function clearLocalSchool() {
  saveLocal({ schoolId: null });
}

const INVITE_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 혼동되는 O/0, I/1 제외
function generateInviteCode(len = 6) {
  let out = "";
  for (let i = 0; i < len; i++) out += INVITE_CODE_CHARS[Math.floor(Math.random() * INVITE_CODE_CHARS.length)];
  return out;
}

const state = {
  ...loadViewPref(),
  schoolName: "",
  events: [],
  duties: [],
  docs: [],
};

let schoolId = null;
let schoolMeta = null; // { name, inviteCode }
let localName = ""; // 이 브라우저에서 입력한 이름 (신원 확인용 아님, 표시용)
let unsubs = [];

// ============================================================
// SCREENS
// ============================================================
function showScreen(name) {
  document.getElementById("authScreen").hidden = name !== "auth";
  document.getElementById("onboardingScreen").hidden = name !== "onboarding";
  document.getElementById("dashboardScreen").hidden = name !== "dashboard";
}

function showAuthError(message) {
  const box = document.getElementById("authErrorBox");
  if (!message) {
    box.hidden = true;
    box.textContent = "";
    return;
  }
  box.hidden = false;
  box.textContent = message;
}

// 별도 로그인 없이, 이 브라우저에 저장된 schoolId가 있으면 바로 그 학교로 들어가고
// 없으면 참여코드 입력 화면을 보여준다. 신원 확인이 없는 대신 참여코드를 아는
// 사람만 해당 학교 데이터에 접근할 수 있다 (Firestore 보안 규칙으로 강제).
async function init() {
  const local = loadLocal();
  localName = local.displayName || "";
  document.getElementById("nameInput").value = localName;

  if (!local.schoolId) {
    showScreen("onboarding");
    return;
  }

  showScreen("auth");
  try {
    const schoolSnap = await getDoc(doc(db, "schools", local.schoolId));
    if (!schoolSnap.exists()) {
      clearLocalSchool();
      showScreen("onboarding");
      return;
    }
    schoolId = local.schoolId;
    await enterSchool();
    showScreen("dashboard");
  } catch (e) {
    console.error("[init] failed to load school:", e);
    showScreen("onboarding");
    showAuthError("학교 정보를 불러오지 못했습니다: " + e.message);
  }
}
init();

function leaveSchool() {
  if (!confirm("이 학교에서 나갈까요? 참여코드를 다시 입력해야 이 학교 데이터에 접근할 수 있습니다.")) return;
  detachListeners();
  schoolId = null;
  clearLocalSchool();
  document.getElementById("nameInput").value = localName;
  showScreen("onboarding");
}
document.getElementById("signOutBtn").addEventListener("click", leaveSchool);

// ---------- onboarding tabs ----------
document.querySelectorAll("[data-onb]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-onb]").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll("[data-onb-pane]").forEach((p) => (p.hidden = p.dataset.onbPane !== btn.dataset.onb));
  });
});

function getEnteredName() {
  return document.getElementById("nameInput").value.trim();
}

document.getElementById("createSchoolBtn").addEventListener("click", async () => {
  const displayName = getEnteredName();
  if (!displayName) return alert("이름을 입력해주세요.");
  const name = document.getElementById("newSchoolNameInput").value.trim();
  if (!name) return alert("학교 이름을 입력해주세요.");
  const btn = document.getElementById("createSchoolBtn");
  btn.disabled = true;
  try {
    const schoolRef = doc(collection(db, "schools"));
    const code = generateInviteCode();
    await setDoc(schoolRef, {
      name,
      inviteCode: code,
      createdAt: serverTimestamp(),
    });
    await setDoc(doc(db, "inviteCodes", code), { schoolId: schoolRef.id });
    saveLocal({ schoolId: schoolRef.id, displayName });
    location.reload();
  } catch (e) {
    alert("학교 생성에 실패했습니다: " + e.message);
    btn.disabled = false;
  }
});

document.getElementById("joinSchoolBtn").addEventListener("click", async () => {
  const displayName = getEnteredName();
  if (!displayName) return alert("이름을 입력해주세요.");
  const code = document.getElementById("joinCodeInput").value.trim().toUpperCase();
  if (!code) return alert("참여코드를 입력해주세요.");
  const btn = document.getElementById("joinSchoolBtn");
  btn.disabled = true;
  try {
    const codeSnap = await getDoc(doc(db, "inviteCodes", code));
    if (!codeSnap.exists()) {
      alert("유효하지 않은 참여코드입니다.");
      btn.disabled = false;
      return;
    }
    const targetSchoolId = codeSnap.data().schoolId;
    saveLocal({ schoolId: targetSchoolId, displayName });
    location.reload();
  } catch (e) {
    alert("참여에 실패했습니다: " + e.message);
    btn.disabled = false;
  }
});

// ============================================================
// SCHOOL DATA (Firestore, realtime)
// ============================================================
async function enterSchool() {
  const schoolSnap = await getDoc(doc(db, "schools", schoolId));
  schoolMeta = schoolSnap.data();

  state.schoolName = schoolMeta.name || "";
  els.schoolName.value = state.schoolName;
  els.schoolName.disabled = false;

  document.getElementById("inviteBtn").hidden = false;
  document.getElementById("inviteCodeBox").textContent = schoolMeta.inviteCode || "------";
  document.getElementById("userAvatar").src =
    "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><circle cx='12' cy='12' r='12' fill='%23ccc'/></svg>";
  document.getElementById("userName").textContent = localName || "이름없음";

  attachSchoolListeners();
}

let neisReclassifyDone = false;

// 나이스에서 가져온 항목의 공휴일 여부를 세션당 한 번, 조용히 나이스와 다시 맞춰본다.
// isHoliday 값이 아예 없던 예전 데이터뿐 아니라, 분류 기준이 바뀌어 값이 잘못
// 저장된 경우도 있어서 neis 출처 항목은 전부 대상으로 삼는다.
async function reclassifyNeisHolidays() {
  if (!schoolMeta?.neisOfficeCode || !schoolMeta?.neisSchoolCode) return;
  const stale = state.events.filter((e) => e.source === "neis");
  if (!stale.length) return;

  const months = new Set(stale.map((e) => e.date.slice(0, 7)));
  const neisRows = [];
  for (const ym of months) {
    const [y, m] = ym.split("-").map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    const fromYmd = `${y}${String(m).padStart(2, "0")}01`;
    const toYmd = `${y}${String(m).padStart(2, "0")}${String(lastDay).padStart(2, "0")}`;
    try {
      const res = await fetchNeisScheduleFn({
        officeCode: schoolMeta.neisOfficeCode,
        schoolCode: schoolMeta.neisSchoolCode,
        fromYmd, toYmd,
      });
      neisRows.push(...(res.data || []));
    } catch (e) {
      console.error("[neis] reclassify fetch failed", e);
    }
  }

  const lookup = new Map(neisRows.map((r) => [`${r.date}|${r.title}`, r.isHoliday]));
  for (const e of stale) {
    const isHoliday = lookup.get(`${e.date}|${e.title}`);
    if (isHoliday === undefined || isHoliday === e.isHoliday) continue; // 확인 불가하거나 이미 맞으면 건너뜀
    try {
      await updateDoc(doc(db, "schools", schoolId, "events", e.id), { isHoliday });
    } catch (e2) {
      console.error("[neis] reclassify update failed", e2);
    }
  }
}

function attachSchoolListeners() {
  const cols = [
    ["events", (arr) => (state.events = arr)],
    ["duties", (arr) => (state.duties = arr)],
    ["docs", (arr) => (state.docs = arr)],
  ];
  cols.forEach(([name, setter]) => {
    const unsub = onSnapshot(
      collection(db, "schools", schoolId, name),
      (snap) => {
        setter(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        renderAll();
        if (name === "events" && !neisReclassifyDone) {
          neisReclassifyDone = true;
          reclassifyNeisHolidays();
        }
      },
      (err) => console.error(`${name} listener error`, err)
    );
    unsubs.push(unsub);
  });
}

function detachListeners() {
  unsubs.forEach((u) => u());
  unsubs = [];
  state.events = [];
  state.duties = [];
  state.docs = [];
}

document.getElementById("schoolName").addEventListener("change", async (e) => {
  if (!schoolId) return;
  const name = e.target.value.trim() || state.schoolName;
  e.target.value = name;
  try {
    await updateDoc(doc(db, "schools", schoolId), { name });
    state.schoolName = name;
  } catch (err) {
    alert("학교 이름 변경 실패: " + err.message);
  }
});

// ---------- invite modal ----------
const inviteModalOverlay = document.getElementById("inviteModalOverlay");
document.getElementById("inviteBtn").addEventListener("click", () => (inviteModalOverlay.hidden = false));
document.getElementById("inviteModalClose").addEventListener("click", () => (inviteModalOverlay.hidden = true));
inviteModalOverlay.addEventListener("click", (e) => {
  if (e.target === inviteModalOverlay) inviteModalOverlay.hidden = true;
});
document.getElementById("copyInviteBtn").addEventListener("click", async () => {
  const code = document.getElementById("inviteCodeBox").textContent;
  try {
    await navigator.clipboard.writeText(code);
    alert("참여코드가 복사되었습니다.");
  } catch (e) {
    alert("복사에 실패했습니다. 코드: " + code);
  }
});

// ---------- NEIS 학사일정 가져오기 ----------
const searchNeisSchoolFn = httpsCallable(functions, "searchNeisSchool");
const fetchNeisScheduleFn = httpsCallable(functions, "fetchNeisSchedule");

const neisModalOverlay = document.getElementById("neisModalOverlay");
const neisSearchPane = document.getElementById("neisSearchPane");
const neisSchedulePane = document.getElementById("neisSchedulePane");
let neisScheduleCache = []; // 현재 모달에 표시 중인 {date, title, memo, alreadyAdded} 목록

function closeNeisModal() {
  neisModalOverlay.hidden = true;
}
function showNeisSearchPane() {
  neisSearchPane.hidden = false;
  neisSchedulePane.hidden = true;
  document.getElementById("neisImportSelectedBtn").hidden = true;
}
async function showNeisSchedulePane() {
  neisSearchPane.hidden = true;
  neisSchedulePane.hidden = false;
  document.getElementById("neisLinkedSchoolName").textContent = schoolMeta.neisSchoolName || "";
  await loadNeisSchedule();
}

document.getElementById("neisImportBtn").addEventListener("click", async () => {
  neisModalOverlay.hidden = false;
  document.getElementById("neisSchoolQuery").value = "";
  document.getElementById("neisSearchResults").innerHTML = "";
  if (schoolMeta?.neisOfficeCode && schoolMeta?.neisSchoolCode) {
    await showNeisSchedulePane();
  } else {
    showNeisSearchPane();
  }
});
document.getElementById("neisModalClose").addEventListener("click", closeNeisModal);
document.getElementById("neisCancelBtn").addEventListener("click", closeNeisModal);
neisModalOverlay.addEventListener("click", (e) => {
  if (e.target === neisModalOverlay) closeNeisModal();
});
document.getElementById("neisRelinkBtn").addEventListener("click", showNeisSearchPane);

document.getElementById("neisSearchBtn").addEventListener("click", async () => {
  const schoolName = document.getElementById("neisSchoolQuery").value.trim();
  if (!schoolName) return alert("학교 이름을 입력해주세요.");
  const resultsBox = document.getElementById("neisSearchResults");
  resultsBox.innerHTML = `<div class="empty-note">검색 중...</div>`;
  try {
    const res = await searchNeisSchoolFn({ schoolName });
    const rows = res.data || [];
    if (!rows.length) {
      resultsBox.innerHTML = `<div class="empty-note">검색 결과가 없습니다. 학교 이름을 다시 확인해주세요.</div>`;
      return;
    }
    resultsBox.innerHTML = "";
    rows.forEach((r) => {
      const item = document.createElement("div");
      item.className = "side-item";
      item.innerHTML = `
        <div class="si-top"><span>${escapeHtml(r.schoolName)}</span></div>
        <div class="si-meta">${escapeHtml(r.officeName)} · ${escapeHtml(r.address)}</div>`;
      item.addEventListener("click", async () => {
        try {
          await updateDoc(doc(db, "schools", schoolId), {
            neisOfficeCode: r.officeCode,
            neisSchoolCode: r.schoolCode,
            neisSchoolName: r.schoolName,
          });
          schoolMeta.neisOfficeCode = r.officeCode;
          schoolMeta.neisSchoolCode = r.schoolCode;
          schoolMeta.neisSchoolName = r.schoolName;
          await showNeisSchedulePane();
        } catch (e) {
          alert("학교 연동에 실패했습니다: " + e.message);
        }
      });
      resultsBox.appendChild(item);
    });
  } catch (e) {
    resultsBox.innerHTML = `<div class="empty-note">검색에 실패했습니다: ${escapeHtml(e.message)}</div>`;
  }
});

async function loadNeisSchedule() {
  const listBox = document.getElementById("neisScheduleList");
  const importBtn = document.getElementById("neisImportSelectedBtn");
  importBtn.hidden = true;
  listBox.innerHTML = `<div class="empty-note">${state.viewYear}년 ${state.viewMonth}월 학사일정을 불러오는 중...</div>`;

  const { viewYear: y, viewMonth: m } = state;
  const lastDay = new Date(y, m, 0).getDate();
  const fromYmd = `${y}${String(m).padStart(2, "0")}01`;
  const toYmd = `${y}${String(m).padStart(2, "0")}${String(lastDay).padStart(2, "0")}`;

  try {
    const res = await fetchNeisScheduleFn({
      officeCode: schoolMeta.neisOfficeCode,
      schoolCode: schoolMeta.neisSchoolCode,
      fromYmd,
      toYmd,
    });
    const existingKeys = new Set(state.events.map((e) => `${e.date}|${e.title}`));
    neisScheduleCache = (res.data || []).map((r) => ({
      ...r,
      alreadyAdded: existingKeys.has(`${r.date}|${r.title}`),
    }));

    if (!neisScheduleCache.length) {
      listBox.innerHTML = `<div class="empty-note">${y}년 ${m}월에는 나이스에 등록된 학사일정이 없습니다.</div>`;
      return;
    }

    listBox.innerHTML = "";
    neisScheduleCache.forEach((r, i) => {
      const row = document.createElement("label");
      row.className = "side-item";
      row.style.display = "flex";
      row.style.alignItems = "flex-start";
      row.style.gap = "8px";
      row.style.cursor = r.alreadyAdded ? "default" : "pointer";
      row.innerHTML = `
        <input type="checkbox" data-idx="${i}" style="margin-top:3px" ${r.alreadyAdded ? "checked disabled" : "checked"} />
        <span>
          <div class="si-top"><span>${escapeHtml(r.title)}${r.isHoliday ? ' <span class="holiday-badge">공휴일</span>' : ""}</span><span class="si-date">${r.date.slice(5)}</span></div>
          <div class="si-meta">${r.alreadyAdded ? "이미 등록되어 있어요" : escapeHtml(r.memo || "")}</div>
        </span>`;
      listBox.appendChild(row);
    });
    importBtn.hidden = false;
  } catch (e) {
    listBox.innerHTML = `<div class="empty-note">불러오기에 실패했습니다: ${escapeHtml(e.message)}</div>`;
  }
}

document.getElementById("neisImportSelectedBtn").addEventListener("click", async () => {
  const importBtn = document.getElementById("neisImportSelectedBtn");
  const checked = Array.from(document.querySelectorAll('#neisScheduleList input[type="checkbox"]:checked:not(:disabled)'));
  if (!checked.length) return alert("가져올 항목을 선택해주세요.");
  importBtn.disabled = true;
  try {
    for (const cb of checked) {
      const r = neisScheduleCache[Number(cb.dataset.idx)];
      await addDoc(collection(db, "schools", schoolId, "events"), {
        date: r.date,
        endDate: null,
        time: null,
        endTime: null,
        title: r.title,
        memo: r.memo || "",
        isHoliday: !!r.isHoliday,
        createdByName: "나이스 학사일정",
        source: "neis",
        createdAt: serverTimestamp(),
      });
    }
    alert(`${checked.length}건을 가져왔습니다.`);
    closeNeisModal();
  } catch (e) {
    alert("가져오기에 실패했습니다: " + e.message);
  } finally {
    importBtn.disabled = false;
  }
});

// ============================================================
// helpers over item arrays
// ============================================================
function byTime(a, b) {
  if (!a.time && !b.time) return 0;
  if (!a.time) return 1; // 시간 없는 항목은 뒤로
  if (!b.time) return -1;
  return a.time.localeCompare(b.time);
}
function timeLabel(item) {
  return item.time ? `${item.time} ` : "";
}
function itemsForDate(dateStr) {
  const events = state.events
    .filter((e) => dateStr === e.date || (e.endDate && dateStr >= e.date && dateStr <= e.endDate))
    .sort(byTime);
  const duties = state.duties
    .filter((d) => dateStr === d.date || (d.endDate && dateStr >= d.date && dateStr <= d.endDate))
    .sort(byTime);
  const docs = state.docs.filter((d) => d.date === dateStr).sort(byTime);
  return { events, duties, docs };
}
function monthRangeKey(y, m) {
  return `${y}-${String(m).padStart(2, "0")}`;
}
function isInMonth(dateStr, y, m) {
  return dateStr.startsWith(monthRangeKey(y, m));
}
function itemOverlapsMonth(item, y, m) {
  const start = item.date;
  const end = item.endDate || item.date;
  const monthStart = `${monthRangeKey(y, m)}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const monthEnd = `${monthRangeKey(y, m)}-${String(lastDay).padStart(2, "0")}`;
  return start <= monthEnd && end >= monthStart;
}

// ============================================================
// RENDERING
// ============================================================
const els = {
  schoolName: document.getElementById("schoolName"),
  yearSelect: document.getElementById("yearSelect"),
  monthSelect: document.getElementById("monthSelect"),
  calendarTitle: document.getElementById("calendarTitle"),
  calendarGrid: document.getElementById("calendarGrid"),
  sumEvents: document.getElementById("sumEvents"),
  sumDuties: document.getElementById("sumDuties"),
  sumDocs: document.getElementById("sumDocs"),
  sumDocsPending: document.getElementById("sumDocsPending"),
  todayEventList: document.getElementById("todayEventList"),
  todayDutyList: document.getElementById("todayDutyList"),
  todayDocList: document.getElementById("todayDocList"),
  upcomingEventList: document.getElementById("upcomingEventList"),
  upcomingDocList: document.getElementById("upcomingDocList"),
};

function populateYearMonthSelectors() {
  const curYear = state.viewYear;
  els.yearSelect.innerHTML = "";
  for (let y = curYear - 5; y <= curYear + 5; y++) {
    const opt = document.createElement("option");
    opt.value = y;
    opt.textContent = y;
    if (y === curYear) opt.selected = true;
    els.yearSelect.appendChild(opt);
  }
  els.monthSelect.innerHTML = "";
  for (let m = 1; m <= 12; m++) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m;
    if (m === state.viewMonth) opt.selected = true;
    els.monthSelect.appendChild(opt);
  }
}

function renderAll() {
  if (document.getElementById("dashboardScreen").hidden) return;
  populateYearMonthSelectors();
  els.calendarTitle.textContent = `${state.viewYear}년 ${state.viewMonth}월`;
  renderCalendar();
  renderSummary();
  renderTodayLists();
  renderUpcomingLists();
  saveViewPref();
}

function renderCalendar() {
  const { viewYear: y, viewMonth: m } = state;
  const grid = els.calendarGrid;
  grid.innerHTML = "";

  const firstOfMonth = new Date(y, m - 1, 1);
  const startWeekday = firstOfMonth.getDay();
  const daysInMonth = new Date(y, m, 0).getDate();
  const daysInPrevMonth = new Date(y, m - 1, 0).getDate();

  const totalCells = Math.ceil((startWeekday + daysInMonth) / 7) * 7;

  for (let i = 0; i < totalCells; i++) {
    const dayOffset = i - startWeekday;
    let cellDate, otherMonth = false;
    if (dayOffset < 0) {
      cellDate = new Date(y, m - 2, daysInPrevMonth + dayOffset + 1);
      otherMonth = true;
    } else if (dayOffset >= daysInMonth) {
      cellDate = new Date(y, m, dayOffset - daysInMonth + 1);
      otherMonth = true;
    } else {
      cellDate = new Date(y, m - 1, dayOffset + 1);
    }
    const dateStr = formatDate(cellDate);
    const weekday = cellDate.getDay();

    const cell = document.createElement("div");
    cell.className = "day-cell" + (otherMonth ? " other-month" : "") + (dateStr === todayStr() ? " today" : "");
    cell.dataset.date = dateStr;

    const num = document.createElement("div");
    num.className = "day-num" + (weekday === 0 ? " sun" : weekday === 6 ? " sat" : "");
    num.textContent = cellDate.getDate();
    cell.appendChild(num);

    const itemsWrap = document.createElement("div");
    itemsWrap.className = "day-items";
    const { events, duties, docs } = itemsForDate(dateStr);
    const chips = [
      ...events.map((e) => ({ cls: e.isHoliday ? "holiday" : "event", label: `${timeLabel(e)}${e.title}` })),
      ...duties.map((d) => ({ cls: "duty", label: `${timeLabel(d)}${d.person} ${d.type}` })),
      ...docs.map((d) => ({ cls: "doc", label: `${timeLabel(d)}${d.title}` })),
    ];
    const maxShow = 3;
    chips.slice(0, maxShow).forEach((c) => {
      const chip = document.createElement("div");
      chip.className = `day-chip ${c.cls}`;
      chip.textContent = c.label;
      itemsWrap.appendChild(chip);
    });
    if (chips.length > maxShow) {
      const more = document.createElement("div");
      more.className = "day-more";
      more.textContent = `+${chips.length - maxShow}건 더보기`;
      itemsWrap.appendChild(more);
    }
    cell.appendChild(itemsWrap);

    const hint = document.createElement("div");
    hint.className = "add-hint";
    hint.textContent = "+";
    cell.appendChild(hint);

    cell.addEventListener("click", () => openDayPopover(cell, dateStr));
    grid.appendChild(cell);
  }
}

function renderSummary() {
  const { viewYear: y, viewMonth: m } = state;
  const events = state.events.filter((e) => itemOverlapsMonth(e, y, m) && !e.isHoliday);
  const duties = state.duties.filter((d) => itemOverlapsMonth(d, y, m));
  const docs = state.docs.filter((d) => isInMonth(d.date, y, m));
  els.sumEvents.textContent = events.length;
  els.sumDuties.textContent = duties.length;
  els.sumDocs.textContent = docs.length;
  els.sumDocsPending.textContent = docs.filter((d) => d.status === "pending").length;
}

function dateLabel(item) {
  const startPart = item.time ? `${item.date.slice(5)} ${item.time}` : item.date.slice(5);
  if (!item.endDate || item.endDate === item.date) return startPart;
  const endPart = item.endTime ? `${item.endDate.slice(5)} ${item.endTime}` : item.endDate.slice(5);
  return `${startPart} ~ ${endPart}`;
}

function docMetaLine(d) {
  const parts = [];
  if (d.person) parts.push(escapeHtml(d.person));
  if (d.sender) parts.push(escapeHtml(d.sender));
  parts.push(d.status === "done" ? "완료" : "처리중");
  return parts.join(" · ");
}

function renderTodayLists() {
  const { events: allEvents, duties, docs } = itemsForDate(todayStr());
  const events = allEvents.filter((e) => !e.isHoliday);

  els.todayEventList.innerHTML = "";
  if (!events.length) els.todayEventList.innerHTML = `<div class="empty-note">오늘 등록된 행사가 없습니다.</div>`;
  events.forEach((e) => {
    const item = document.createElement("div");
    item.className = "side-item";
    item.innerHTML = `
      <div class="si-top"><span>${escapeHtml(e.title)}</span><span class="si-date">${dateLabel(e)}</span></div>
      <div class="si-meta">${escapeHtml(e.memo || "")}</div>`;
    item.addEventListener("click", () => openModal("event", e.date, e));
    els.todayEventList.appendChild(item);
  });

  els.todayDutyList.innerHTML = "";
  if (!duties.length) els.todayDutyList.innerHTML = `<div class="empty-note">오늘 등록된 복무가 없습니다.</div>`;
  duties.forEach((d) => {
    const item = document.createElement("div");
    item.className = "side-item";
    item.innerHTML = `
      <div class="si-top"><span>${escapeHtml(d.person)} · ${escapeHtml(d.role)}</span><span class="si-date">${dateLabel(d)}</span></div>
      <div class="si-meta">${escapeHtml(d.type)} · ${escapeHtml(d.title || "")}${d.destination ? ` · ${escapeHtml(d.destination)}` : ""}</div>`;
    item.addEventListener("click", () => openModal("duty", d.date, d));
    els.todayDutyList.appendChild(item);
  });

  els.todayDocList.innerHTML = "";
  if (!docs.length) els.todayDocList.innerHTML = `<div class="empty-note">오늘 등록된 공문(보고)이 없습니다.</div>`;
  docs.forEach((d) => {
    const item = document.createElement("div");
    item.className = `side-item status-${d.status}`;
    item.innerHTML = `
      <div class="si-top"><span>${escapeHtml(d.title)}</span><span class="si-date">${dateLabel(d)}</span></div>
      <div class="si-meta">${docMetaLine(d)}</div>`;
    item.addEventListener("click", () => openModal("doc", d.date, d));
    els.todayDocList.appendChild(item);
  });
}

function addDays(dateStr, n) {
  const d = parseDate(dateStr);
  d.setDate(d.getDate() + n);
  return formatDate(d);
}
function itemOverlapsRange(item, rangeStart, rangeEnd) {
  const start = item.date;
  const end = item.endDate || item.date;
  return start <= rangeEnd && end >= rangeStart;
}

function renderUpcomingLists() {
  const rangeStart = addDays(todayStr(), 1);
  const rangeEnd = addDays(todayStr(), 7);

  const events = state.events
    .filter((e) => !e.isHoliday && itemOverlapsRange(e, rangeStart, rangeEnd))
    .sort((a, b) => a.date.localeCompare(b.date) || byTime(a, b));
  els.upcomingEventList.innerHTML = "";
  if (!events.length) els.upcomingEventList.innerHTML = `<div class="empty-note">앞으로 7일간 등록된 행사가 없습니다.</div>`;
  events.forEach((e) => {
    const item = document.createElement("div");
    item.className = "side-item";
    item.innerHTML = `
      <div class="si-top"><span>${escapeHtml(e.title)}</span><span class="si-date">${dateLabel(e)}</span></div>
      <div class="si-meta">${escapeHtml(e.memo || "")}</div>`;
    item.addEventListener("click", () => openModal("event", e.date, e));
    els.upcomingEventList.appendChild(item);
  });

  const docs = state.docs
    .filter((d) => d.date >= rangeStart && d.date <= rangeEnd)
    .sort((a, b) => a.date.localeCompare(b.date) || byTime(a, b));
  els.upcomingDocList.innerHTML = "";
  if (!docs.length) els.upcomingDocList.innerHTML = `<div class="empty-note">앞으로 7일간 등록된 공문(보고)이 없습니다.</div>`;
  docs.forEach((d) => {
    const item = document.createElement("div");
    item.className = `side-item status-${d.status}`;
    item.innerHTML = `
      <div class="si-top"><span>${escapeHtml(d.title)}</span><span class="si-date">${dateLabel(d)}</span></div>
      <div class="si-meta">${docMetaLine(d)}</div>`;
    item.addEventListener("click", () => openModal("doc", d.date, d));
    els.upcomingDocList.appendChild(item);
  });
}

// ============================================================
// MODAL (add / edit)
// ============================================================
const modalOverlay = document.getElementById("modalOverlay");
const modalTitle = document.getElementById("modalTitle");
const tabBtns = document.querySelectorAll("#modalOverlay .tab-btn");
const fieldGroups = document.querySelectorAll(".form-fields");
const fDocDate = document.getElementById("f-docDate");
const fDocDateRow = document.getElementById("f-docDateRow");
const fStart = document.getElementById("f-start");
const fStartRow = document.getElementById("f-startRow");
const fEnd = document.getElementById("f-end");
const fEndRow = document.getElementById("f-endRow");
const itemAuthorLine = document.getElementById("itemAuthorLine");

const COLLECTION_BY_TYPE = { event: "events", duty: "duties", doc: "docs" };

let currentType = "event";
let editingItem = null;

// "YYYY-MM-DD" + "HH:MM"(선택) -> datetime-local 문자열
function toDatetimeLocal(dateStr, timeStr) {
  if (!dateStr) return "";
  return `${dateStr}T${timeStr || "00:00"}`;
}
// datetime-local 문자열 -> { date, time }
function splitDatetimeLocal(value) {
  if (!value) return { date: null, time: null };
  const [date, time] = value.split("T");
  return { date: date || null, time: time || null };
}

const TYPE_LABELS = { event: "행사", duty: "복무", doc: "공문(보고)" };

function openModal(type, dateStr, existing) {
  currentType = type;
  editingItem = existing || null;
  modalTitle.textContent = `${TYPE_LABELS[type]} ${existing ? "수정" : "추가"}`;

  tabBtns.forEach((b) => b.classList.toggle("active", b.dataset.type === type));
  tabBtns.forEach((b) => (b.disabled = !!existing));
  fieldGroups.forEach((g) => (g.hidden = g.dataset.fields !== type));
  const isDoc = type === "doc";
  fDocDateRow.hidden = !isDoc;
  fStartRow.hidden = isDoc;
  fEndRow.hidden = isDoc;

  fDocDate.value = toDatetimeLocal(existing?.date || dateStr || todayStr(), existing?.time || "09:00");
  fStart.value = toDatetimeLocal(existing?.date || dateStr || todayStr(), existing?.time || "09:00");
  fEnd.value = existing?.endDate ? toDatetimeLocal(existing.endDate, existing.endTime || "09:00") : "";

  document.getElementById("ev-title").value = "";
  document.getElementById("ev-memo").value = "";
  document.getElementById("du-person").value = localName || "";
  document.getElementById("du-role").value = "교사";
  document.getElementById("du-type").value = "출장";
  document.getElementById("du-title").value = "";
  document.getElementById("du-destination").value = "";
  document.getElementById("du-memo").value = "";
  document.getElementById("doc-title").value = "";
  document.getElementById("doc-person").value = localName || "";
  document.getElementById("doc-sender").value = "";
  document.getElementById("doc-status").value = "pending";
  document.getElementById("doc-memo").value = "";

  if (existing) {
    if (type === "event") {
      document.getElementById("ev-title").value = existing.title || "";
      document.getElementById("ev-memo").value = existing.memo || "";
    } else if (type === "duty") {
      document.getElementById("du-person").value = existing.person || "";
      document.getElementById("du-role").value = existing.role || "교사";
      document.getElementById("du-type").value = existing.type || "출장";
      document.getElementById("du-title").value = existing.title || "";
      document.getElementById("du-destination").value = existing.destination || "";
      document.getElementById("du-memo").value = existing.memo || "";
    } else if (type === "doc") {
      document.getElementById("doc-title").value = existing.title || "";
      document.getElementById("doc-person").value = existing.person || localName || "";
      document.getElementById("doc-sender").value = existing.sender || "";
      document.getElementById("doc-status").value = existing.status || "pending";
      document.getElementById("doc-memo").value = existing.memo || "";
    }
  }

  updateDutyDestinationVisibility();

  if (existing) {
    itemAuthorLine.hidden = false;
    itemAuthorLine.textContent = `작성자: ${existing.createdByName || "알 수 없음"}`;
  } else {
    itemAuthorLine.hidden = true;
  }

  document.getElementById("deleteBtn").hidden = !existing;
  modalOverlay.hidden = false;
  closeDayPopover();
}

function updateDutyDestinationVisibility() {
  const isBusinessTrip = document.getElementById("du-type").value === "출장";
  document.getElementById("du-destinationRow").hidden = !isBusinessTrip;
}
document.getElementById("du-type").addEventListener("change", updateDutyDestinationVisibility);

function closeModal() {
  modalOverlay.hidden = true;
  editingItem = null;
}

tabBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    if (editingItem) return;
    currentType = btn.dataset.type;
    modalTitle.textContent = `${TYPE_LABELS[currentType]} 추가`;
    tabBtns.forEach((b) => b.classList.toggle("active", b === btn));
    fieldGroups.forEach((g) => (g.hidden = g.dataset.fields !== currentType));
    const isDoc = currentType === "doc";
    fDocDateRow.hidden = !isDoc;
    fStartRow.hidden = isDoc;
    fEndRow.hidden = isDoc;
    // 탭을 바꿔도 이미 고른 날짜/시간은 유지
    if (isDoc) {
      fDocDate.value = fStart.value || fDocDate.value || toDatetimeLocal(todayStr(), "09:00");
    } else if (!fStart.value) {
      fStart.value = fDocDate.value || toDatetimeLocal(todayStr(), "09:00");
    }
  });
});

// 종료일시를 아직 입력 전이면, 처음 눌렀을 때 시작일시의 연/월/일을 기본값으로 넣어준다.
fEnd.addEventListener("focus", () => {
  if (fEnd.value || !fStart.value) return;
  const { date: startDate, time: startTime } = splitDatetimeLocal(fStart.value);
  fEnd.value = toDatetimeLocal(startDate, startTime || "09:00");
});
// 시작일시를 바꾸면, 이미 입력된 종료일시의 날짜도 함께 따라간다 (시간은 유지).
fStart.addEventListener("change", () => {
  if (!fEnd.value) return;
  const { date: startDate } = splitDatetimeLocal(fStart.value);
  const { time: endTime } = splitDatetimeLocal(fEnd.value);
  if (startDate) fEnd.value = toDatetimeLocal(startDate, endTime);
});

document.getElementById("modalClose").addEventListener("click", closeModal);
document.getElementById("cancelBtn").addEventListener("click", closeModal);
modalOverlay.addEventListener("click", (e) => {
  if (e.target === modalOverlay) closeModal();
});

document.getElementById("saveBtn").addEventListener("click", async () => {
  const colName = COLLECTION_BY_TYPE[currentType];
  const saveBtn = document.getElementById("saveBtn");

  let payload;
  if (currentType === "event" || currentType === "duty") {
    if (!fStart.value) return alert("시작일시를 선택해주세요.");
    const { date, time } = splitDatetimeLocal(fStart.value);
    const { date: endDate, time: endTime } = splitDatetimeLocal(fEnd.value);
    if (endDate && endDate < date) return alert("종료일시는 시작일시보다 빠를 수 없습니다.");

    if (currentType === "event") {
      const title = document.getElementById("ev-title").value.trim();
      if (!title) return alert("행사명을 입력해주세요.");
      payload = { date, time, endDate, endTime, title, memo: document.getElementById("ev-memo").value.trim() };
    } else {
      const person = document.getElementById("du-person").value.trim();
      if (!person) return alert("대상자를 입력해주세요.");
      const dutyType = document.getElementById("du-type").value;
      payload = {
        date, time, endDate, endTime,
        person,
        role: document.getElementById("du-role").value,
        type: dutyType,
        title: document.getElementById("du-title").value.trim(),
        destination: dutyType === "출장" ? document.getElementById("du-destination").value.trim() : "",
        memo: document.getElementById("du-memo").value.trim(),
      };
    }
  } else {
    if (!fDocDate.value) return alert("보고기한을 선택해주세요.");
    const { date, time } = splitDatetimeLocal(fDocDate.value);
    const title = document.getElementById("doc-title").value.trim();
    if (!title) return alert("공문(보고) 제목을 입력해주세요.");
    payload = {
      date, time,
      title,
      person: document.getElementById("doc-person").value.trim(),
      sender: document.getElementById("doc-sender").value.trim(),
      status: document.getElementById("doc-status").value,
      memo: document.getElementById("doc-memo").value.trim(),
    };
  }

  saveBtn.disabled = true;
  try {
    if (editingItem) {
      await updateDoc(doc(db, "schools", schoolId, colName, editingItem.id), {
        ...payload,
        updatedAt: serverTimestamp(),
      });
    } else {
      await addDoc(collection(db, "schools", schoolId, colName), {
        ...payload,
        createdByName: localName || "이름없음",
        createdAt: serverTimestamp(),
      });
    }
    closeModal();
  } catch (e) {
    alert("저장에 실패했습니다: " + e.message);
  } finally {
    saveBtn.disabled = false;
  }
});

document.getElementById("deleteBtn").addEventListener("click", async () => {
  if (!editingItem) return;
  if (!confirm("이 항목을 삭제할까요?")) return;
  const colName = COLLECTION_BY_TYPE[currentType];
  try {
    await deleteDoc(doc(db, "schools", schoolId, colName, editingItem.id));
    closeModal();
  } catch (e) {
    alert("삭제에 실패했습니다: " + e.message);
  }
});

// ============================================================
// DAY POPOVER
// ============================================================
const dayPopover = document.getElementById("dayPopover");

function openDayPopover(cellEl, dateStr) {
  const { events, duties, docs } = itemsForDate(dateStr);
  const rect = cellEl.getBoundingClientRect();
  const scrollY = window.scrollY, scrollX = window.scrollX;

  let html = `<h4>${dateStr}</h4>`;
  html += `<div class="si-add">
      <button class="btn btn-sm" data-quick="event">+행사</button>
      <button class="btn btn-sm" data-quick="duty">+복무</button>
      <button class="btn btn-sm" data-quick="doc">+공문(보고)</button>
    </div>`;

  const rows = [
    ...events.map((e) => ({ type: "event", cls: e.isHoliday ? "holiday" : "event", label: `${timeLabel(e)}${e.title}`, item: e })),
    ...duties.map((d) => ({ type: "duty", cls: "duty", label: `${timeLabel(d)}${d.person}(${d.role}) ${d.type} - ${d.title || ""}${d.destination ? ` (${d.destination})` : ""}`, item: d })),
    ...docs.map((d) => ({ type: "doc", cls: "doc", label: `${timeLabel(d)}${d.title}${d.person ? ` - ${d.person}` : ""} [${d.status === "done" ? "완료" : "처리중"}]`, item: d })),
  ];
  if (!rows.length) {
    html += `<div class="empty-note">등록된 일정이 없습니다.</div>`;
  } else {
    rows.forEach((r, i) => {
      html += `<div class="day-chip ${r.cls}" style="margin-bottom:4px;cursor:pointer;white-space:normal" data-row="${i}">${escapeHtml(r.label)}</div>`;
    });
  }

  dayPopover.innerHTML = html;
  dayPopover.hidden = false; // 크기를 재려면 먼저 화면에 그려져 있어야 함
  dayPopover.style.top = "0px";
  dayPopover.style.left = "0px";

  const popH = dayPopover.offsetHeight;
  const popW = dayPopover.offsetWidth;
  const viewportBottom = scrollY + window.innerHeight;
  const viewportRight = scrollX + window.innerWidth;

  let top = rect.bottom + scrollY + 4;
  if (top + popH > viewportBottom) {
    // 아래쪽에 공간이 부족하면 셀 위쪽에 표시
    top = Math.max(scrollY + 4, rect.top + scrollY - popH - 4);
  }
  let left = rect.left + scrollX;
  left = Math.min(left, viewportRight - popW - 8);
  left = Math.max(scrollX + 8, left);

  dayPopover.style.top = `${top}px`;
  dayPopover.style.left = `${left}px`;

  dayPopover.querySelectorAll("[data-quick]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openModal(btn.dataset.quick, dateStr);
    });
  });
  dayPopover.querySelectorAll("[data-row]").forEach((el) => {
    el.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const r = rows[Number(el.dataset.row)];
      openModal(r.type, dateStr, r.item);
    });
  });
}

function closeDayPopover() {
  dayPopover.hidden = true;
}

document.addEventListener("click", (e) => {
  if (!dayPopover.contains(e.target) && !e.target.closest(".day-cell")) {
    closeDayPopover();
  }
});

document.querySelectorAll("[data-add]").forEach((btn) => {
  btn.addEventListener("click", () => openModal(btn.dataset.add, todayStr()));
});

// ============================================================
// TOP TOOLBAR
// ============================================================
document.getElementById("prevMonth").addEventListener("click", () => changeMonth(-1));
document.getElementById("nextMonth").addEventListener("click", () => changeMonth(1));
document.getElementById("todayBtn").addEventListener("click", () => {
  const now = new Date();
  state.viewYear = now.getFullYear();
  state.viewMonth = now.getMonth() + 1;
  renderAll();
});

function changeMonth(delta) {
  let m = state.viewMonth + delta;
  let y = state.viewYear;
  if (m < 1) { m = 12; y -= 1; }
  if (m > 12) { m = 1; y += 1; }
  state.viewMonth = m;
  state.viewYear = y;
  renderAll();
}

els.yearSelect.addEventListener("change", (e) => {
  state.viewYear = Number(e.target.value);
  renderAll();
});
els.monthSelect.addEventListener("change", (e) => {
  state.viewMonth = Number(e.target.value);
  renderAll();
});

// ============================================================
// PRINT VIEW
// ============================================================
const printModalOverlay = document.getElementById("printModalOverlay");
const printChkAll = document.getElementById("printChkAll");
const printChkCats = document.querySelectorAll(".printChkCat");

document.getElementById("printBtn").addEventListener("click", () => {
  printModalOverlay.hidden = false;
});
document.getElementById("printModalClose").addEventListener("click", () => (printModalOverlay.hidden = true));
document.getElementById("printModalCancel").addEventListener("click", () => (printModalOverlay.hidden = true));
printModalOverlay.addEventListener("click", (e) => {
  if (e.target === printModalOverlay) printModalOverlay.hidden = true;
});

printChkAll.addEventListener("change", () => {
  printChkCats.forEach((cb) => (cb.checked = printChkAll.checked));
});
printChkCats.forEach((cb) => {
  cb.addEventListener("change", () => {
    printChkAll.checked = Array.from(printChkCats).every((c) => c.checked);
  });
});

document.getElementById("printModalGo").addEventListener("click", () => {
  const selected = {};
  printChkCats.forEach((cb) => (selected[cb.dataset.cat] = cb.checked));
  if (!selected.event && !selected.duty && !selected.doc) {
    return alert("인쇄할 항목을 하나 이상 선택해주세요.");
  }
  const printArea = document.getElementById("printArea");
  printArea.classList.toggle("hide-event-col", !selected.event);
  printArea.classList.toggle("hide-duty-col", !selected.duty);
  printArea.classList.toggle("hide-doc-col", !selected.doc);

  buildPrintTable();
  printModalOverlay.hidden = true;
  window.print();
});

function buildPrintTable() {
  const { viewYear: y, viewMonth: m } = state;
  document.getElementById("printTitle").textContent = `${y}년 ${m}월 월중계획`;
  document.getElementById("printSchoolName").textContent = state.schoolName;
  document.getElementById("printDate").textContent = `작성일: ${todayStr()}`;

  const daysInMonth = new Date(y, m, 0).getDate();
  const weekdayNames = ["일", "월", "화", "수", "목", "금", "토"];
  const tbody = document.getElementById("printTableBody");
  tbody.innerHTML = "";

  for (let d = 1; d <= daysInMonth; d++) {
    const dateObj = new Date(y, m - 1, d);
    const dateStr = formatDate(dateObj);
    const weekday = dateObj.getDay();
    const { events, duties, docs } = itemsForDate(dateStr);

    const tr = document.createElement("tr");
    tr.className =
      (weekday === 0 ? "print-row-sun print-row-weekend" : "") +
      (weekday === 6 ? "print-row-sat print-row-weekend" : "");

    const tdDate = document.createElement("td");
    tdDate.className = "col-date";
    tdDate.textContent = d;
    const tdDay = document.createElement("td");
    tdDay.className = "col-day";
    tdDay.textContent = weekdayNames[weekday];

    const tdEvent = document.createElement("td");
    tdEvent.className = "col-event";
    tdEvent.innerHTML = events.map((e) => `<div class="print-item">${escapeHtml(timeLabel(e))}${escapeHtml(e.title)}${e.memo ? ` (${escapeHtml(e.memo)})` : ""}</div>`).join("") || "";

    const tdDuty = document.createElement("td");
    tdDuty.className = "col-duty";
    tdDuty.innerHTML = duties
      .map((d2) => `<div class="print-item">${escapeHtml(timeLabel(d2))}${escapeHtml(d2.person)}(${escapeHtml(d2.role)}) ${escapeHtml(d2.type)}${d2.title ? ` - ${escapeHtml(d2.title)}` : ""}${d2.destination ? ` (${escapeHtml(d2.destination)})` : ""}</div>`)
      .join("") || "";

    const tdDoc = document.createElement("td");
    tdDoc.className = "col-doc";
    tdDoc.innerHTML = docs
      .map((d3) => `<div class="print-item">${escapeHtml(timeLabel(d3))}${escapeHtml(d3.title)}${d3.person ? ` - ${escapeHtml(d3.person)}` : ""}${d3.sender ? ` (${escapeHtml(d3.sender)})` : ""} ${d3.status === "done" ? "[완료]" : "[처리중]"}</div>`)
      .join("") || "";

    tr.appendChild(tdDate);
    tr.appendChild(tdDay);
    tr.appendChild(tdEvent);
    tr.appendChild(tdDuty);
    tr.appendChild(tdDoc);
    tbody.appendChild(tr);
  }
}
