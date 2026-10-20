import {
  PLATFORM,
  PLATFORM_LABELS,
  SavePatcherError,
  formatPlayTime,
  parseSave,
  patchSavePlatform
} from "./parser.js";

const $ = (id) => document.getElementById(id);

let downloadUrls = [];

const SAVE_FILE_NAMES = Object.freeze({
  [PLATFORM.WINDOWS_STEAM]: (slot) => `save_${slot}.save`,
  [PLATFORM.SWITCH]: (slot) => `save_${slot}.save`,
  [PLATFORM.APPLE_ARCADE]: (slot) => `Save_HeroesFate_${slot}.save`
});

function saveSlot(fileName) {
  return /^(?:save|Save_HeroesFate)_(\d+)\.save$/i.exec(fileName ?? "")?.[1] ?? "0";
}

function saveFileName(platform, sourceFileName) {
  return SAVE_FILE_NAMES[platform](saveSlot(sourceFileName));
}

let processingId = 0;
let dragDepth = 0;

function setView(name) {
  for (const id of ["idleView", "processingView", "successView", "errorView"]) {
    $(id).hidden = id !== `${name}View`;
  }
}

function clearDownloads() {
  for (const url of downloadUrls) URL.revokeObjectURL(url);
  downloadUrls = [];
  $("downloadButtons").replaceChildren();
}

function downloadFile(url, fileName) {
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function openFilePicker() {
  $("fileInput").click();
}

function showSuccess(info, results, sourceFileName) {
  clearDownloads();
  
  $("platformName").textContent = PLATFORM_LABELS[info.platformType];
  $("gameVersion").textContent = info.applicationVersion;
  $("playTime").textContent = formatPlayTime(info.timePlayedTicks);

  for (const result of results) {
    const url = URL.createObjectURL(new Blob([result.bytes], { type: "application/octet-stream" }));
    downloadUrls.push(url);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "primary-button";
    button.textContent = `Download For ${PLATFORM_LABELS[result.targetPlatform]}`;
    const fileName = saveFileName(result.targetPlatform, sourceFileName);
    button.title = fileName;
    button.addEventListener("click", () => downloadFile(url, fileName));
    $("downloadButtons").appendChild(button);
  }

  setView("success");
}

function errorText(error) {
  if (!(error instanceof SavePatcherError)) {
    return {
      title: "This save could not be patched",
      message: "The file could not be processed. No changes were made."
    };
  }

  if (error.code === "not_hkia") {
    return {
      title: "This does not look like an HKIA save",
      message: "The file could not be recognized as a Hello Kitty Island Adventure save. No changes were made."
    };
  }

  if (error.code === "platform_missing") {
    return {
      title: "No platform information was found",
      message: "The HKIA save was recognized, but it does not contain the platform information required by this patcher. No changes were made."
    };
  }

  if (error.code === "unsupported_platform") {
    return {
      title: "This save platform is not supported",
      message: "This patcher currently supports Nintendo Switch, Steam and Apple Arcade saves only. No changes were made."
    };
  }

  return {
    title: "Patch verification failed",
    message: "The patched save did not pass the safety checks, so no download was offered."
  };
}

function showError(error) {
  clearDownloads();
  const text = errorText(error);
  $("errorTitle").textContent = text.title;
  $("errorMessage").textContent = text.message;
  setView("error");
}

async function processFile(file) {
  if (!file) return;

  const id = ++processingId;
  clearDownloads();
  setView("processing");

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (id !== processingId) return;
    const info = parseSave(bytes);
    const results = Object.values(PLATFORM).filter((target) => target !== info.platformType).map((target) => patchSavePlatform(bytes, target));
    if (id !== processingId) return;
    showSuccess(info, results, file.name);
  } catch (error) {
    if (id !== processingId) return;
    showError(error);
  }
}

function hasFiles(event) {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

function showDropOverlay() {
  $("dropOverlay").hidden = false;
}

function hideDropOverlay() {
  dragDepth = 0;
  $("dropOverlay").hidden = true;
}

function initDragAndDrop() {
  document.addEventListener("dragenter", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    showDropOverlay();
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
