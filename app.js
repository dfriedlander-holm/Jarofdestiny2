const STORAGE_KEY = "notetaker-rotator-v1";
const TEAM_SIZE = 10;
const LATE_PENALTY_MEETINGS = 2;
const LATE_MULTIPLIER = 0.35;
const LAST_WEEK_MULTIPLIER = 0.5;

const pickBtn = document.getElementById("pickBtn");
const resultCard = document.getElementById("resultCard");
const resultName = document.getElementById("resultName");
const lateCheckbox = document.getElementById("lateCheckbox");
const saveMeetingBtn = document.getElementById("saveMeetingBtn");
const resetBtn = document.getElementById("resetBtn");
const peopleList = document.getElementById("peopleList");
const historyList = document.getElementById("historyList");
const personTemplate = document.getElementById("personTemplate");
const meetingTemplate = document.getElementById("meetingTemplate");

let pendingPick = null;

function createInitialState() {
  return {
    people: Array.from({ length: TEAM_SIZE }, (_, i) => ({
      id: `p-${i + 1}`,
      name: `Person ${i + 1}`
    })),
    meetings: []
  };
}

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return createInitialState();

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.people) || !Array.isArray(parsed.meetings)) {
      return createInitialState();
    }

    const cleanedPeople = parsed.people
      .slice(0, TEAM_SIZE)
      .map((p, i) => ({
        id: typeof p.id === "string" ? p.id : `p-${i + 1}`,
        name: typeof p.name === "string" && p.name.trim() ? p.name.trim() : `Person ${i + 1}`
      }));

    while (cleanedPeople.length < TEAM_SIZE) {
      const idx = cleanedPeople.length;
      cleanedPeople.push({ id: `p-${idx + 1}`, name: `Person ${idx + 1}` });
    }

    return {
      people: cleanedPeople,
      meetings: parsed.meetings.filter(
        (m) =>
          m && typeof m.id === "string" && typeof m.personId === "string" && typeof m.date === "string"
      )
    };
  } catch {
    return createInitialState();
  }
}

function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric"
  });
}

function computeDerived(state) {
  const statsById = Object.fromEntries(
    state.people.map((p) => [p.id, { picks: 0, penaltyRemaining: 0, lastPickedAt: null }])
  );

  const meetingsSorted = [...state.meetings].sort((a, b) => new Date(a.date) - new Date(b.date));

  for (const meeting of meetingsSorted) {
    for (const personId of Object.keys(statsById)) {
      if (statsById[personId].penaltyRemaining > 0) {
        statsById[personId].penaltyRemaining -= 1;
      }
    }

    if (!statsById[meeting.personId]) continue;

    statsById[meeting.personId].picks += 1;
    statsById[meeting.personId].lastPickedAt = meeting.date;

    if (meeting.late) {
      statsById[meeting.personId].penaltyRemaining = LATE_PENALTY_MEETINGS;
    }
  }

  const lastMeeting = meetingsSorted.length ? meetingsSorted[meetingsSorted.length - 1] : null;
  return { statsById, lastMeeting };
}

function weightedPick(state, derived) {
  const weights = state.people.map((person) => {
    const stat = derived.statsById[person.id];
    if (!stat) return 1;

    let w = 1;

    if (derived.lastMeeting && derived.lastMeeting.personId === person.id) {
      w *= LAST_WEEK_MULTIPLIER;
    }

    if (stat.penaltyRemaining > 0) {
      w *= LATE_MULTIPLIER;
    }

    return w;
  });

  const total = weights.reduce((sum, w) => sum + w, 0);
  if (total <= 0) {
    return state.people[Math.floor(Math.random() * state.people.length)];
  }

  let roll = Math.random() * total;

  for (let i = 0; i < state.people.length; i += 1) {
    roll -= weights[i];
    if (roll <= 0) return state.people[i];
  }

  return state.people[state.people.length - 1];
}

function render() {
  const state = loadState();
  const derived = computeDerived(state);

  renderPeople(state, derived);
  renderHistory(state);
}

function renderPeople(state, derived) {
  peopleList.innerHTML = "";

  for (const person of state.people) {
    const li = personTemplate.content.firstElementChild.cloneNode(true);
    const nameInput = li.querySelector(".name-input");
    const pickCount = li.querySelector(".pick-count");
    const penalty = li.querySelector(".penalty");

    const stat = derived.statsById[person.id] || { picks: 0, penaltyRemaining: 0 };

    nameInput.value = person.name;
    nameInput.addEventListener("change", () => {
      const s = loadState();
      const target = s.people.find((p) => p.id === person.id);
      if (!target) return;
      target.name = nameInput.value.trim() || target.name;
      saveState(s);
      render();
    });

    pickCount.textContent = `Picked ${stat.picks}x`;
    penalty.textContent =
      stat.penaltyRemaining > 0
        ? `Penalty: ${stat.penaltyRemaining} week${stat.penaltyRemaining > 1 ? "s" : ""}`
        : "No penalty";
    penalty.classList.add(stat.penaltyRemaining > 0 ? "active" : "inactive");

    peopleList.appendChild(li);
  }
}

function renderHistory(state) {
  historyList.innerHTML = "";

  const meetingsNewestFirst = [...state.meetings].sort((a, b) => new Date(b.date) - new Date(a.date));
  if (!meetingsNewestFirst.length) {
    const li = document.createElement("li");
    li.className = "meeting-row";
    li.textContent = "No meetings yet. Pick a notetaker to start.";
    historyList.appendChild(li);
    return;
  }

  for (const meeting of meetingsNewestFirst) {
    const li = meetingTemplate.content.firstElementChild.cloneNode(true);
    const meetingName = li.querySelector(".meeting-name");
    const meetingDate = li.querySelector(".meeting-date");
    const meetingLate = li.querySelector(".meeting-late");
    const person = state.people.find((p) => p.id === meeting.personId);

    meetingName.textContent = person ? person.name : "Unknown person";
    meetingDate.textContent = formatDate(meeting.date);
    meetingLate.checked = Boolean(meeting.late);

    meetingLate.addEventListener("change", () => {
      const s = loadState();
      const target = s.meetings.find((m) => m.id === meeting.id);
      if (!target) return;
      target.late = meetingLate.checked;
      saveState(s);
      render();
    });

    historyList.appendChild(li);
  }
}

pickBtn.addEventListener("click", () => {
  const state = loadState();
  const derived = computeDerived(state);
  pendingPick = weightedPick(state, derived);

  resultName.textContent = pendingPick.name;
  lateCheckbox.checked = false;
  resultCard.classList.remove("hidden");
});

saveMeetingBtn.addEventListener("click", () => {
  if (!pendingPick) return;

  const state = loadState();
  const meeting = {
    id: crypto.randomUUID(),
    personId: pendingPick.id,
    date: new Date().toISOString(),
    late: lateCheckbox.checked
  };

  state.meetings.push(meeting);
  saveState(state);

  pendingPick = null;
  resultCard.classList.add("hidden");
  render();
});

resetBtn.addEventListener("click", () => {
  const confirmed = window.confirm("Reset people names and all meeting history?");
  if (!confirmed) return;
  saveState(createInitialState());
  pendingPick = null;
  resultCard.classList.add("hidden");
  render();
});

render();
