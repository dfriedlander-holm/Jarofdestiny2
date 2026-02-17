const TEAM_SIZE = 10;
const LAST_WEEK_MULTIPLIER = 0.5;
const STATE_ROW_ID = 1;
const LOCK_ROW_ID = 1;
const LOCK_TTL_SECONDS = 180;

const pickBtn = document.getElementById("pickBtn");
const resultCard = document.getElementById("resultCard");
const resultName = document.getElementById("resultName");
const saveMeetingBtn = document.getElementById("saveMeetingBtn");
const cancelPickBtn = document.getElementById("cancelPickBtn");
const resetBtn = document.getElementById("resetBtn");
const resetOddsBtn = document.getElementById("resetOddsBtn");
const peopleList = document.getElementById("peopleList");
const historyList = document.getElementById("historyList");
const personTemplate = document.getElementById("personTemplate");
const meetingTemplate = document.getElementById("meetingTemplate");
const syncStatus = document.getElementById("syncStatus");

const clientId = crypto.randomUUID();

let pendingPick = null;
let appState = null;
let supabaseClient = null;
let activeLock = null;

function createInitialState() {
  return {
    people: Array.from({ length: TEAM_SIZE }, (_, i) => ({
      id: `p-${i + 1}`,
      name: `Person ${i + 1}`
    })),
    meetings: []
  };
}

function sanitizeState(input) {
  if (!input || typeof input !== "object") return createInitialState();
  if (!Array.isArray(input.people) || !Array.isArray(input.meetings)) return createInitialState();

  const cleanedPeople = input.people.slice(0, TEAM_SIZE).map((p, i) => ({
    id: typeof p.id === "string" ? p.id : `p-${i + 1}`,
    name: typeof p.name === "string" && p.name.trim() ? p.name.trim() : `Person ${i + 1}`
  }));

  while (cleanedPeople.length < TEAM_SIZE) {
    const idx = cleanedPeople.length;
    cleanedPeople.push({ id: `p-${idx + 1}`, name: `Person ${idx + 1}` });
  }

  return {
    people: cleanedPeople,
    meetings: input.meetings.filter(
      (m) =>
        m &&
        typeof m.id === "string" &&
        typeof m.personId === "string" &&
        typeof m.date === "string"
    )
  };
}

function setStatus(text, type = "") {
  syncStatus.textContent = text;
  syncStatus.classList.remove("ok", "error");
  if (type) syncStatus.classList.add(type);
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

function isLockActive(lock) {
  if (!lock || !lock.expires_at) return false;
  return new Date(lock.expires_at).getTime() > Date.now();
}

function lockOwnedByThisClient(lock) {
  return Boolean(lock && lock.holder === clientId && isLockActive(lock));
}

function updatePickButtonState() {
  const blockedByOther = isLockActive(activeLock) && !lockOwnedByThisClient(activeLock);
  pickBtn.disabled = !appState || blockedByOther;

  if (blockedByOther) {
    pickBtn.textContent = "Pick Locked By Another User";
    return;
  }

  pickBtn.textContent = "Pick Notetaker";
}

function computeDerived(state) {
  const statsById = Object.fromEntries(
    state.people.map((p) => [p.id, { picks: 0, lastPickedAt: null }])
  );

  const meetingsSorted = [...state.meetings].sort((a, b) => new Date(a.date) - new Date(b.date));

  for (const meeting of meetingsSorted) {
    if (!statsById[meeting.personId]) continue;

    statsById[meeting.personId].picks += 1;
    statsById[meeting.personId].lastPickedAt = meeting.date;
  }

  const lastMeeting = meetingsSorted.length ? meetingsSorted[meetingsSorted.length - 1] : null;
  return { statsById, lastMeeting };
}

function computeWeightData(state, derived) {
  const weightsById = {};
  let total = 0;

  for (const person of state.people) {
    let weight = 1;

    if (derived.lastMeeting && derived.lastMeeting.personId === person.id) {
      weight *= LAST_WEEK_MULTIPLIER;
    }

    weightsById[person.id] = weight;
    total += weight;
  }

  const oddsById = {};
  for (const person of state.people) {
    oddsById[person.id] = total > 0 ? weightsById[person.id] / total : 1 / state.people.length;
  }

  return { weightsById, oddsById, totalWeight: total };
}

function weightedPick(state, weightData) {
  if (weightData.totalWeight <= 0) {
    return state.people[Math.floor(Math.random() * state.people.length)];
  }

  let roll = Math.random() * weightData.totalWeight;

  for (const person of state.people) {
    roll -= weightData.weightsById[person.id];
    if (roll <= 0) return person;
  }

  return state.people[state.people.length - 1];
}

async function loadStateFromSupabase() {
  const { data, error } = await supabaseClient
    .from("notetaker_state")
    .select("state")
    .eq("id", STATE_ROW_ID)
    .single();

  if (error) throw error;
  return sanitizeState(data.state);
}

async function ensureStateRowExists() {
  const { data, error } = await supabaseClient
    .from("notetaker_state")
    .select("id")
    .eq("id", STATE_ROW_ID)
    .maybeSingle();

  if (error) throw error;
  if (data) return;

  const { error: insertError } = await supabaseClient.from("notetaker_state").insert({
    id: STATE_ROW_ID,
    state: createInitialState()
  });

  if (insertError) throw insertError;
}

async function saveStateToSupabase(nextState) {
  const stateToSave = sanitizeState(nextState);
  const { error } = await supabaseClient.from("notetaker_state").upsert(
    {
      id: STATE_ROW_ID,
      state: stateToSave
    },
    { onConflict: "id" }
  );

  if (error) throw error;
  appState = stateToSave;
}

async function refreshLockStatus() {
  const { data, error } = await supabaseClient
    .from("notetaker_lock")
    .select("holder, expires_at")
    .eq("id", LOCK_ROW_ID)
    .maybeSingle();

  if (error) throw error;
  activeLock = data || null;
  updatePickButtonState();

  if (isLockActive(activeLock) && !lockOwnedByThisClient(activeLock)) {
    setStatus("Another user is currently picking. Please wait for lock expiry or save.", "error");
  }
}

async function acquirePickLock(personId) {
  const { data, error } = await supabaseClient.rpc("acquire_notetaker_lock", {
    p_holder: clientId,
    p_picked_person_id: personId,
    p_ttl_seconds: LOCK_TTL_SECONDS
  });

  if (error) throw error;
  const acquired = Boolean(data);
  if (acquired) {
    activeLock = {
      holder: clientId,
      expires_at: new Date(Date.now() + LOCK_TTL_SECONDS * 1000).toISOString()
    };
    updatePickButtonState();
  }

  return acquired;
}

async function releasePickLock() {
  const { error } = await supabaseClient.rpc("release_notetaker_lock", {
    p_holder: clientId
  });

  if (error) throw error;
  activeLock = null;
  updatePickButtonState();
}

function render() {
  if (!appState) return;

  const derived = computeDerived(appState);
  const weightData = computeWeightData(appState, derived);

  renderPeople(appState, derived, weightData);
  renderHistory(appState);
  updatePickButtonState();
}

function renderPeople(state, derived, weightData) {
  peopleList.innerHTML = "";

  for (const person of state.people) {
    const li = personTemplate.content.firstElementChild.cloneNode(true);
    const nameInput = li.querySelector(".name-input");
    const odds = li.querySelector(".odds");
    const pickCount = li.querySelector(".pick-count");

    const stat = derived.statsById[person.id] || { picks: 0 };
    const oddsPercent = (weightData.oddsById[person.id] * 100).toFixed(1);

    nameInput.value = person.name;
    nameInput.addEventListener("change", async () => {
      if (!appState) return;
      const nextState = structuredClone(appState);
      const target = nextState.people.find((p) => p.id === person.id);
      if (!target) return;
      target.name = nameInput.value.trim() || target.name;

      try {
        await saveStateToSupabase(nextState);
        setStatus("Synced shared state.", "ok");
        render();
      } catch {
        setStatus("Could not save name change. Check your Supabase config.", "error");
      }
    });

    odds.textContent = `Odds ${oddsPercent}%`;
    pickCount.textContent = `Picked ${stat.picks}x`;

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
    const person = state.people.find((p) => p.id === meeting.personId);

    meetingName.textContent = person ? person.name : "Unknown person";
    meetingDate.textContent = formatDate(meeting.date);

    historyList.appendChild(li);
  }
}

pickBtn.addEventListener("click", async () => {
  if (!appState) return;

  try {
    await refreshLockStatus();
  } catch {
    setStatus("Could not check lock status. Try again.", "error");
    return;
  }

  if (isLockActive(activeLock) && !lockOwnedByThisClient(activeLock)) {
    setStatus("Another user currently holds the pick lock.", "error");
    return;
  }

  const derived = computeDerived(appState);
  const weightData = computeWeightData(appState, derived);
  const chosenPerson = weightedPick(appState, weightData);

  try {
    const acquired = await acquirePickLock(chosenPerson.id);
    if (!acquired) {
      setStatus("Could not acquire lock. Please try again.", "error");
      return;
    }
  } catch {
    setStatus("Lock request failed. Check your Supabase setup.", "error");
    return;
  }

  pendingPick = chosenPerson;
  resultName.textContent = pendingPick.name;
  resultCard.classList.remove("hidden");
  setStatus("Pick locked for 3 minutes while you confirm or cancel.", "ok");
});

saveMeetingBtn.addEventListener("click", async () => {
  if (!pendingPick || !appState) return;

  const nextState = structuredClone(appState);
  nextState.meetings.push({
    id: crypto.randomUUID(),
    personId: pendingPick.id,
    date: new Date().toISOString()
  });

  try {
    await saveStateToSupabase(nextState);
    await releasePickLock();
    pendingPick = null;
    resultCard.classList.add("hidden");
    setStatus("Synced shared state.", "ok");
    render();
  } catch {
    setStatus("Could not save meeting. Check your Supabase config.", "error");
  }
});

cancelPickBtn.addEventListener("click", async () => {
  if (!pendingPick) return;

  try {
    await releasePickLock();
  } catch {
    setStatus("Could not release lock. It will expire automatically.", "error");
    return;
  }

  pendingPick = null;
  resultCard.classList.add("hidden");
  setStatus("Pick canceled and lock released.", "ok");
  render();
});

resetBtn.addEventListener("click", async () => {
  const confirmed = window.confirm("Reset people names and all meeting history for everyone?");
  if (!confirmed) return;

  try {
    await saveStateToSupabase(createInitialState());
    pendingPick = null;
    resultCard.classList.add("hidden");
    setStatus("Shared state reset.", "ok");
    render();
  } catch {
    setStatus("Could not reset shared state. Check your Supabase config.", "error");
  }
});

resetOddsBtn.addEventListener("click", async () => {
  const confirmed = window.confirm("Reset odds by clearing meeting history for everyone? Names will stay.");
  if (!confirmed || !appState) return;

  const nextState = structuredClone(appState);
  nextState.meetings = [];

  try {
    await saveStateToSupabase(nextState);
    if (pendingPick) {
      try {
        await releasePickLock();
      } catch {
        setStatus("Odds reset, but lock release failed. It will expire automatically.", "error");
      }
    }
    pendingPick = null;
    resultCard.classList.add("hidden");
    setStatus("Odds reset: meeting history cleared, names preserved.", "ok");
    render();
  } catch {
    setStatus("Could not reset odds. Check your Supabase config.", "error");
  }
});

async function initializeSharedState() {
  const config = window.APP_CONFIG || {};
  if (!config.SUPABASE_URL || !config.SUPABASE_ANON_KEY) {
    setStatus("Missing config.js values. Add your Supabase URL and anon key.", "error");
    return;
  }

  supabaseClient = window.supabase.createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY);

  try {
    await ensureStateRowExists();
    appState = await loadStateFromSupabase();
    await refreshLockStatus();
    setStatus("Connected. Shared state is live.", "ok");
    render();
  } catch {
    setStatus("Connection failed. Verify Supabase table, policies, and config.js.", "error");
    return;
  }

  supabaseClient
    .channel("notetaker-state-sync")
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "notetaker_state", filter: `id=eq.${STATE_ROW_ID}` },
      async () => {
        try {
          appState = await loadStateFromSupabase();
          if (!lockOwnedByThisClient(activeLock)) {
            pendingPick = null;
            resultCard.classList.add("hidden");
          }
          render();
        } catch {
          setStatus("Realtime update failed. Refresh the page.", "error");
        }
      }
    )
    .subscribe();

  supabaseClient
    .channel("notetaker-lock-sync")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "notetaker_lock", filter: `id=eq.${LOCK_ROW_ID}` },
      async () => {
        try {
          await refreshLockStatus();
          if (!lockOwnedByThisClient(activeLock)) {
            pendingPick = null;
            resultCard.classList.add("hidden");
          }
        } catch {
          setStatus("Lock sync failed. Refresh the page.", "error");
        }
      }
    )
    .subscribe();
}

initializeSharedState();
