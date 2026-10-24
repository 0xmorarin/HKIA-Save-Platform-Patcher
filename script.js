import {
  PLATFORM,
  PLATFORM_LABELS,
  SavePatcherError,
  formatPlayTime,
  parseSave,
  patchSavePlatform
} from "./parser.js";

const $ = (id) => document.getElementById(id);

// Output IDs are game PlatformType values, NOT DlcPlatform values.
// PS5 support uses the raw HKIA save payload, like Switch and Steam.
// This does not claim PS5 console restore or in-game loading was tested.
const PLATFORM_GROUPS = Object.freeze([
  Object.freeze({ key: "steam", label: "Steam", inputs: [PLATFORM.WINDOWS_STEAM], output: PLATFORM.WINDOWS_STEAM, enabled: true, fileName: (slot) => `save_${slot}.save` }),
  Object.freeze({ key: "switch", label: "Nintendo Switch", inputs: [PLATFORM.SWITCH], output: PLATFORM.SWITCH, enabled: true, fileName: (slot) => `save_${slot}.save` }),
  Object.freeze({ key: "apple", label: "Apple Arcade", inputs: [4, 5, 6, 7], output: PLATFORM.APPLE_ARCADE, enabled: true, fileName: (slot) => `Save_HeroesFate_${slot}.save` }),
  Object.freeze({ key: "ps5", label: "PlayStation 5", inputs: [PLATFORM.PS5], output: PLATFORM.PS5, enabled: true, fileName: (slot) => `save_${slot}.save` })
]);

const groupFor = (id) => PLATFORM_GROUPS.find((group) => group.inputs.includes(id)) ?? null;

function parseSlot(fileName) {
  const match = /^(?:save|Save_HeroesFate)_(\d+)\.save$/i.exec(fileName || "");
  if (!match) return null;
  const slot = Number(match[1]);
  // Preserve slot digits exactly (including leading zeroes). Never guess slot 0.
  return Number.isSafeInteger(slot) && slot >= 0 ? match[1] : null;
}

let currentSave = null;
let activeDownloadUrls = new Set();
let processingId = 0;
let dragDepth = 0;

function setView(name) {
  for (const id of ["idleView", "processingView", "successView", "errorView"]) {
    $(id).hidden = id !== `${name}View`;
  }
}

function clearDownloads() {
  for (const url of activeDownloadUrls) URL.revokeObjectURL(url);
  activeDownloadUrls = new Set();
}

function clearFeedback() {
  const el = $("conversionFeedback");
  el.textContent = "";
  el.hidden = true;
  el.classList.remove("feedback-error", "feedback-success");
}

function feedback(message, isError = false) {
  const el = $("conversionFeedback");
  el.textContent = message;
  el.hidden = false;
  el.classList.toggle("feedback-error", isError);
  el.classList.toggle("feedback-success", !isError);
}

function errorText(error) {
  if (error instanceof SavePatcherError) {
    if (error.code === "not_hkia") return ["This does not look like an HKIA save", "The file could not be recognized as an HKIA save. No changes were made."];
    if (error.code === "platform_missing") return ["Platform information missing", "The save does not contain platform information. No changes were made."];
    if (error.code === "unsupported_platform") return ["Unsupported platform", "This save uses a platform that is not supported. No changes were made."];
  }
  return ["Unable to read the save", "The save could not be safely processed. No changes were made."];
}

function showError(error) {
  currentSave = null;
  clearDownloads();
  const [title, message] = errorText(error);
  $("errorTitle").textContent = title;
  $("errorMessage").textContent = message;
  setView("error");
}

function downloadBytes(bytes, fileName) {
  const blob = new Blob([bytes], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  activeDownloadUrls.add(url);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.style.display = "none";
  document.body.appendChild(a);
  try { a.click(); } finally { a.remove(); }
}

function convertAndDownload(targetGroup) {
  const state = currentSave;
  if (!state || !targetGroup.enabled || !state.sourceGroup.enabled) return;
  if (targetGroup.key === state.sourceGroup.key) return;
  clearFeedback();
  try {
    const result = patchSavePlatform(state.bytes, targetGroup.output);
    if (result.before.platformType !== state.info.platformType || result.after.platformType !== targetGroup.output) {
      throw new Error("Unexpected conversion result.");
    }
    const fileName = targetGroup.fileName(state.slot);
    downloadBytes(result.bytes, fileName);
    feedback(`Download started: ${fileName}`);
  } catch (error) {
    console.error("HKIA save conversion failed", error);
    feedback(`Conversion to ${targetGroup.label} failed verification. No file was downloaded.`, true);
  }
}

function showSave(state) {
  currentSave = state;
  $("platformName").textContent = state.sourceGroup.label;
  $("gameVersion").textContent = state.info.applicationVersion;
  $("playTime").textContent = formatPlayTime(state.info.timePlayedTicks);
  $("resultTitle").textContent = "Save loaded";
  $("saveFileName").textContent = state.fileName;
  clearFeedback();
  const buttons = $("downloadButtons");
  buttons.replaceChildren();

  for (const destination of PLATFORM_GROUPS) {
    if (destination.key === state.sourceGroup.key) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `primary-button destination-button destination--${destination.key}`;
    const name = document.createElement("span");
    name.className = "destination-name";
    name.textContent = destination.label;
    button.appendChild(name);

    const status = document.createElement("span");
    const unavailable = !destination.enabled || !state.sourceGroup.enabled;
    if (unavailable) {
      button.disabled = true;
      button.title = !destination.enabled ? "Pending save verification" : "Conversion not yet available for this source";
      button.setAttribute("aria-label", `${destination.label} unavailable`);
      status.className = "destination-badge";
      status.textContent = "Soon";
    } else if (state.slot === null) {
      button.disabled = true;
      button.title = "Save slot is missing from the filename";
      button.setAttribute("aria-label", `${destination.label} unavailable: save slot unknown`);
      status.className = "destination-badge";
      status.innerHTML = `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/></svg>`;
    } else {
      button.title = destination.fileName(state.slot);
      button.setAttribute("aria-label", `Download for ${destination.label}`);
      status.className = "destination-action";
      status.setAttribute("aria-hidden", "true");
      status.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2"/></svg>`;
      button.addEventListener("click", () => convertAndDownload(destination));
    }
    button.appendChild(status);
    buttons.appendChild(button);
  }

  if (state.slot === null) {
    feedback("Save slot unknown. Use a standard filename (e.g. save_0.save).", true);
  }
  setView("success");
}

async function processFile(file) {
  if (!file) return;
  const id = ++processingId;
  currentSave = null;
  clearDownloads();
  setView("processing");
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (id !== processingId) return;
    const info = parseSave(bytes);
    const sourceGroup = groupFor(info.platformType);
    if (!sourceGroup) {
      throw new SavePatcherError("unsupported_platform", "Unknown source PlatformType");
    }
    showSave({ bytes, info, sourceGroup, slot: parseSlot(file.name), fileName: file.name });
  } catch (error) {
    if (id !== processingId) return;
    showError(error);
  }
}

function openFilePicker() { $("fileInput").click(); }
function hasFiles(event) { return Array.from(event.dataTransfer?.types ?? []).includes("Files"); }
function hideDropOverlay() { dragDepth = 0; $("dropOverlay").hidden = true; }

function initDragAndDrop() {
  document.addEventListener("dragenter", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    $("dropOverlay").hidden = false;
  });
  document.addEventListener("dragover", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  });
  document.addEventListener("dragleave", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) hideDropOverlay();
  });
  document.addEventListener("drop", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    hideDropOverlay();
    const file = event.dataTransfer?.files?.[0];
    if (file) processFile(file);
  });
}

function init() {
  $("chooseButton").addEventListener("click", openFilePicker);
  $("chooseAnotherButton").addEventListener("click", openFilePicker);
  $("errorChooseButton").addEventListener("click", openFilePicker);
  $("fileInput").addEventListener("change", () => {
    const file = $("fileInput").files?.[0];
    $("fileInput").value = "";
    if (file) processFile(file);
  });
  initDragAndDrop();
  window.addEventListener("beforeunload", clearDownloads);
}

document.addEventListener("DOMContentLoaded", init);
