const statusElement = document.querySelector("#status");
const statusPanelElement = document.querySelector("#status-panel");
const diagSourceElement = document.querySelector("#diag-source");
const diagAgeElement = document.querySelector("#diag-age");
const diagFetchElement = document.querySelector("#diag-fetch");
const diagChangedElement = document.querySelector("#diag-changed");
const diagMotionElement = document.querySelector("#diag-motion");
const clockElement = document.querySelector("#clock");
const countElement = document.querySelector("#vehicle-count");
const modeToggleElement = document.querySelector("#mode-toggle");
const viewToggleElement = document.querySelector("#view-toggle");
const viewPanelElement = document.querySelector("#view-panel");
const linesToggleElement = document.querySelector("#lines-toggle");
const lineFilterPanelElement = document.querySelector("#line-filter-panel");
const mapShellElement = document.querySelector(".map-shell");
const loadingScreenElement = document.querySelector("#loading-screen");
const loadingTextElement = document.querySelector("#loading-text");

const loadingControlElements = [
  viewToggleElement,
  linesToggleElement,
  modeToggleElement,
  statusElement,
].filter(Boolean);

function setLoadingControlsDisabled(disabled) {
  for (const element of loadingControlElements) {
    element.disabled = disabled;
    element.setAttribute("aria-disabled", String(disabled));
  }
}

const REFRESH_MS = 3000;
const DEFAULT_MOVE_MS = 14000;
const STOP_APPROACH_RADIUS_M = 48;
const STOP_RELEASE_DISTANCE_M = 24;
const STOP_DWELL_MS = 10000;

const DEFAULT_DISPLAY_MODE = "interactive";
const SERVER_BOOT_STORAGE_KEY = "cologne-tram-live-map-server-boot";
const KIOSK_CENTER = [50.95, 6.98];
const KIOSK_ZOOM = 11.9;

const VIEW_PRESETS = {
  koeln: { label: "Köln", center: KIOSK_CENTER, zoom: KIOSK_ZOOM },
  innenstadt: { label: "Innenstadt", center: [50.9382, 6.9598], zoom: 14.0 },
  rodenkirchen: { label: "Rodenkirchen", center: [50.8755, 6.9970], zoom: 12.8 },
  lindenthal: { label: "Lindenthal", center: [50.9255, 6.8890], zoom: 12.9 },
  ehrenfeld: { label: "Ehrenfeld", center: [50.9565, 6.9060], zoom: 13.2 },
  nippes: { label: "Nippes", center: [50.9870, 6.9490], zoom: 13.0 },
  chorweiler: { label: "Chorweiler", center: [51.0430, 6.8970], zoom: 12.3 },
  porz: { label: "Porz", center: [50.8920, 7.0710], zoom: 12.6 },
  kalk: { label: "Kalk", center: [50.9460, 7.0470], zoom: 13.0 },
  muelheim: { label: "Mülheim", center: [50.9840, 7.0350], zoom: 12.8 },
};
const MISSING_GRACE_MS = 45000;
const CONTINUITY_MAX_DISTANCE_M = 1200;
const SNAP_MAX_DISTANCE_M = 250;

// Keep the interactive map focused on Cologne. The geographic bounds are
// intentionally a little wider than the city itself so district presets and
// normal panning still feel natural, while preventing navigation far away.
const MAP_MAX_BOUNDS = [
  [50.76, 6.68],
  [51.15, 7.26],
];

const MOBILE_LAYOUT_QUERY = "(max-width: 760px), (pointer: coarse)";
const mobileLayoutMedia = window.matchMedia(MOBILE_LAYOUT_QUERY);

function isMobileLayout() {
  return mobileLayoutMedia.matches;
}

function responsiveZoomOffset(viewKey) {
  if (!isMobileLayout()) return 0;

  const portrait = window.innerHeight >= window.innerWidth;

  if (viewKey === "koeln") {
    return portrait ? -1.5 : -0.75;
  }

  return portrait ? -0.8 : -0.4;
}

function interactiveMinZoom() {
  // The current Cologne start view is also the furthest-out view. On mobile,
  // use the same responsive offset as the Cologne preset.
  return KIOSK_ZOOM + responsiveZoomOffset("koeln");
}

const FALLBACK_LINE_COLORS = {
  "1": "#d71920",
  "3": "#f28c00",
  "4": "#f2b600",
  "5": "#7a5543",
  "7": "#159447",
  "9": "#8e44ad",
  "12": "#1479d1",
  "13": "#0097a7",
  "15": "#d81b60",
  "16": "#005bbb",
  "17": "#43a047",
  "18": "#5e35b1",
};

const LINE_OFFSETS = {
  "1": -7,
  "3": -5,
  "4": 5,
  "5": -3,
  "7": 0,
  "9": 7,
  "12": -4,
  "13": 4,
  "15": 4,
  "16": -4,
  "17": 4,
  "18": 4,
};

const gtfsLineColors = new Map();
const networkPathsByLine = new Map();
const networkLayersByLine = new Map();
const networkStopsByLine = new Map();
const stationDwells = new Map();
const activeLines = new Set(Object.keys(FALLBACK_LINE_COLORS));


function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

const LOADING_MESSAGES = [
  {
    text: "lade Schienennetz…",
    rhythm: { base: 44, jitter: 22, wordPause: 42, punctuationPause: 210, hesitationChance: 0.05 },
  },
  {
    text: "sortiere Köln nach Linienfarben…",
    rhythm: { base: 34, jitter: 18, wordPause: 30, punctuationPause: 150, hesitationChance: 0.025 },
  },
  {
    text: "rücke Haltestellen ein paar Pixel zurecht…",
    rhythm: { base: 58, jitter: 30, wordPause: 65, punctuationPause: 240, hesitationChance: 0.075 },
  },
  {
    text: "stelle Bahnen aufs Gleis…",
    rhythm: { base: 39, jitter: 24, wordPause: 36, punctuationPause: 175, hesitationChance: 0.04 },
  },
  {
    text: "entwirre kurz die Innenstadt…",
    rhythm: { base: 49, jitter: 28, wordPause: 55, punctuationPause: 260, hesitationChance: 0.065 },
  },
];

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function renderLoadingText(text) {
  if (!loadingTextElement) return;

  loadingTextElement.textContent = "";

  const trimmed = text.replace(/\s+$/, "");
  const lastSpace = trimmed.lastIndexOf(" ");
  const tailStart = lastSpace >= 0 ? lastSpace + 1 : 0;

  if (tailStart > 0) {
    loadingTextElement.append(
      document.createTextNode(text.slice(0, tailStart))
    );
  }

  const tail = document.createElement("span");
  tail.className = "loading-tail";
  tail.append(document.createTextNode(text.slice(tailStart)));

  const cursor = document.createElement("span");
  cursor.className = "loading-cursor";
  cursor.textContent = "_";
  tail.append(cursor);

  loadingTextElement.append(tail);
}

async function typeLoadingMessage(
  message,
  rhythm = {
    base: 44,
    jitter: 22,
    wordPause: 42,
    punctuationPause: 190,
    hesitationChance: 0.045,
  }
) {
  if (!loadingTextElement) return;

  let typed = "";
  renderLoadingText(typed);

  for (let index = 0; index < message.length; index += 1) {
    const character = message[index];
    typed += character;
    renderLoadingText(typed);

    let delay = rhythm.base + randomBetween(-rhythm.jitter, rhythm.jitter);

    // People tend to hit spaces quickly, then briefly pause before the next word.
    if (character === " ") {
      delay = randomBetween(16, 34) + rhythm.wordPause;
    }

    // Natural phrase-ending pause.
    if (".,;:…".includes(character)) {
      delay += rhythm.punctuationPause + randomBetween(35, 120);
    }

    // Very short bursts make the cadence feel less metronomic.
    if (index > 0 && index % 4 === 0 && Math.random() < 0.5) {
      delay *= randomBetween(0.58, 0.82);
    }

    // Occasional tiny hesitation, like someone searching for the next keys.
    if (
      character !== " " &&
      !".,;:…".includes(character) &&
      Math.random() < rhythm.hesitationChance
    ) {
      delay += randomBetween(90, 230);
    }

    await sleep(Math.max(14, delay));
  }
}

async function runLoadingSequence() {
  for (const item of LOADING_MESSAGES) {
    await sleep(randomBetween(120, 360));
    await typeLoadingMessage(item.text, item.rhythm);
    await sleep(randomBetween(1350, 2300));
  }
}

async function revealMap() {
  await typeLoadingMessage(
    "fertig. gute fahrt.",
    {
      base: 52,
      jitter: 26,
      wordPause: 72,
      punctuationPause: 300,
      hesitationChance: 0.055,
    }
  );
  await sleep(950);

  mapShellElement.classList.remove("is-loading");
  mapShellElement.classList.add("is-ready");

  await sleep(420);

  if (loadingScreenElement) {
    loadingScreenElement.hidden = true;
  }

  setLoadingControlsDisabled(false);
}

function lineColor(line) {
  return gtfsLineColors.get(String(line))
    || FALLBACK_LINE_COLORS[String(line)]
    || "#d9252a";
}

function lineOffset(line) {
  return LINE_OFFSETS[String(line)] || 0;
}

let displayMode = DEFAULT_DISPLAY_MODE;

let currentViewKey = "koeln";

function applyViewPreset(key, animate = true) {
  const preset = VIEW_PRESETS[key] || VIEW_PRESETS.koeln;
  currentViewKey = key in VIEW_PRESETS ? key : "koeln";
  viewToggleElement.textContent = preset.label;

  if (preset.bounds) {
    map.fitBounds(preset.bounds, {
      padding: [34, 34],
      maxZoom: 15.2,
      animate,
    });
  } else {
    map.setView(
      preset.center,
      preset.zoom + responsiveZoomOffset(currentViewKey),
      { animate }
    );
  }
}

const map = L.map("map", {
  zoomControl: true,
  attributionControl: true,
  preferCanvas: true,
  zoomSnap: 0.1,
  minZoom: interactiveMinZoom(),
  maxBounds: MAP_MAX_BOUNDS,
  maxBoundsViscosity: 1.0,
}).setView(KIOSK_CENTER, KIOSK_ZOOM);

map.createPane("routeCasingPane");
map.getPane("routeCasingPane").style.zIndex = 340;
map.getPane("routeCasingPane").style.pointerEvents = "none";

map.createPane("routeGlowPane");
map.getPane("routeGlowPane").style.zIndex = 345;
map.getPane("routeGlowPane").style.pointerEvents = "none";

map.createPane("routePane");
map.getPane("routePane").style.zIndex = 350;
map.getPane("routePane").style.pointerEvents = "none";

map.createPane("stopPane");
map.getPane("stopPane").style.zIndex = 360;
map.getPane("stopPane").style.pointerEvents = "none";

let baseLayer;

if (typeof L.maplibreGL === "function") {
  baseLayer = L.maplibreGL({
    style: "https://tiles.openfreemap.org/styles/positron",
  }).addTo(map);

  document.getElementById("map").classList.add("minimal-basemap");

  const glMap = baseLayer.getMaplibreMap();

  glMap.on("load", () => {
    const layers = (glMap.getStyle() && glMap.getStyle().layers) || [];

    for (const layer of layers) {
      if (layer.type !== "symbol") continue;

      const id = String(layer.id || "").toLowerCase();

      const isRoadLabel =
        /road|street|highway|motorway|trunk|route|shield|ref|transportation|junction/.test(id);

      const isPlaceLabel =
        /place|city|town|village|suburb|neighbourhood|neighborhood|locality/.test(id);

      if (isRoadLabel && !isPlaceLabel) {
        try {
          glMap.setLayoutProperty(layer.id, "visibility", "none");
        } catch (error) {
          // Some style layers may not expose the property; skip them quietly.
        }
      }
    }
  });
} else {
  baseLayer = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    updateWhenIdle: false,
    keepBuffer: 3,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a> · ODbL',
  }).addTo(map);

  console.warn("MapLibre unavailable; using OpenStreetMap fallback.");
}

const markers = new Map();
const motions = new Map();
const stopMarkers = [];
const vehicleMeta = new Map();
const jidToStableKey = new Map();

let lastVehiclePayload = null;
let vehicleRequestInFlight = false;
let vehicleRequestStartedAt = 0;
let lastVehicleLoadFailed = false;
let syncIndicatorTimer = null;

function snapshotAgeSeconds() {
  const updatedAt = lastVehiclePayload && lastVehiclePayload.updated_at;
  if (!updatedAt) return null;

  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp)) return null;

  return Math.max(0, (Date.now() - timestamp) / 1000);
}

function compactSeconds(value) {
  if (!Number.isFinite(value)) return "–";
  if (value < 10) return value.toFixed(1) + "s";
  return Math.round(value) + "s";
}

function updateDiagnosticsPanel() {
  if (!lastVehiclePayload) return;

  const diagnostics = lastVehiclePayload.diagnostics || {};
  const age = snapshotAgeSeconds();

  if (diagSourceElement) {
    diagSourceElement.textContent = lastVehiclePayload.cache_hit
      ? "cache"
      : "HAFAS";
  }

  if (diagAgeElement) {
    diagAgeElement.textContent = compactSeconds(age);
  }

  if (diagFetchElement) {
    const duration = diagnostics.last_fetch_duration_ms;
    diagFetchElement.textContent = Number.isFinite(duration)
      ? duration + " ms"
      : "–";
  }

  if (diagChangedElement) {
    const changed = diagnostics.changed_vehicle_count;
    const matched = diagnostics.matched_vehicle_count;
    diagChangedElement.textContent =
      Number.isFinite(changed) && Number.isFinite(matched)
        ? changed + " / " + matched
        : "–";
  }

  if (diagMotionElement) {
    diagMotionElement.textContent =
      motions.size + " / " + markers.size;
  }
}

function updateLiveStatus() {
  if (lastVehicleLoadFailed) {
    statusElement.innerHTML =
      '<span class="live-dot"></span>' +
      '<span>OFFLINE</span>';
    statusElement.dataset.state = "offline";
    updateDiagnosticsPanel();
    return;
  }

  const age = snapshotAgeSeconds();
  const requestAge = performance.now() - vehicleRequestStartedAt;
  const syncing = vehicleRequestInFlight && requestAge >= 350;
  const globallyWaiting =
    markers.size >= 5 &&
    motions.size === 0 &&
    !syncing &&
    Number.isFinite(age) &&
    age >= 3;

  let state = "live";
  let label = "LIVE";

  if (syncing) {
    state = "sync";
    label = "SYNC";
  } else if (globallyWaiting) {
    state = "wait";
    label = "WAIT";
  }

  const ageText = Number.isFinite(age)
    ? '<span class="status-separator">·</span>' +
      '<span class="status-time">' + compactSeconds(age) + '</span>'
    : "";

  statusElement.innerHTML =
    '<span class="live-dot"></span>' +
    '<span>' + label + '</span>' +
    ageText;
  statusElement.dataset.state = state;

  updateDiagnosticsPanel();
}

statusElement.addEventListener("click", (event) => {
  event.stopPropagation();
  const open = statusPanelElement.hidden;
  statusPanelElement.hidden = !open;
  statusElement.setAttribute("aria-expanded", String(open));
  updateDiagnosticsPanel();
});

document.addEventListener("click", (event) => {
  if (
    !statusPanelElement.hidden &&
    !event.target.closest(".status-monitor")
  ) {
    statusPanelElement.hidden = true;
    statusElement.setAttribute("aria-expanded", "false");
  }
});

function setMapInteractions(enabled) {
  const handlers = [
    map.dragging,
    map.scrollWheelZoom,
    map.doubleClickZoom,
    map.boxZoom,
    map.keyboard,
    map.touchZoom,
  ];

  for (const handler of handlers) {
    if (!handler) continue;
    if (enabled) {
      handler.enable();
    } else {
      handler.disable();
    }
  }

  const zoomControl = map.zoomControl && map.zoomControl.getContainer();
  if (zoomControl) {
    zoomControl.style.display = enabled ? "" : "none";
  }
}

function updateModeToggle() {
  const isKiosk = displayMode === "kiosk";
  modeToggleElement.textContent = isMobileLayout()
    ? (isKiosk ? "kiosk" : "free")
    : (isKiosk ? "kiosk: on" : "kiosk: off");
  modeToggleElement.setAttribute("aria-pressed", String(isKiosk));
  modeToggleElement.dataset.mode = displayMode;
  document.body.classList.toggle("kiosk-mode", isKiosk);
}

function applyDisplayMode(mode, resetView = true) {
  displayMode = mode === "interactive" ? "interactive" : "kiosk";
  const isKiosk = displayMode === "kiosk";
  setMapInteractions(!isKiosk);
  updateModeToggle();

  if (isKiosk && resetView) {
    applyViewPreset(currentViewKey, true);
  }

  updateVehicleScale();
}

modeToggleElement.addEventListener("click", () => {
  applyDisplayMode(
    displayMode === "kiosk" ? "interactive" : "kiosk",
    true
  );
});

function buildViewPicker() {
  viewPanelElement.innerHTML = "";

  for (const [key, preset] of Object.entries(VIEW_PRESETS)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "view-option";
    button.dataset.view = key;
    button.textContent = preset.label;

    button.addEventListener("click", () => {
      applyViewPreset(key, true);
      viewPanelElement.hidden = true;
      viewToggleElement.setAttribute("aria-expanded", "false");
      updateViewPickerState();
    });

    viewPanelElement.appendChild(button);
  }

  updateViewPickerState();
}

function updateViewPickerState() {
  for (const option of viewPanelElement.querySelectorAll(".view-option")) {
    option.dataset.active = String(option.dataset.view === currentViewKey);
  }
}

viewToggleElement.addEventListener("click", () => {
  const open = viewPanelElement.hidden;
  viewPanelElement.hidden = !open;
  viewToggleElement.setAttribute("aria-expanded", String(open));
});

function setLineVisibility(line, visible) {
  const layers = networkLayersByLine.get(String(line)) || [];

  for (const layer of layers) {
    if (visible) {
      if (!map.hasLayer(layer)) layer.addTo(map);
    } else if (map.hasLayer(layer)) {
      map.removeLayer(layer);
    }
  }

  for (const [stableKey, marker] of markers) {
    const meta = vehicleMeta.get(stableKey);
    if (!meta || String(meta.line) !== String(line)) continue;

    marker.setOpacity(visible ? 1 : 0);
  }
}

function updateLineFilterLabel() {
  linesToggleElement.textContent =
    activeLines.size === Object.keys(FALLBACK_LINE_COLORS).length
      ? "lines"
      : "lines " + activeLines.size;
}

function setAllLines(visible) {
  for (const line of Object.keys(FALLBACK_LINE_COLORS)) {
    if (visible) {
      activeLines.add(line);
    } else {
      activeLines.delete(line);
    }

    setLineVisibility(line, visible);
  }

  for (const chip of lineFilterPanelElement.querySelectorAll(".line-chip")) {
    chip.dataset.active = String(visible);
  }

  updateLineFilterLabel();
}

function buildLineFilter() {
  lineFilterPanelElement.innerHTML = "";

  const actions = document.createElement("div");
  actions.className = "line-filter-actions";

  const allButton = document.createElement("button");
  allButton.type = "button";
  allButton.className = "line-filter-action";
  allButton.textContent = "all";
  allButton.addEventListener("click", () => setAllLines(true));

  const noneButton = document.createElement("button");
  noneButton.type = "button";
  noneButton.className = "line-filter-action";
  noneButton.textContent = "none";
  noneButton.addEventListener("click", () => setAllLines(false));

  actions.append(allButton, noneButton);
  lineFilterPanelElement.appendChild(actions);

  const chipGrid = document.createElement("div");
  chipGrid.className = "line-chip-grid";

  for (const line of Object.keys(FALLBACK_LINE_COLORS)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "line-chip";
    button.dataset.line = line;
    button.dataset.active = "true";
    button.style.setProperty("--chip-color", lineColor(line));
    button.textContent = line;

    button.addEventListener("click", () => {
      const active = activeLines.has(line);

      if (active) {
        activeLines.delete(line);
      } else {
        activeLines.add(line);
      }

      button.dataset.active = String(!active);
      setLineVisibility(line, !active);
      updateLineFilterLabel();
    });

    chipGrid.appendChild(button);
  }

  lineFilterPanelElement.appendChild(chipGrid);
  updateLineFilterLabel();
}

linesToggleElement.addEventListener("click", () => {
  const open = lineFilterPanelElement.hidden;
  lineFilterPanelElement.hidden = !open;
  linesToggleElement.setAttribute("aria-expanded", String(open));
});

document.addEventListener("click", (event) => {
  if (
    !lineFilterPanelElement.hidden &&
    !event.target.closest(".line-filter")
  ) {
    lineFilterPanelElement.hidden = true;
    linesToggleElement.setAttribute("aria-expanded", "false");
  }

  if (
    !viewPanelElement.hidden &&
    !event.target.closest(".view-picker")
  ) {
    viewPanelElement.hidden = true;
    viewToggleElement.setAttribute("aria-expanded", "false");
  }
});

function updateResponsiveLayout({ resetView = true } = {}) {
  const mobile = isMobileLayout();

  document.body.classList.toggle("mobile-mode", mobile);
  document.documentElement.dataset.layout = mobile ? "mobile" : "desktop";

  updateModeToggle();

  // Keep the zoom-out limit aligned with the responsive Cologne start view.
  map.setMinZoom(interactiveMinZoom());

  window.requestAnimationFrame(() => {
    map.invalidateSize({ pan: false });

    if (resetView && displayMode === "kiosk") {
      applyViewPreset(currentViewKey, false);
    }

    updateVehicleScale();
    realignVehiclesToCurrentZoom();
  });
}

mobileLayoutMedia.addEventListener?.("change", () => {
  updateResponsiveLayout({ resetView: true });
});

window.addEventListener("orientationchange", () => {
  window.setTimeout(
    () => updateResponsiveLayout({ resetView: true }),
    180
  );
});

let resizeTimer = null;
window.addEventListener("resize", () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(
    () => updateResponsiveLayout({ resetView: true }),
    140
  );
});

function updateClock() {
  clockElement.textContent = new Intl.DateTimeFormat("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date());
}

function formatTime(isoString) {
  if (!isoString) return "--:--:--";

  return new Intl.DateTimeFormat("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(isoString));
}

function normalizeDirection(direction) {
  return (direction || "").trim().toLowerCase();
}

function delayLabel(vehicle) {
  if (vehicle.delay_status === "on_time") return "on time";
  if (vehicle.delay_status === "slightly_delayed") return "slightly delayed";
  if (vehicle.delay_status === "highly_delayed") return "highly delayed";
  return "delay unknown";
}

function delayText(vehicle) {
  if (vehicle.delay_minutes === null || vehicle.delay_minutes === undefined) {
    return delayLabel(vehicle);
  }

  const rounded = Math.round(vehicle.delay_minutes);
  const prefix = rounded > 0 ? "+" : "";
  return delayLabel(vehicle) + " · " + prefix + rounded + " min";
}

function vehicleIcon(line, delayStatus = "unknown") {
  const safeLine = String(line).replace(/[^0-9A-Za-z]/g, "");
  const color = lineColor(line);
  const safeDelayStatus = [
    "on_time",
    "slightly_delayed",
    "highly_delayed",
  ].includes(delayStatus)
    ? delayStatus
    : "unknown";

  return L.divIcon({
    className: "vehicle-marker-wrapper",
    html:
      '<div class="tram-marker" style="--line-color:' + color + '">' +
        '<div class="tram-scale">' +
          '<div class="tram-heading">' +
            '<div class="direction-tip"></div>' +
          '</div>' +
          '<div class="line-badge delay-ring-' + safeDelayStatus + '">' +
            safeLine +
          '</div>' +
        '</div>' +
      '</div>',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -16],
  });
}

function bearingBetween(a, b) {
  const lat1 = a.lat * Math.PI / 180;
  const lat2 = b.lat * Math.PI / 180;
  const dLon = (b.lng - a.lng) * Math.PI / 180;

  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);

  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function setMarkerBearing(marker, bearing) {
  if (!Number.isFinite(bearing)) return;
  marker._tramBearing = bearing;

  const element = marker.getElement();
  if (!element) return;

  const heading = element.querySelector(".tram-heading");
  if (!heading) return;

  heading.style.setProperty("--bearing", bearing + "deg");
  heading.classList.add("has-bearing");
}

function chooseStableKey(vehicle, usedStableKeys, now) {
  const direct = jidToStableKey.get(vehicle.journey_id);

  if (direct && markers.has(direct) && !usedStableKeys.has(direct)) {
    return direct;
  }

  const target = L.latLng(vehicle.latitude, vehicle.longitude);
  const direction = normalizeDirection(vehicle.direction);

  let bestKey = null;
  let bestDistance = Infinity;

  for (const [stableKey, meta] of vehicleMeta) {
    if (usedStableKeys.has(stableKey)) continue;
    if (String(meta.line) !== String(vehicle.line)) continue;
    if (now - meta.lastSeen > MISSING_GRACE_MS) continue;

    const oldDirection = normalizeDirection(meta.direction);
    if (direction && oldDirection && direction !== oldDirection) continue;

    const marker = markers.get(stableKey);
    if (!marker) continue;

    const distance = marker.getLatLng().distanceTo(target);
    if (distance > CONTINUITY_MAX_DISTANCE_M) continue;

    if (distance < bestDistance) {
      bestDistance = distance;
      bestKey = stableKey;
    }
  }

  return bestKey || vehicle.journey_id;
}

function nearestPointOnSegment(point, a, b) {
  const ab = b.subtract(a);
  const ap = point.subtract(a);
  const denominator = ab.x * ab.x + ab.y * ab.y;

  if (denominator === 0) return a;

  const t = Math.max(
    0,
    Math.min(
      1,
      (ap.x * ab.x + ap.y * ab.y) / denominator
    )
  );

  return L.point(
    a.x + ab.x * t,
    a.y + ab.y * t
  );
}

function nearestPointOnPaths(rawLatLng, paths) {
  if (!paths || paths.length === 0) {
    return null;
  }

  const projectionZoom = 18;
  const rawPoint = map.project(rawLatLng, projectionZoom);

  let bestPoint = null;
  let bestPixelDistance = Infinity;

  for (const path of paths) {
    if (!path || path.length < 2) continue;

    for (let i = 1; i < path.length; i += 1) {
      const a = map.project(L.latLng(path[i - 1]), projectionZoom);
      const b = map.project(L.latLng(path[i]), projectionZoom);
      const candidate = nearestPointOnSegment(rawPoint, a, b);
      const distance = rawPoint.distanceTo(candidate);

      if (distance < bestPixelDistance) {
        bestPixelDistance = distance;
        bestPoint = candidate;
      }
    }
  }

  if (!bestPoint) {
    return null;
  }

  const snapped = map.unproject(bestPoint, projectionZoom);

  let bestSegmentStart = null;
  let bestSegmentEnd = null;
  let searchDistance = Infinity;

  for (const path of paths) {
    if (!path || path.length < 2) continue;

    for (let i = 1; i < path.length; i += 1) {
      const aLatLng = L.latLng(path[i - 1]);
      const bLatLng = L.latLng(path[i]);
      const a = map.project(aLatLng, projectionZoom);
      const b = map.project(bLatLng, projectionZoom);
      const candidate = nearestPointOnSegment(rawPoint, a, b);
      const distance = rawPoint.distanceTo(candidate);

      if (distance < searchDistance) {
        searchDistance = distance;
        bestSegmentStart = aLatLng;
        bestSegmentEnd = bLatLng;
      }
    }
  }

  return {
    point: snapped,
    distance: rawLatLng.distanceTo(snapped),
    segmentStart: bestSegmentStart,
    segmentEnd: bestSegmentEnd,
  };
}

function applyLineOffset(point, segmentStart, segmentEnd, line) {
  const offset = lineOffset(line);

  if (
    !offset ||
    !segmentStart ||
    !segmentEnd
  ) {
    return point;
  }

  const pointPx = map.latLngToLayerPoint(point);
  const startPx = map.latLngToLayerPoint(segmentStart);
  const endPx = map.latLngToLayerPoint(segmentEnd);

  const dx = endPx.x - startPx.x;
  const dy = endPx.y - startPx.y;
  const length = Math.sqrt(dx * dx + dy * dy);

  if (length < 0.01) {
    return point;
  }

  const perpendicularX = -dy / length;
  const perpendicularY = dx / length;

  return map.layerPointToLatLng(
    L.point(
      pointPx.x + perpendicularX * offset,
      pointPx.y + perpendicularY * offset
    )
  );
}

function snapVehicleToNetwork(vehicle) {
  const raw = L.latLng(vehicle.latitude, vehicle.longitude);
  const paths = networkPathsByLine.get(String(vehicle.line));
  const nearest = nearestPointOnPaths(raw, paths);

  if (!nearest || nearest.distance > SNAP_MAX_DISTANCE_M) {
    return raw;
  }

  return applyLineOffset(
    nearest.point,
    nearest.segmentStart,
    nearest.segmentEnd,
    vehicle.line
  );
}

function snapLatLngToLine(rawLatLng, line) {
  const paths = networkPathsByLine.get(String(line));
  const nearest = nearestPointOnPaths(rawLatLng, paths);

  if (!nearest || nearest.distance > SNAP_MAX_DISTANCE_M) {
    return rawLatLng;
  }

  return applyLineOffset(
    nearest.point,
    nearest.segmentStart,
    nearest.segmentEnd,
    line
  );
}


function nearestStopForLine(point, line, maxDistance = STOP_APPROACH_RADIUS_M) {
  const stops = networkStopsByLine.get(String(line)) || [];
  let best = null;
  let bestDistance = Infinity;

  for (const stop of stops) {
    const distance = point.distanceTo(stop.point);
    if (distance <= maxDistance && distance < bestDistance) {
      best = stop;
      bestDistance = distance;
    }
  }

  return best ? { ...best, distance: bestDistance } : null;
}

function stationMotionProgress(raw, mode) {
  if (mode === "approach" && raw > 0.62) {
    const local = (raw - 0.62) / 0.38;
    const eased = 1 - Math.pow(1 - local, 2.2);
    return 0.62 + 0.38 * eased;
  }

  if (mode === "depart" && raw < 0.28) {
    const local = raw / 0.28;
    return 0.28 * Math.pow(local, 1.8);
  }

  return raw;
}

function drawStops(stops) {
  for (const marker of stopMarkers) {
    map.removeLayer(marker);
  }
  stopMarkers.length = 0;

  const allPaths = Array.from(networkPathsByLine.values()).flat();

  for (const stop of stops || []) {
    const raw = L.latLng(stop.latitude, stop.longitude);
    const nearest = nearestPointOnPaths(raw, allPaths);
    const position =
      nearest && nearest.distance <= 160
        ? nearest.point
        : raw;

    const marker = L.circleMarker(
      position,
      {
        pane: "stopPane",
        radius: 2.2,
        weight: 1,
        color: "#2f363a",
        opacity: 0.68,
        fillColor: "#fbfaf5",
        fillOpacity: 0.95,
        interactive: false,
      }
    ).addTo(map);

    stopMarkers.push(marker);
  }
}

function drawStaticNetwork(network) {
  const stopsById = new Map(
    (network.stops || []).map((stop) => [String(stop.id), stop])
  );

  for (const lineData of network.lines || []) {
    const line = String(lineData.line);
    const color = lineData.color || FALLBACK_LINE_COLORS[line] || "#d9252a";

    gtfsLineColors.set(line, color);
    networkPathsByLine.set(line, lineData.paths || []);

    const lineStops = [];
    for (const stopId of lineData.stop_ids || []) {
      const stop = stopsById.get(String(stopId));
      if (!stop) continue;

      const raw = L.latLng(stop.latitude, stop.longitude);
      const nearest = nearestPointOnPaths(raw, lineData.paths || []);
      let point = raw;

      if (nearest && nearest.distance <= 160) {
        point = applyLineOffset(
          nearest.point,
          nearest.segmentStart,
          nearest.segmentEnd,
          line
        );
      }

      lineStops.push({
        id: String(stop.id),
        name: stop.name,
        point,
      });
    }
    networkStopsByLine.set(line, lineStops);

    const offset = lineOffset(line);

    for (const path of lineData.paths || []) {
      if (!path || path.length < 2) continue;

      const casing = L.polyline(path, {
        pane: "routeCasingPane",
        color: "#ffffff",
        weight: 3.4,
        opacity: 0.12,
        lineCap: "round",
        lineJoin: "round",
        interactive: false,
        smoothFactor: 0,
        offset,
      });

      const glow = L.polyline(path, {
        pane: "routeGlowPane",
        color,
        weight: 5,
        opacity: 0.07,
        lineCap: "round",
        lineJoin: "round",
        interactive: false,
        smoothFactor: 0,
        offset,
      });

      const core = L.polyline(path, {
        pane: "routePane",
        color,
        weight: 2.2,
        opacity: 0.54,
        lineCap: "round",
        lineJoin: "round",
        interactive: false,
        smoothFactor: 0,
        offset,
      });

      const layers = networkLayersByLine.get(line) || [];
      layers.push(casing, glow, core);
      networkLayersByLine.set(line, layers);

      if (activeLines.has(line)) {
        casing.addTo(map);
        glow.addTo(map);
        core.addTo(map);
      }
    }
  }
}

async function loadNetwork() {
  try {
    const response = await fetch("/api/network", { cache: "no-store" });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.last_error || ("HTTP " + response.status));
    }

    drawStaticNetwork(payload);
    drawStops(payload.stops || []);
    buildLineFilter();

    for (const [stableKey, marker] of markers) {
      const meta = vehicleMeta.get(stableKey);
      if (!meta) continue;

      marker.setIcon(vehicleIcon(meta.line, meta.delayStatus));
    }

    updateVehicleScale();
    return true;
  } catch (error) {
    console.error("Could not load static VRS GTFS network:", error);
    return false;
  }
}

function scheduleSnapshotMotion(stableKey, marker, vehicle, previousMeta) {
  if (previousMeta && previousMeta.observedAt === vehicle.observed_at) {
    return;
  }

  let target = snapVehicleToNetwork(vehicle);
  const from = marker.getLatLng();
  const nearbyStop = nearestStopForLine(target, vehicle.line);
  const dwell = stationDwells.get(stableKey);
  let motionMode = "cruise";
  let dwellStopId = null;
  let departedStopId = null;

  if (dwell) {
    const dwellStop = (networkStopsByLine.get(String(vehicle.line)) || [])
      .find((stop) => stop.id === dwell.stopId);

    if (
      dwellStop &&
      target.distanceTo(dwellStop.point) <= STOP_RELEASE_DISTANCE_M
    ) {
      marker.setLatLng(dwellStop.point);
      motions.delete(stableKey);
      return;
    }

    stationDwells.delete(stableKey);
    departedStopId = dwell.stopId;
    motionMode = "depart";
  }

  if (nearbyStop && nearbyStop.id !== departedStopId) {
    target = nearbyStop.point;
    motionMode = "approach";
    dwellStopId = nearbyStop.id;
  }

  if (!previousMeta) {
    marker.setLatLng(target);
    motions.delete(stableKey);

    if (dwellStopId) {
      stationDwells.set(stableKey, {
        stopId: dwellStopId,
        arrivedAt: Date.now(),
        minimumUntil: Date.now() + STOP_DWELL_MS,
      });
    }
    return;
  }

  const distance = from.distanceTo(target);

  if (distance < 0.5) {
    marker.setLatLng(target);
    motions.delete(stableKey);

    if (dwellStopId) {
      stationDwells.set(stableKey, {
        stopId: dwellStopId,
        arrivedAt: Date.now(),
        minimumUntil: Date.now() + STOP_DWELL_MS,
      });
    }
    return;
  }

  let duration = DEFAULT_MOVE_MS;

  const previousTime = Date.parse(previousMeta.observedAt || "");
  const currentTime = Date.parse(vehicle.observed_at || "");

  if (Number.isFinite(previousTime) && Number.isFinite(currentTime)) {
    const delta = currentTime - previousTime;

    if (delta > 3000 && delta < 30000) {
      // Let motion slightly overlap the expected next snapshot instead of
      // arriving early and visibly waiting. A new snapshot retargets the
      // marker from its current interpolated position, keeping motion fluid.
      duration = Math.max(12000, Math.min(22000, delta * 1.12));
    }
  }

  motions.set(stableKey, {
    marker,
    from,
    to: target,
    startedAt: performance.now(),
    duration,
    mode: motionMode,
    dwellStopId,
  });

  if (distance > 1) {
    setMarkerBearing(marker, bearingBetween(from, target));
  }
}

function animateMarkers(frameNow) {
  for (const [stableKey, motion] of motions) {
    const elapsed = frameNow - motion.startedAt;
    const raw = Math.max(0, Math.min(1, elapsed / motion.duration));
    const progress = stationMotionProgress(raw, motion.mode);

    motion.marker.setLatLng([
      motion.from.lat + (motion.to.lat - motion.from.lat) * progress,
      motion.from.lng + (motion.to.lng - motion.from.lng) * progress,
    ]);

    if (raw >= 1) {
      motions.delete(stableKey);

      if (motion.dwellStopId) {
        stationDwells.set(stableKey, {
          stopId: motion.dwellStopId,
          arrivedAt: Date.now(),
          minimumUntil: Date.now() + STOP_DWELL_MS,
        });
      }
    }
  }

  requestAnimationFrame(animateMarkers);
}

function vehicleScaleForZoom(zoom) {
  const scale = 0.78 * Math.pow(1.16, zoom - 11);
  return Math.max(0.72, Math.min(1.65, scale));
}

function updateVehicleScale() {
  const scale = vehicleScaleForZoom(map.getZoom());

  for (const marker of markers.values()) {
    const element = marker.getElement();
    if (!element) continue;

    const scaled = element.querySelector(".tram-scale");
    if (scaled) {
      scaled.style.setProperty("--vehicle-scale", scale);
    }
  }
}

function realignVehiclesToCurrentZoom() {
  const now = performance.now();

  for (const [stableKey, marker] of markers) {
    const meta = vehicleMeta.get(stableKey);
    const vehicle = meta && meta.latestVehicle;

    if (!vehicle) continue;

    const target = snapVehicleToNetwork(vehicle);
    const dwell = stationDwells.get(stableKey);

    if (dwell) {
      const dwellStop = (networkStopsByLine.get(String(vehicle.line)) || [])
        .find((stop) => stop.id === dwell.stopId);

      if (
        dwellStop &&
        target.distanceTo(dwellStop.point) <= STOP_RELEASE_DISTANCE_M
      ) {
        motions.delete(stableKey);
        marker.setLatLng(dwellStop.point);
        continue;
      }
    }

    const current = marker.getLatLng();
    const correctedCurrent = snapLatLngToLine(current, vehicle.line);
    const existingMotion = motions.get(stableKey);

    // Pixel offsets change with zoom. Correct that visual offset immediately
    // instead of letting the tram drift sideways for several seconds.
    if (current.distanceTo(correctedCurrent) > 0.2) {
      marker.setLatLng(correctedCurrent);
    }

    if (existingMotion) {
      const elapsed = now - existingMotion.startedAt;
      const remaining = Math.max(
        900,
        existingMotion.duration - elapsed
      );

      existingMotion.from = correctedCurrent;
      existingMotion.to = target;
      existingMotion.startedAt = now;
      existingMotion.duration = remaining;
      continue;
    }

    if (correctedCurrent.distanceTo(target) > 0.5) {
      motions.set(stableKey, {
        marker,
        from: correctedCurrent,
        to: target,
        startedAt: now,
        duration: 900,
      });
    }
  }
}

function updateMarkers(vehicles) {
  const now = Date.now();
  const usedStableKeys = new Set();

  for (const vehicle of vehicles) {
    const stableKey = chooseStableKey(vehicle, usedStableKeys, now);
    usedStableKeys.add(stableKey);
    jidToStableKey.set(vehicle.journey_id, stableKey);

    let marker = markers.get(stableKey);
    const previousMeta = vehicleMeta.get(stableKey);

    if (!marker) {
      marker = L.marker([vehicle.latitude, vehicle.longitude], {
        icon: vehicleIcon(vehicle.line, vehicle.delay_status),
        keyboard: false,
        riseOnHover: true,
      }).addTo(map);

      markers.set(stableKey, marker);
      marker.setOpacity(activeLines.has(String(vehicle.line)) ? 1 : 0);
    } else if (
      !previousMeta ||
      previousMeta.delayStatus !== vehicle.delay_status ||
      String(previousMeta.line) !== String(vehicle.line)
    ) {
      marker.setIcon(vehicleIcon(vehicle.line, vehicle.delay_status));

      if (Number.isFinite(marker._tramBearing)) {
        requestAnimationFrame(() => {
          setMarkerBearing(marker, marker._tramBearing);
        });
      }
    }

    marker.setOpacity(activeLines.has(String(vehicle.line)) ? 1 : 0);
    scheduleSnapshotMotion(stableKey, marker, vehicle, previousMeta);

    vehicleMeta.set(stableKey, {
      line: vehicle.line,
      direction: vehicle.direction,
      delayStatus: vehicle.delay_status,
      lastSeen: now,
      observedAt: vehicle.observed_at,
      currentJid: vehicle.journey_id,
      latestVehicle: vehicle,
    });

    const direction = vehicle.direction
      ? "→ " + vehicle.direction + "<br>"
      : "";

    marker.bindPopup(
      "<strong>line " + vehicle.line + "</strong><br>" +
      direction +
      delayText(vehicle) + "<br>" +
      "updated " + formatTime(vehicle.observed_at)
    );
  }

  updateVehicleScale();

  for (const [stableKey, marker] of markers) {
    if (usedStableKeys.has(stableKey)) continue;

    motions.delete(stableKey);

    const meta = vehicleMeta.get(stableKey);
    if (meta && now - meta.lastSeen < MISSING_GRACE_MS) {
      continue;
    }

    map.removeLayer(marker);
    markers.delete(stableKey);
    vehicleMeta.delete(stableKey);
    stationDwells.delete(stableKey);

    for (const [jid, mappedKey] of jidToStableKey) {
      if (mappedKey === stableKey) {
        jidToStableKey.delete(jid);
      }
    }
  }
}

async function loadVehicles(forceFresh = false) {
  vehicleRequestInFlight = true;
  vehicleRequestStartedAt = performance.now();

  window.clearTimeout(syncIndicatorTimer);
  syncIndicatorTimer = window.setTimeout(
    updateLiveStatus,
    350
  );

  try {
    const endpoint = forceFresh
      ? "/api/vehicles?fresh=1"
      : "/api/vehicles";
    const response = await fetch(endpoint, { cache: "no-store" });
    const payload = await response.json();

    if (!response.ok && !(payload.vehicles && payload.vehicles.length)) {
      throw new Error(payload.last_error || ("HTTP " + response.status));
    }

    lastVehiclePayload = payload;
    lastVehicleLoadFailed = false;

    updateMarkers(payload.vehicles || []);
    countElement.textContent = (payload.vehicles || []).filter(
      (vehicle) => activeLines.has(String(vehicle.line))
    ).length;

    return true;
  } catch (error) {
    lastVehicleLoadFailed = true;
    console.error("Could not load Cologne tram vehicles:", error);
    return false;
  } finally {
    vehicleRequestInFlight = false;
    window.clearTimeout(syncIndicatorTimer);
    updateLiveStatus();
  }
}

map.on("zoom", () => {
  updateVehicleScale();
});

map.on("zoomend", () => {
  realignVehiclesToCurrentZoom();
});

updateResponsiveLayout({ resetView: false });
applyDisplayMode(displayMode, false);

async function loadAppConfig() {
  try {
    const response = await fetch("/api/config", { cache: "no-store" });
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    console.warn("Could not load app config:", error);
    return null;
  }
}

function showMapImmediately() {
  mapShellElement.classList.remove("is-loading");
  mapShellElement.classList.add("is-ready");

  if (loadingScreenElement) {
    loadingScreenElement.hidden = true;
  }

  setLoadingControlsDisabled(false);
}

async function waitForFirstMotion(timeoutMs = 22000) {
  const startedAt = performance.now();

  while (performance.now() - startedAt < timeoutMs) {
    await sleep(3000);
    await loadVehicles();

    if (motions.size > 0) {
      return true;
    }
  }

  return false;
}

let appInitialized = false;
let lastResumeRefreshAt = 0;

async function refreshAfterResume() {
  if (!appInitialized || document.visibilityState !== "visible") {
    return;
  }

  const now = Date.now();
  if (now - lastResumeRefreshAt < 2000) {
    return;
  }

  lastResumeRefreshAt = now;
  map.invalidateSize({ pan: false });

  await loadVehicles(true);
  updateVehicleScale();
  realignVehiclesToCurrentZoom();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    refreshAfterResume();
  }
});

window.addEventListener("pageshow", () => {
  if (document.visibilityState === "visible") {
    refreshAfterResume();
  }
});

async function initializeApp() {
  setLoadingControlsDisabled(true);
  updateClock();
  requestAnimationFrame(animateMarkers);

  const config = await loadAppConfig();
  const bootId = config && config.boot_id;
  const seenBootId = window.localStorage.getItem(SERVER_BOOT_STORAGE_KEY);
  const shouldShowLoader = !bootId || seenBootId !== bootId;

  if (!shouldShowLoader) {
    showMapImmediately();
  }

  const loadingSequence = shouldShowLoader
    ? runLoadingSequence()
    : Promise.resolve();

  buildViewPicker();
  const networkLoaded = await loadNetwork();
  const firstVehiclesLoaded = await loadVehicles();

  if (!networkLoaded || !firstVehiclesLoaded) {
    console.warn("Initial map data was only partially available.");
  }

  if (shouldShowLoader) {
    const motionStarted = await waitForFirstMotion();

    if (!motionStarted) {
      console.warn("No vehicle motion detected before loading timeout.");
    }

    await loadingSequence;
    await revealMap();

    if (bootId) {
      window.localStorage.setItem(SERVER_BOOT_STORAGE_KEY, bootId);
    }
  }

  setInterval(updateClock, 1000);
  setInterval(loadVehicles, REFRESH_MS);
  setInterval(updateLiveStatus, 500);
  appInitialized = true;
}

initializeApp();
