const TEAM_SIZE = 10;
const LAST_WEEK_MULTIPLIER = 0.5;
const STATE_ROW_ID = 1;
const LOCK_ROW_ID = 1;
const LOCK_TTL_SECONDS = 180;

const pickBtn = document.getElementById("pickBtn");
const resultCard = document.getElementById("resultCard");
const resultName = document.getElementById("resultName");
const skipPickBtn = document.getElementById("skipPickBtn");
const saveMeetingBtn = document.getElementById("saveMeetingBtn");
const cancelPickBtn = document.getElementById("cancelPickBtn");
const resetBtn = document.getElementById("resetBtn");
const debugBtn = document.getElementById("debugBtn");
const debugDialog = document.getElementById("debugDialog");
const debugCloseBtn = document.getElementById("debugCloseBtn");
const debugResetMeetingsBtn = document.getElementById("debugResetMeetingsBtn");
const debugResetOddsBtn = document.getElementById("debugResetOddsBtn");
const debugTrialsBtn = document.getElementById("debugTrialsBtn");
const debugTrialsResults = document.getElementById("debugTrialsResults");
const debugAddPickPerson = document.getElementById("debugAddPickPerson");
const debugAddPickDate = document.getElementById("debugAddPickDate");
const debugAddPickBtn = document.getElementById("debugAddPickBtn");
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
    meetings: [],
    oddsResetAt: null
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
    ),
    oddsResetAt: typeof input.oddsResetAt === "string" ? input.oddsResetAt : null
  };
}

function setStatus(text, type = "") {
  syncStatus.textContent = text;
  syncStatus.classList.remove("ok", "error", "warn");
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
  const cutoff = state.oddsResetAt ? new Date(state.oddsResetAt).getTime() : null;
  const meetingsForOdds =
    cutoff && !Number.isNaN(cutoff)
      ? meetingsSorted.filter((m) => new Date(m.date).getTime() >= cutoff)
      : meetingsSorted;

  for (const meeting of meetingsForOdds) {
    if (!statsById[meeting.personId]) continue;

    statsById[meeting.personId].picks += 1;
    statsById[meeting.personId].lastPickedAt = meeting.date;
  }

  const lastMeeting = meetingsForOdds.length ? meetingsForOdds[meetingsForOdds.length - 1] : null;
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
    setStatus("Another user is currently picking. Please wait for lock expiry or save.", "warn");
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
    setStatus("Another user currently holds the pick lock.", "warn");
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
  setStatus("Pick locked for 3 minutes while you confirm or cancel.", "warn");
});

skipPickBtn.addEventListener("click", () => {
  if (!pendingPick || !appState) return;
  if (!lockOwnedByThisClient(activeLock)) {
    setStatus("You no longer hold the lock. Start a new pick.", "error");
    return;
  }

  const derived = computeDerived(appState);
  const weightData = computeWeightData(appState, derived);
  pendingPick = weightedPick(appState, weightData);
  resultName.textContent = pendingPick.name;
  setStatus("Skipped and repicked. Skipped person is still in the mix.", "ok");
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

function openDebugDialog() {
  populateIrlPickControls();
  if (typeof debugDialog.showModal === "function") {
    debugDialog.showModal();
    return;
  }
  debugDialog.setAttribute("open", "");
}

function closeDebugDialog() {
  if (typeof debugDialog.close === "function") {
    debugDialog.close();
    return;
  }
  debugDialog.removeAttribute("open");
}

function toIsoFromLocalDate(localDateStr) {
  const [year, month, day] = localDateStr.split("-").map(Number);
  if (!year || !month || !day) return new Date().toISOString();
  const localNoon = new Date(year, month - 1, day, 12, 0, 0, 0);
  return localNoon.toISOString();
}

function populateIrlPickControls() {
  if (!debugAddPickPerson || !debugAddPickDate || !appState) return;

  debugAddPickPerson.innerHTML = appState.people
    .map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`)
    .join("");

  if (!debugAddPickDate.value) {
    debugAddPickDate.value = new Date().toISOString().slice(0, 10);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function runTrialSimulation(trialCount = 1000) {
  if (!debugTrialsResults) {
    setStatus("Debug results container is missing in HTML.", "error");
    return;
  }
  if (!appState) {
    debugTrialsResults.innerHTML = "<p>State not loaded yet. Wait for sync, then try again.</p>";
    debugTrialsResults.classList.remove("hidden");
    setStatus("State not loaded yet. Try again in a moment.", "error");
    return;
  }

  const derived = computeDerived(appState);
  const weightData = computeWeightData(appState, derived);
  const countsById = Object.fromEntries(appState.people.map((p) => [p.id, 0]));

  for (let i = 0; i < trialCount; i += 1) {
    const winner = weightedPick(appState, weightData);
    countsById[winner.id] += 1;
  }

  const maxCount = Math.max(...Object.values(countsById), 1);
  const rowsHtml = appState.people
    .map((person) => {
      const count = countsById[person.id];
      const observedPct = ((count / trialCount) * 100).toFixed(1);
      const expectedPct = ((weightData.oddsById[person.id] || 0) * 100).toFixed(1);
      const widthPct = (count / maxCount) * 100;

      return `
        <div class="trial-row">
          <div class="trial-row-head">
            <strong>${escapeHtml(person.name)}</strong>
            <span>${count} picks (${observedPct}%) · expected ${expectedPct}%</span>
          </div>
          <div class="trial-bar">
            <div class="trial-bar-fill" style="width: ${widthPct.toFixed(1)}%"></div>
          </div>
        </div>
      `;
    })
    .join("");

  debugTrialsResults.innerHTML = `
    <p><strong>1000-trial histogram</strong></p>
    ${rowsHtml}
  `;
  debugTrialsResults.classList.remove("hidden");
}

async function resetMeetingsList() {
  const confirmed = window.confirm("Reset list of meetings for everyone? Names will stay.");
  if (!confirmed || !appState) return;

  const nextState = structuredClone(appState);
  nextState.meetings = [];
  nextState.oddsResetAt = null;

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
    setStatus("Meeting list reset. Names preserved.", "ok");
    closeDebugDialog();
    render();
  } catch {
    setStatus("Could not reset meeting list. Check your Supabase config.", "error");
  }
}

async function resetOddsOnly() {
  const confirmed = window.confirm("Reset odds baseline for everyone while keeping meeting list?");
  if (!confirmed || !appState) return;

  const nextState = structuredClone(appState);
  nextState.oddsResetAt = new Date().toISOString();

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
    setStatus("Odds reset. Meeting list kept.", "ok");
    closeDebugDialog();
    render();
  } catch {
    setStatus("Could not reset odds. Check your Supabase config.", "error");
  }
}

async function addIrlPick() {
  if (!appState || !debugAddPickPerson || !debugAddPickDate) return;
  if (!debugAddPickPerson.value || !debugAddPickDate.value) {
    setStatus("Choose a member and date first.", "warn");
    return;
  }

  const nextState = structuredClone(appState);
  nextState.meetings.push({
    id: crypto.randomUUID(),
    personId: debugAddPickPerson.value,
    date: toIsoFromLocalDate(debugAddPickDate.value)
  });

  try {
    await saveStateToSupabase(nextState);
    if (pendingPick) {
      try {
        await releasePickLock();
      } catch {
        setStatus("IRL pick saved, but lock release failed. It will expire automatically.", "warn");
      }
    }
    pendingPick = null;
    resultCard.classList.add("hidden");
    setStatus("IRL pick added. Odds and history updated.", "ok");
    closeDebugDialog();
    render();
  } catch {
    setStatus("Could not add IRL pick. Check your Supabase config.", "error");
  }
}

debugBtn.addEventListener("click", openDebugDialog);
debugCloseBtn.addEventListener("click", closeDebugDialog);
debugResetMeetingsBtn.addEventListener("click", resetMeetingsList);
debugResetOddsBtn.addEventListener("click", resetOddsOnly);
if (debugTrialsBtn) {
  debugTrialsBtn.addEventListener("click", () => runTrialSimulation(1000));
}
if (debugAddPickBtn) {
  debugAddPickBtn.addEventListener("click", addIrlPick);
}

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
