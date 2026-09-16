/* ============================================================
   초등학교 교무부장 월중계획 대시보드
   - 데이터는 브라우저 localStorage 에 저장됩니다.
   - 행사 / 복무(출장·연수 등) / 공문 세 가지 항목을 날짜별로 관리하고
     달력 대시보드로 보여주며, 인쇄용 월중계획표를 출력합니다.
   ============================================================ */

const STORAGE_KEY = "schoolMonthlyPlanner.v1";

/** @typedef {{id:string, date:string, endDate?:string, title:string, memo?:string}} EventItem */
/** @typedef {{id:string, date:string, endDate?:string, person:string, role:string, type:string, title:string, memo?:string}} DutyItem */
/** @typedef {{id:string, date:string, title:string, sender:string, status:'pending'|'done', memo?:string}} DocItem */

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

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

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {
    console.warn("failed to load state", e);
  }
  const now = new Date();
  return {
    schoolName: "OO초등학교",
    viewYear: now.getFullYear(),
    viewMonth: now.getMonth() + 1, // 1-12
    events: [],
    duties: [],
    docs: [],
  };
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

let state = loadState();

// ------------- helpers to enumerate an item's date range -------------
function eachDateInRange(startStr, endStr) {
  const dates = [];
  let cur = parseDate(startStr);
  const end = endStr ? parseDate(endStr) : cur;
  while (cur <= end) {
    dates.push(formatDate(cur));
    cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1);
  }
  return dates;
}

function itemsForDate(dateStr) {
  const events = state.events.filter((e) => dateStr === e.date || (e.endDate && dateStr >= e.date && dateStr <= e.endDate));
  const duties = state.duties.filter((d) => dateStr === d.date || (d.endDate && dateStr >= d.date && dateStr <= d.endDate));
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
  els.schoolName.value = state.schoolName;
  populateYearMonthSelectors();
  els.calendarTitle.textContent = `${state.viewYear}년 ${state.viewMonth}월`;
  renderCalendar();
  renderSummary();
  renderSideLists();
  saveState();
}

function renderCalendar() {
  const { viewYear: y, viewMonth: m } = state;
  const grid = els.calendarGrid;
  grid.innerHTML = "";

  const firstOfMonth = new Date(y, m - 1, 1);
  const startWeekday = firstOfMonth.getDay(); // 0 = Sun
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
      ...events.map((e) => ({ cls: "event", label: e.title })),
      ...duties.map((d) => ({ cls: "duty", label: `${d.person} ${d.type}` })),
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
  if (item.endDate && item.endDate !== item.date) {
    return `${item.date.slice(5)} ~ ${item.endDate.slice(5)}`;
  }
  return item.date.slice(5);
}

function renderSideLists() {
  const { viewYear: y, viewMonth: m } = state;

  // duties
  const duties = state.duties
    .filter((d) => itemOverlapsMonth(d, y, m))
    .sort((a, b) => a.date.localeCompare(b.date));
  els.dutyList.innerHTML = "";
  if (!duties.length) {
    els.dutyList.innerHTML = `<div class="empty-note">등록된 복무가 없습니다.</div>`;
  }
  duties.forEach((d) => {
    const item = document.createElement("div");
    item.className = "side-item";
    item.innerHTML = `
      <div class="si-top"><span>${escapeHtml(d.person)} · ${escapeHtml(d.role)}</span><span class="si-date">${dateLabel(d)}</span></div>
      <div class="si-meta">${escapeHtml(d.type)} · ${escapeHtml(d.title || "")}</div>`;
    item.addEventListener("click", () => openModal("duty", d.date, d));
    els.dutyList.appendChild(item);
  });

  // docs
  const docs = state.docs
    .filter((d) => isInMonth(d.date, y, m))
    .sort((a, b) => a.date.localeCompare(b.date));
  els.docList.innerHTML = "";
  if (!docs.length) {
    els.docList.innerHTML = `<div class="empty-note">등록된 공문이 없습니다.</div>`;
  }
  docs.forEach((d) => {
    const item = document.createElement("div");
    item.className = `side-item status-${d.status}`;
    item.innerHTML = `
      <div class="si-top"><span>${escapeHtml(d.title)}</span><span class="si-date">${dateLabel(d)}</span></div>
      <div class="si-meta">${escapeHtml(d.sender || "")} · ${d.status === "done" ? "완료" : "처리중"}</div>`;
    item.addEventListener("click", () => openModal("doc", d.date, d));
    els.docList.appendChild(item);
  });

  // events
  const events = state.events
    .filter((e) => itemOverlapsMonth(e, y, m))
    .sort((a, b) => a.date.localeCompare(b.date));
  els.eventList.innerHTML = "";
  if (!events.length) {
    els.eventList.innerHTML = `<div class="empty-note">등록된 행사가 없습니다.</div>`;
  }
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

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ============================================================
// MODAL (add / edit)
// ============================================================

const modalOverlay = document.getElementById("modalOverlay");
const modalTitle = document.getElementById("modalTitle");
const tabBtns = document.querySelectorAll(".tab-btn");
const fieldGroups = document.querySelectorAll(".form-fields");
const fDate = document.getElementById("f-date");
const fEndDate = document.getElementById("f-endDate");
const fEndDateLabel = document.getElementById("f-endDateLabel");

let currentType = "event";
let editingId = null;

function openModal(type, dateStr, existing) {
  currentType = type;
  editingId = existing ? existing.id : null;
  modalTitle.textContent = existing ? "일정 수정" : "일정 추가";

  tabBtns.forEach((b) => b.classList.toggle("active", b.dataset.type === type));
  fieldGroups.forEach((g) => (g.hidden = g.dataset.fields !== type));
  const showEndDate = type === "event" || type === "duty";
  fEndDate.hidden = !showEndDate;
  fEndDateLabel.hidden = !showEndDate;

  fDate.value = dateStr || todayStr();
  fEndDate.value = existing?.endDate || "";

  document.getElementById("ev-title").value = "";
  document.getElementById("ev-memo").value = "";
  document.getElementById("du-person").value = "";
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

  document.getElementById("deleteBtn").hidden = !existing;
  modalOverlay.hidden = false;
  closeDayPopover();
}

function closeModal() {
  modalOverlay.hidden = true;
  editingId = null;
}

tabBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    if (editingId) return; // don't allow switching type while editing
    currentType = btn.dataset.type;
    tabBtns.forEach((b) => b.classList.toggle("active", b === btn));
    fieldGroups.forEach((g) => (g.hidden = g.dataset.fields !== currentType));
    const showEndDate = currentType === "event" || currentType === "duty";
    fEndDate.hidden = !showEndDate;
    fEndDateLabel.hidden = !showEndDate;
  });
});

document.getElementById("modalClose").addEventListener("click", closeModal);
document.getElementById("cancelBtn").addEventListener("click", closeModal);
modalOverlay.addEventListener("click", (e) => {
  if (e.target === modalOverlay) closeModal();
});

document.getElementById("saveBtn").addEventListener("click", () => {
  const date = fDate.value;
  if (!date) {
    alert("날짜를 선택해주세요.");
    return;
  }
  const endDate = fEndDate.hidden ? undefined : (fEndDate.value || undefined);

  if (currentType === "event") {
    const title = document.getElementById("ev-title").value.trim();
    if (!title) return alert("행사명을 입력해주세요.");
    const memo = document.getElementById("ev-memo").value.trim();
    upsert(state.events, { id: editingId || uid(), date, endDate, title, memo });
  } else if (currentType === "duty") {
    const person = document.getElementById("du-person").value.trim();
    if (!person) return alert("대상자를 입력해주세요.");
    const role = document.getElementById("du-role").value;
    const type = document.getElementById("du-type").value;
    const title = document.getElementById("du-title").value.trim();
    const memo = document.getElementById("du-memo").value.trim();
    upsert(state.duties, { id: editingId || uid(), date, endDate, person, role, type, title, memo });
  } else if (currentType === "doc") {
    const title = document.getElementById("doc-title").value.trim();
    if (!title) return alert("공문 제목을 입력해주세요.");
    const sender = document.getElementById("doc-sender").value.trim();
    const status = document.getElementById("doc-status").value;
    const memo = document.getElementById("doc-memo").value.trim();
    upsert(state.docs, { id: editingId || uid(), date, title, sender, status, memo });
  }

  closeModal();
  renderAll();
});

document.getElementById("deleteBtn").addEventListener("click", () => {
  if (!editingId) return;
  if (!confirm("이 항목을 삭제할까요?")) return;
  const arr = currentType === "event" ? state.events : currentType === "duty" ? state.duties : state.docs;
  const idx = arr.findIndex((x) => x.id === editingId);
  if (idx >= 0) arr.splice(idx, 1);
  closeModal();
  renderAll();
});

function upsert(arr, item) {
  const idx = arr.findIndex((x) => x.id === item.id);
  if (idx >= 0) arr[idx] = item;
  else arr.push(item);
}

// ============================================================
// DAY POPOVER (click a date to see all items + quick add)
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
    ...events.map((e) => ({ type: "event", cls: "event", label: e.title, item: e })),
    ...duties.map((d) => ({ type: "duty", cls: "duty", label: `${d.person}(${d.role}) ${d.type} - ${d.title || ""}`, item: d })),
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

// side-box "+ 추가" buttons
document.querySelectorAll("[data-add]").forEach((btn) => {
  btn.addEventListener("click", () => openModal(btn.dataset.add, todayStr()));
});

// ============================================================
// TOP TOOLBAR EVENTS
// ============================================================

document.getElementById("schoolName").addEventListener("input", (e) => {
  state.schoolName = e.target.value;
  saveState();
});

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

// ------------- export / import -------------
document.getElementById("exportBtn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `월중계획_백업_${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById("importBtn").addEventListener("click", () => {
  document.getElementById("importFile").click();
});
document.getElementById("importFile").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data || typeof data !== "object") throw new Error("invalid");
      state = {
        schoolName: data.schoolName || "OO초등학교",
        viewYear: data.viewYear || new Date().getFullYear(),
        viewMonth: data.viewMonth || new Date().getMonth() + 1,
        events: Array.isArray(data.events) ? data.events : [],
        duties: Array.isArray(data.duties) ? data.duties : [],
        docs: Array.isArray(data.docs) ? data.docs : [],
      };
      renderAll();
      alert("데이터를 불러왔습니다.");
    } catch (err) {
      alert("올바른 백업 파일이 아닙니다.");
    }
  };
  reader.readAsText(file);
  e.target.value = "";
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
    tdEvent.innerHTML = events.map((e) => `<div class="print-item">${escapeHtml(e.title)}${e.memo ? ` (${escapeHtml(e.memo)})` : ""}</div>`).join("") || "";

    const tdDuty = document.createElement("td");
    tdDuty.className = "col-duty";
    tdDuty.innerHTML = duties
      .map((d2) => `<div class="print-item">${escapeHtml(d2.person)}(${escapeHtml(d2.role)}) ${escapeHtml(d2.type)}${d2.title ? ` - ${escapeHtml(d2.title)}` : ""}</div>`)
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

// ============================================================
// INIT
// ============================================================
renderAll();
