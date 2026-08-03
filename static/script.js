// ===== マルチトラック音声エディタ フロントエンド =====

const PX_PER_SEC = 60; // style.css の --px-per-sec と揃える
const LABEL_WIDTH = 150;

const state = {
  tracks: [],       // [{trackId, label, clips: [clip, ...]}]
  selectedClipId: null,
  playheadSec: 0,
  isPlaying: false,
  audioEls: {},      // clipId -> <audio> (再生用に動的生成)
  playTimers: [],
  rafId: null,
  playStartWallClock: 0,
};

let clipCounter = 0;
let trackCounter = 0;

const el = {
  fileInput: document.getElementById("fileInput"),
  tracksContainer: document.getElementById("tracksContainer"),
  ruler: document.getElementById("ruler"),
  emptyHint: document.getElementById("emptyHint"),
  status: document.getElementById("status"),
  playBtn: document.getElementById("playBtn"),
  stopBtn: document.getElementById("stopBtn"),
  cutBtn: document.getElementById("cutBtn"),
  deleteBtn: document.getElementById("deleteBtn"),
  exportBtn: document.getElementById("exportBtn"),
  formatSelect: document.getElementById("formatSelect"),
};

function setStatus(msg, isError = false) {
  el.status.textContent = msg || "";
  el.status.style.color = isError ? "#ff6b6b" : "";
}

function fmtTime(sec) {
  sec = Math.max(0, sec);
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ---------- アップロード ----------

el.fileInput.addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []);
  for (const file of files) {
    await uploadFile(file);
  }
  e.target.value = "";
  renderAll();
});

async function uploadFile(file) {
  setStatus(`アップロード中: ${file.name} ...`);
  const fd = new FormData();
  fd.append("file", file);
  try {
    const res = await fetch("/api/upload", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) {
      setStatus(`エラー: ${data.error || "アップロードに失敗しました"}`, true);
      return;
    }
    trackCounter += 1;
    const trackId = `t${trackCounter}`;
    const clip = {
      clipId: `c${++clipCounter}`,
      fileId: data.id,
      ext: data.ext,
      filename: data.filename,
      url: data.url,
      srcDuration: data.duration,
      trimStart: 0,
      trimEnd: data.duration,
      timelineStart: 0,
      trackId,
    };
    state.tracks.push({ trackId, label: data.filename, clips: [clip] });
    setStatus(`追加しました: ${file.name}`);
  } catch (err) {
    setStatus(`通信エラー: ${err}`, true);
  }
}

// ---------- 描画 ----------

function timelineTotalDuration() {
  let maxT = 30;
  for (const track of state.tracks) {
    for (const clip of track.clips) {
      const end = clip.timelineStart + (clip.trimEnd - clip.trimStart);
      if (end > maxT) maxT = end;
    }
  }
  return maxT + 15;
}

function renderRuler() {
  const total = timelineTotalDuration();
  el.ruler.innerHTML = "";
  el.ruler.style.width = `${total * PX_PER_SEC}px`;
  for (let s = 0; s <= total; s += 5) {
    const tick = document.createElement("div");
    tick.className = "tick";
    tick.style.left = `${s * PX_PER_SEC}px`;
    tick.textContent = fmtTime(s);
    el.ruler.appendChild(tick);
  }
}

function renderAll() {
  el.emptyHint.style.display = state.tracks.length === 0 ? "block" : "none";
  renderRuler();

  // 既存の track-row / playhead を削除して再構築
  el.tracksContainer.querySelectorAll(".track-row, .playhead").forEach((n) => n.remove());

  const total = timelineTotalDuration();

  for (const track of state.tracks) {
    const row = document.createElement("div");
    row.className = "track-row";

    const label = document.createElement("div");
    label.className = "track-label";
    label.textContent = track.label;
    row.appendChild(label);

    const lane = document.createElement("div");
    lane.className = "track-lane";
    lane.style.width = `${total * PX_PER_SEC}px`;
    lane.dataset.trackId = track.trackId;
    lane.addEventListener("click", (e) => {
      if (e.target === lane) seekFromClientX(e.clientX, lane);
    });

    for (const clip of track.clips) {
      lane.appendChild(buildClipEl(clip));
    }

    row.appendChild(lane);
    el.tracksContainer.appendChild(row);
  }

  const playhead = document.createElement("div");
  playhead.className = "playhead";
  playhead.id = "playheadEl";
  playhead.style.left = `${LABEL_WIDTH + state.playheadSec * PX_PER_SEC}px`;
  el.tracksContainer.appendChild(playhead);
}

function buildClipEl(clip) {
  const dur = clip.trimEnd - clip.trimStart;
  const div = document.createElement("div");
  div.className = "clip" + (state.selectedClipId === clip.clipId ? " selected" : "");
  div.style.left = `${clip.timelineStart * PX_PER_SEC}px`;
  div.style.width = `${Math.max(dur * PX_PER_SEC, 10)}px`;
  div.dataset.clipId = clip.clipId;

  const labelDiv = document.createElement("div");
  labelDiv.className = "clip-label";
  labelDiv.textContent = clip.filename;
  div.appendChild(labelDiv);

  const leftHandle = document.createElement("div");
  leftHandle.className = "handle left";
  div.appendChild(leftHandle);

  const rightHandle = document.createElement("div");
  rightHandle.className = "handle right";
  div.appendChild(rightHandle);

  div.addEventListener("click", (e) => {
    e.stopPropagation();
    state.selectedClipId = clip.clipId;
    renderAll();
  });

  attachDrag(div, clip);
  attachResize(leftHandle, clip, "left");
  attachResize(rightHandle, clip, "right");

  return div;
}

function findClip(clipId) {
  for (const track of state.tracks) {
    const clip = track.clips.find((c) => c.clipId === clipId);
    if (clip) return { clip, track };
  }
  return null;
}

// ---------- ドラッグ移動 ----------

function attachDrag(clipEl, clip) {
  clipEl.addEventListener("mousedown", (e) => {
    if (e.target.classList.contains("handle")) return;
    e.preventDefault();
    e.stopPropagation();
    state.selectedClipId = clip.clipId;
    const startX = e.clientX;
    const startTimelineStart = clip.timelineStart;

    function onMove(ev) {
      const dx = ev.clientX - startX;
      const deltaSec = dx / PX_PER_SEC;
      clip.timelineStart = Math.max(0, startTimelineStart + deltaSec);
      clipEl.style.left = `${clip.timelineStart * PX_PER_SEC}px`;
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      renderAll();
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

// ---------- トリミング(端のドラッグ) ----------

function attachResize(handleEl, clip, side) {
  handleEl.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    state.selectedClipId = clip.clipId;
    const startX = e.clientX;
    const startTrimStart = clip.trimStart;
    const startTrimEnd = clip.trimEnd;
    const startTimelineStart = clip.timelineStart;

    function onMove(ev) {
      const dx = ev.clientX - startX;
      const deltaSec = dx / PX_PER_SEC;

      if (side === "left") {
        let newTrimStart = startTrimStart + deltaSec;
        newTrimStart = Math.max(0, Math.min(newTrimStart, startTrimEnd - 0.05));
        const actualDelta = newTrimStart - startTrimStart;
        clip.trimStart = newTrimStart;
        clip.timelineStart = Math.max(0, startTimelineStart + actualDelta);
      } else {
        let newTrimEnd = startTrimEnd + deltaSec;
        newTrimEnd = Math.min(clip.srcDuration, Math.max(newTrimEnd, startTrimStart + 0.05));
        clip.trimEnd = newTrimEnd;
      }
      renderAll();
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

// ---------- カット / 削除 ----------

el.cutBtn.addEventListener("click", () => {
  if (!state.selectedClipId) {
    setStatus("カットするクリップを選択してください", true);
    return;
  }
  const found = findClip(state.selectedClipId);
  if (!found) return;
  const { clip, track } = found;

  const clipStartT = clip.timelineStart;
  const clipEndT = clip.timelineStart + (clip.trimEnd - clip.trimStart);
  const playhead = state.playheadSec;

  if (playhead <= clipStartT + 0.05 || playhead >= clipEndT - 0.05) {
    setStatus("カットしたい位置に再生ヘッドを合わせてから実行してください", true);
    return;
  }

  const cutLocal = clip.trimStart + (playhead - clipStartT); // 元ファイル内でのカット位置

  const clipB = {
    ...clip,
    clipId: `c${++clipCounter}`,
    trimStart: cutLocal,
    timelineStart: clip.timelineStart + (cutLocal - clip.trimStart),
  };
  clip.trimEnd = cutLocal;

  const idx = track.clips.indexOf(clip);
  track.clips.splice(idx + 1, 0, clipB);

  setStatus("カットしました。2つのクリップに分割されました。");
  renderAll();
});

el.deleteBtn.addEventListener("click", () => {
  if (!state.selectedClipId) {
    setStatus("削除するクリップを選択してください", true);
    return;
  }
  const found = findClip(state.selectedClipId);
  if (!found) return;
  const { clip, track } = found;
  track.clips = track.clips.filter((c) => c.clipId !== clip.clipId);
  if (track.clips.length === 0) {
    state.tracks = state.tracks.filter((t) => t.trackId !== track.trackId);
  }
  state.selectedClipId = null;
  renderAll();
});

// ---------- 再生ヘッド / シーク ----------

function seekFromClientX(clientX, referenceEl) {
  const rect = referenceEl.getBoundingClientRect();
  const x = clientX - rect.left;
  state.playheadSec = Math.max(0, x / PX_PER_SEC);
  renderAll();
}

el.ruler.addEventListener("click", (e) => seekFromClientX(e.clientX, el.ruler));

// ---------- 再生 / 停止 ----------

function stopPlayback() {
  state.isPlaying = false;
  state.playTimers.forEach((id) => clearTimeout(id));
  state.playTimers = [];
  Object.values(state.audioEls).forEach((a) => {
    a.pause();
  });
  if (state.rafId) cancelAnimationFrame(state.rafId);
  state.rafId = null;
}

el.playBtn.addEventListener("click", () => {
  stopPlayback();
  state.isPlaying = true;
  const startPlayhead = state.playheadSec;
  state.playStartWallClock = performance.now();
  state._playStartSec = startPlayhead;

  let anyScheduled = false;

  for (const track of state.tracks) {
    for (const clip of track.clips) {
      const dur = clip.trimEnd - clip.trimStart;
      const clipStartT = clip.timelineStart;
      const clipEndT = clip.timelineStart + dur;
      if (clipEndT <= startPlayhead) continue; // 既に終わっている

      if (!state.audioEls[clip.clipId]) {
        const a = new Audio(clip.url);
        state.audioEls[clip.clipId] = a;
      }
      const audioEl = state.audioEls[clip.clipId];

      if (clipStartT <= startPlayhead) {
        // 再生ヘッドがクリップの途中にある -> 即再生
        audioEl.currentTime = clip.trimStart + (startPlayhead - clipStartT);
        audioEl.play();
        anyScheduled = true;
      } else {
        // 未来に開始 -> setTimeoutで予約
        const waitMs = (clipStartT - startPlayhead) * 1000;
        const timerId = setTimeout(() => {
          audioEl.currentTime = clip.trimStart;
          audioEl.play();
        }, waitMs);
        state.playTimers.push(timerId);
        anyScheduled = true;
      }
    }
  }

  if (!anyScheduled) {
    setStatus("再生できるクリップがありません", true);
    state.isPlaying = false;
    return;
  }

  setStatus("再生中...");
  tickPlayhead();
});

function tickPlayhead() {
  if (!state.isPlaying) return;
  const elapsed = (performance.now() - state.playStartWallClock) / 1000;
  const nowSec = state._playStartSec + elapsed;
  const playheadEl = document.getElementById("playheadEl");
  if (playheadEl) {
    playheadEl.style.left = `${LABEL_WIDTH + nowSec * PX_PER_SEC}px`;
  }
  state.rafId = requestAnimationFrame(tickPlayhead);
}

el.stopBtn.addEventListener("click", () => {
  if (state.isPlaying && state._playStartSec !== undefined) {
    const elapsed = (performance.now() - state.playStartWallClock) / 1000;
    state.playheadSec = state._playStartSec + elapsed;
  }
  stopPlayback();
  state._playStartSec = undefined;
  setStatus("停止しました");
  renderAll();
});

// ---------- 書き出し(結合) ----------

el.exportBtn.addEventListener("click", async () => {
  const clips = [];
  for (const track of state.tracks) {
    for (const clip of track.clips) {
      clips.push({
        fileId: clip.fileId,
        ext: clip.ext,
        trimStart: clip.trimStart,
        trimEnd: clip.trimEnd,
        timelineStart: clip.timelineStart,
      });
    }
  }
  if (clips.length === 0) {
    setStatus("書き出すクリップがありません", true);
    return;
  }
  setStatus("書き出し中...");
  try {
    const res = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clips, format: el.formatSelect.value }),
    });
    const data = await res.json();
    if (!res.ok) {
      setStatus(`エラー: ${data.error || "書き出しに失敗しました"}`, true);
      return;
    }
    setStatus("書き出し完了。ダウンロードを開始します。");
    const a = document.createElement("a");
    a.href = data.url;
    a.download = data.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (err) {
    setStatus(`通信エラー: ${err}`, true);
  }
});

// 初期描画
renderAll();
