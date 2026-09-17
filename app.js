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
import { firebaseConfig } from "./firebase-config.js";

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

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
  const docs = state.docs.filter((d) => d.date === dateStr);
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
  dutyList: document.getElementById("dutyList"),
  docList: document.getElementById("docList"),
  eventList: document.getElementById("eventList"),
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
  renderSideLists();
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
      ...events.map((e) => ({ cls: "event", label: `${timeLabel(e)}${e.title}` })),
      ...duties.map((d) => ({ cls: "duty", label: `${timeLabel(d)}${d.person} ${d.type}` })),
      ...docs.map((d) => ({ cls: "doc", label: d.title })),
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
  const events = state.events.filter((e) => itemOverlapsMonth(e, y, m));
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

function renderSideLists() {
  const { viewYear: y, viewMonth: m } = state;

  const duties = state.duties.filter((d) => itemOverlapsMonth(d, y, m)).sort((a, b) => a.date.localeCompare(b.date) || byTime(a, b));
  els.dutyList.innerHTML = "";
  if (!duties.length) els.dutyList.innerHTML = `<div class="empty-note">등록된 복무가 없습니다.</div>`;
  duties.forEach((d) => {
    const item = document.createElement("div");
    item.className = "side-item";
    item.innerHTML = `
      <div class="si-top"><span>${escapeHtml(d.person)} · ${escapeHtml(d.role)}</span><span class="si-date">${dateLabel(d)}</span></div>
      <div class="si-meta">${escapeHtml(d.type)} · ${escapeHtml(d.title || "")}</div>`;
    item.addEventListener("click", () => openModal("duty", d.date, d));
    els.dutyList.appendChild(item);
  });

  const docsArr = state.docs.filter((d) => isInMonth(d.date, y, m)).sort((a, b) => a.date.localeCompare(b.date));
  els.docList.innerHTML = "";
  if (!docsArr.length) els.docList.innerHTML = `<div class="empty-note">등록된 공문이 없습니다.</div>`;
  docsArr.forEach((d) => {
    const item = document.createElement("div");
    item.className = `side-item status-${d.status}`;
    item.innerHTML = `
      <div class="si-top"><span>${escapeHtml(d.title)}</span><span class="si-date">${dateLabel(d)}</span></div>
      <div class="si-meta">${escapeHtml(d.sender || "")} · ${d.status === "done" ? "완료" : "처리중"}</div>`;
    item.addEventListener("click", () => openModal("doc", d.date, d));
    els.docList.appendChild(item);
  });

  const events = state.events.filter((e) => itemOverlapsMonth(e, y, m)).sort((a, b) => a.date.localeCompare(b.date) || byTime(a, b));
  els.eventList.innerHTML = "";
  if (!events.length) els.eventList.innerHTML = `<div class="empty-note">등록된 행사가 없습니다.</div>`;
  events.forEach((e) => {
    const item = document.createElement("div");
    item.className = "side-item";
    item.innerHTML = `
      <div class="si-top"><span>${escapeHtml(e.title)}</span><span class="si-date">${dateLabel(e)}</span></div>
      <div class="si-meta">${escapeHtml(e.memo || "")}</div>`;
    item.addEventListener("click", () => openModal("event", e.date, e));
    els.eventList.appendChild(item);
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

function openModal(type, dateStr, existing) {
  currentType = type;
  editingItem = existing || null;
  modalTitle.textContent = existing ? "일정 상세" : "일정 추가";

  tabBtns.forEach((b) => b.classList.toggle("active", b.dataset.type === type));
  tabBtns.forEach((b) => (b.disabled = !!existing));
  fieldGroups.forEach((g) => (g.hidden = g.dataset.fields !== type));
  const isDoc = type === "doc";
  fDocDateRow.hidden = !isDoc;
  fStartRow.hidden = isDoc;
  fEndRow.hidden = isDoc;

  fDocDate.value = existing?.date || dateStr || todayStr();
  fStart.value = toDatetimeLocal(existing?.date || dateStr || todayStr(), existing?.time || "09:00");
  fEnd.value = existing?.endDate ? toDatetimeLocal(existing.endDate, existing.endTime || "09:00") : "";

  document.getElementById("ev-title").value = "";
  document.getElementById("ev-memo").value = "";
  document.getElementById("du-person").value = localName || "";
  document.getElementById("du-role").value = "교사";
  document.getElementById("du-type").value = "출장";
  document.getElementById("du-title").value = "";
  document.getElementById("du-memo").value = "";
  document.getElementById("doc-title").value = "";
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
      document.getElementById("du-memo").value = existing.memo || "";
    } else if (type === "doc") {
      document.getElementById("doc-title").value = existing.title || "";
      document.getElementById("doc-sender").value = existing.sender || "";
      document.getElementById("doc-status").value = existing.status || "pending";
      document.getElementById("doc-memo").value = existing.memo || "";
    }
  }

  // 날짜/시간은 등록 후 수정 불가(단순화) — 새 항목으로 다시 등록 권장
  fDocDate.disabled = !!existing;
  fStart.disabled = !!existing;
  fEnd.disabled = !!existing;

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

function closeModal() {
  modalOverlay.hidden = true;
  editingItem = null;
}

tabBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    if (editingItem) return;
    currentType = btn.dataset.type;
    tabBtns.forEach((b) => b.classList.toggle("active", b === btn));
    fieldGroups.forEach((g) => (g.hidden = g.dataset.fields !== currentType));
    const isDoc = currentType === "doc";
    fDocDateRow.hidden = !isDoc;
    fStartRow.hidden = isDoc;
    fEndRow.hidden = isDoc;
    // 탭을 바꿔도 이미 고른 날짜는 유지
    if (isDoc) {
      fDocDate.value = splitDatetimeLocal(fStart.value).date || fDocDate.value || todayStr();
    } else if (!fStart.value) {
      fStart.value = toDatetimeLocal(fDocDate.value || todayStr(), "09:00");
    }
  });
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
      payload = {
        date, time, endDate, endTime,
        person,
        role: document.getElementById("du-role").value,
        type: document.getElementById("du-type").value,
        title: document.getElementById("du-title").value.trim(),
        memo: document.getElementById("du-memo").value.trim(),
      };
    }
  } else {
    const date = fDocDate.value;
    if (!date) return alert("날짜를 선택해주세요.");
    const title = document.getElementById("doc-title").value.trim();
    if (!title) return alert("공문 제목을 입력해주세요.");
    payload = {
      date,
      title,
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
      <button class="btn btn-sm" data-quick="doc">+공문</button>
    </div>`;

  const rows = [
    ...events.map((e) => ({ type: "event", cls: "event", label: `${timeLabel(e)}${e.title}`, item: e })),
    ...duties.map((d) => ({ type: "duty", cls: "duty", label: `${timeLabel(d)}${d.person}(${d.role}) ${d.type} - ${d.title || ""}`, item: d })),
    ...docs.map((d) => ({ type: "doc", cls: "doc", label: `${d.title} [${d.status === "done" ? "완료" : "처리중"}]`, item: d })),
  ];
  if (!rows.length) {
    html += `<div class="empty-note">등록된 일정이 없습니다.</div>`;
  } else {
    rows.forEach((r, i) => {
      html += `<div class="day-chip ${r.cls}" style="margin-bottom:4px;cursor:pointer;white-space:normal" data-row="${i}">${escapeHtml(r.label)}</div>`;
    });
  }

  dayPopover.innerHTML = html;
  dayPopover.style.top = `${rect.bottom + scrollY + 4}px`;
  dayPopover.style.left = `${Math.min(rect.left + scrollX, window.innerWidth - 280)}px`;
  dayPopover.hidden = false;

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
document.getElementById("printBtn").addEventListener("click", () => {
  buildPrintTable();
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
      .map((d2) => `<div class="print-item">${escapeHtml(timeLabel(d2))}${escapeHtml(d2.person)}(${escapeHtml(d2.role)}) ${escapeHtml(d2.type)}${d2.title ? ` - ${escapeHtml(d2.title)}` : ""}</div>`)
      .join("") || "";

    const tdDoc = document.createElement("td");
    tdDoc.className = "col-doc";
    tdDoc.innerHTML = docs
      .map((d3) => `<div class="print-item">${escapeHtml(d3.title)}${d3.sender ? ` (${escapeHtml(d3.sender)})` : ""} ${d3.status === "done" ? "[완료]" : "[처리중]"}</div>`)
      .join("") || "";

    tr.appendChild(tdDate);
    tr.appendChild(tdDay);
    tr.appendChild(tdEvent);
    tr.appendChild(tdDuty);
    tr.appendChild(tdDoc);
    tbody.appendChild(tr);
  }
}
