import {
  PLATFORM_LABELS,
  SavePatcherError,
  formatPlayTime,
  patchSavePlatform
} from "./parser.js";

const $ = (id) => document.getElementById(id);

let currentDownloadUrl = null;
let currentPatchedBytes = null;
let processingId = 0;
let dragDepth = 0;

function setView(name) {
  for (const id of ["idleView", "processingView", "successView", "errorView"]) {
    $(id).hidden = id !== `${name}View`;
  }
}

function clearDownload() {
  if (currentDownloadUrl) URL.revokeObjectURL(currentDownloadUrl);
  currentDownloadUrl = null;
  currentPatchedBytes = null;
}

function prepareDownload(bytes) {
  clearDownload();
  currentPatchedBytes = bytes;
  currentDownloadUrl = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
}

function downloadPatchedSave() {
  if (!currentDownloadUrl || !currentPatchedBytes) return;
  const link = document.createElement("a");
  link.href = currentDownloadUrl;
  link.download = "save_0.save";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function openFilePicker() {
  $("fileInput").click();
}

function showSuccess(result) {
  const target = PLATFORM_LABELS[result.after.platformType];

  $("resultTitle").textContent = `Patched for ${target}`;
  $("gameVersion").textContent = result.before.applicationVersion;
  $("playTime").textContent = formatPlayTime(result.before.timePlayedTicks);
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
      message: "This patcher currently supports Nintendo Switch and Steam saves only. No changes were made."
    };
  }

  return {
    title: "Patch verification failed",
    message: "The patched save did not pass the safety checks, so no file was downloaded."
  };
}

function showError(error) {
  clearDownload();
  const text = errorText(error);
  $("errorTitle").textContent = text.title;
  $("errorMessage").textContent = text.message;
  setView("error");
}

async function processFile(file) {
  if (!file) return;

  const id = ++processingId;
  clearDownload();
  setView("processing");

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (id !== processingId) return;
    const result = patchSavePlatform(bytes);
    if (id !== processingId) return;
    prepareDownload(result.bytes);
    showSuccess(result);
    downloadPatchedSave();
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
  $("downloadAgainButton").addEventListener("click", downloadPatchedSave);

  $("fileInput").addEventListener("change", () => {
    const file = $("fileInput").files?.[0];
    $("fileInput").value = "";
    if (file) processFile(file);
  });

  initDragAndDrop();

  window.addEventListener("beforeunload", () => {
    if (currentDownloadUrl) URL.revokeObjectURL(currentDownloadUrl);
  });
}

document.addEventListener("DOMContentLoaded", init);
