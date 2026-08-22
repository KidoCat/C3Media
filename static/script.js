// ===== マルチトラック音声エディタ フロントエンド =====

const PX_PER_SEC = 60; // style.css の --px-per-sec と揃える
const LABEL_WIDTH = 150;
const GRID_SNAP_SEC = 1; // グリッドスナップの間隔(秒)。track-laneの背景の縦線(1秒間隔)と揃えている
const SNAP_PX_THRESHOLD = 8; // スナップが効く距離(px)。PX_PER_SECで秒に換算して使う

const state = {
  tracks: [],       // [{trackId, label, clips: [clip, ...]}]
  selectedClipId: null,
  playheadSec: 0,
  isPlaying: false,
  bufferCache: {},     // fileId -> Promise<AudioBuffer> (デコード済み音声データ、クリップ間で共有)
  activeSources: [],   // 再生中のAudioBufferSourceNode一覧
  rafId: null,
  playStartCtxTime: 0, // 再生開始時のAudioContext.currentTime
  _playStartSec: 0,    // 再生開始時点のタイムライン上の秒数
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
  clearUploadsBtn: document.getElementById("clearUploadsBtn"),
  exportBtn: document.getElementById("exportBtn"),
  formatSelect: document.getElementById("formatSelect"),
  currentTimeLabel: document.getElementById("currentTimeLabel"),
  totalTimeLabel: document.getElementById("totalTimeLabel"),
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

// ---------- 音声再生エンジン(Web Audio API) ----------
// <audio>要素 + setTimeoutでの再生は、シーク・再生開始のタイミングに数十ms単位の
// 誤差やゆらぎが出やすく、カットした境目で音が途切れたり重なったりする原因になる。
// Web Audio APIでバッファを直接スケジューリングし、カット前後のクリップをサンプル
// 単位の精度でつなぐことで、境目のノイズを解消する。

let audioContext = null;

function getAudioContext() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioContext.state === "suspended") {
    audioContext.resume();
  }
  return audioContext;
}

// 同じ音声ファイルはクリップ(カット後の断片含む)間でデコード結果を共有し、
// 再生のたびに毎回フェッチ・デコードし直さないようにする
function loadBuffer(fileId, url) {
  if (!state.bufferCache[fileId]) {
    state.bufferCache[fileId] = fetch(url)
      .then((res) => res.arrayBuffer())
      .then((arrayBuffer) => getAudioContext().decodeAudioData(arrayBuffer));
  }
  return state.bufferCache[fileId];
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
    loadBuffer(clip.fileId, clip.url).catch(() => {}); // 再生に備えて先にデコードしておく
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

// 実際の音声コンテンツの長さ(最後のクリップの終端)。ルーラー表示用の余白は含まない。
function contentDurationSec() {
  let maxT = 0;
  for (const track of state.tracks) {
    for (const clip of track.clips) {
      const end = clip.timelineStart + (clip.trimEnd - clip.trimStart);
      if (end > maxT) maxT = end;
    }
  }
  return maxT;
}

// 画面上部の「現在位置 / 合計時間」表示を更新する
function updateTimeDisplay(currentSec) {
  const cur = currentSec !== undefined ? currentSec : state.playheadSec;
  el.currentTimeLabel.textContent = fmtTime(cur);
  el.totalTimeLabel.textContent = fmtTime(contentDurationSec());
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
  updateTimeDisplay();

  // 既存の track-row / playhead を削除して再構築
  el.tracksContainer.querySelectorAll(".track-row, .playhead").forEach((n) => n.remove());

  const total = timelineTotalDuration();

  for (const track of state.tracks) {
    const row = document.createElement("div");
    row.className = "track-row";

    const label = document.createElement("div");
    label.className = "track-label";

    const labelText = document.createElement("span");
    labelText.className = "track-label-text";
    labelText.textContent = track.label;
    labelText.title = track.label;
    label.appendChild(labelText);

    const trackDeleteBtn = document.createElement("button");
    trackDeleteBtn.className = "track-delete-btn";
    trackDeleteBtn.title = "この音源ファイルをサーバーから削除";
    trackDeleteBtn.textContent = "🗑";
    trackDeleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteTrackFile(track);
    });
    label.appendChild(trackDeleteBtn);

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

  const handle = document.createElement("div");
  handle.className = "playhead-handle";
  playhead.appendChild(handle);
  attachScrub(handle, el.ruler); // つまみ(丸)からもスクラブできるようにする。座標計算はルーラー基準。

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

// ---------- スナップ(自動吸着) ----------
// クリップの移動・トリミング時に、きりのいい秒数(1秒刻みのグリッド)や、
// 他のクリップの端(特にカットでできた前後のパート)に近づいたら自動でぴったり合わせる。

// 指定クリップ以外の、全トラック上のクリップの開始・終了位置をスナップ候補として集める
function collectSnapCandidates(excludeClipId) {
  const candidates = [];
  for (const track of state.tracks) {
    for (const clip of track.clips) {
      if (clip.clipId === excludeClipId) continue;
      candidates.push(clip.timelineStart);
      candidates.push(clip.timelineStart + (clip.trimEnd - clip.trimStart));
    }
  }
  return candidates;
}

// targetに最も近いスナップ候補(グリッド or 他クリップの端)への補正量(秒)を返す。
// しきい値内に候補が無ければnullを返す。
function bestSnapDelta(target, edgeCandidates) {
  const thresholdSec = SNAP_PX_THRESHOLD / PX_PER_SEC;
  const candidates = edgeCandidates.concat([Math.round(target / GRID_SNAP_SEC) * GRID_SNAP_SEC]);

  let best = null;
  let bestDist = thresholdSec;
  for (const c of candidates) {
    if (c < 0) continue; // タイムラインは0秒以降のみ
    const dist = Math.abs(c - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = c - target;
    }
  }
  return best;
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
    const dur = clip.trimEnd - clip.trimStart;
    const snapCandidates = collectSnapCandidates(clip.clipId);

    function onMove(ev) {
      const dx = ev.clientX - startX;
      const deltaSec = dx / PX_PER_SEC;
      let newStart = Math.max(0, startTimelineStart + deltaSec);

      // クリップの開始端・終了端のどちらか近い方をスナップさせる
      const startDelta = bestSnapDelta(newStart, snapCandidates);
      const endDelta = bestSnapDelta(newStart + dur, snapCandidates);
      if (startDelta !== null && (endDelta === null || Math.abs(startDelta) <= Math.abs(endDelta))) {
        newStart += startDelta;
      } else if (endDelta !== null) {
        newStart += endDelta;
      }

      clip.timelineStart = Math.max(0, newStart);
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
    const snapCandidates = collectSnapCandidates(clip.clipId);

    function onMove(ev) {
      const dx = ev.clientX - startX;
      const deltaSec = dx / PX_PER_SEC;

      if (side === "left") {
        let newTrimStart = startTrimStart + deltaSec;
        newTrimStart = Math.max(0, Math.min(newTrimStart, startTrimEnd - 0.05));
        let actualDelta = newTrimStart - startTrimStart;
        let newTimelineStart = Math.max(0, startTimelineStart + actualDelta);

        // 左端(タイムライン上の開始位置)をスナップさせ、trimStartも整合を取り直す
        const snapDelta = bestSnapDelta(newTimelineStart, snapCandidates);
        if (snapDelta !== null) {
          newTimelineStart += snapDelta;
          actualDelta = newTimelineStart - startTimelineStart;
          newTrimStart = Math.max(0, Math.min(startTrimStart + actualDelta, startTrimEnd - 0.05));
          actualDelta = newTrimStart - startTrimStart;
          newTimelineStart = Math.max(0, startTimelineStart + actualDelta);
        }

        clip.trimStart = newTrimStart;
        clip.timelineStart = newTimelineStart;
      } else {
        let newTrimEnd = startTrimEnd + deltaSec;
        newTrimEnd = Math.min(clip.srcDuration, Math.max(newTrimEnd, startTrimStart + 0.05));

        // 右端(タイムライン上の終了位置)をスナップさせ、trimEndへ逆算する
        const newEndOnTimeline = clip.timelineStart + (newTrimEnd - clip.trimStart);
        const snapDelta = bestSnapDelta(newEndOnTimeline, snapCandidates);
        if (snapDelta !== null) {
          const snappedEndOnTimeline = newEndOnTimeline + snapDelta;
          let snappedTrimEnd = clip.trimStart + (snappedEndOnTimeline - clip.timelineStart);
          snappedTrimEnd = Math.min(clip.srcDuration, Math.max(snappedTrimEnd, startTrimStart + 0.05));
          newTrimEnd = snappedTrimEnd;
        }

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

// トラック1つ分の音源ファイルをサーバーから削除し、タイムラインからも取り除く
async function deleteTrackFile(track) {
  const fileId = track.clips[0]?.fileId;

  if (fileId) {
    if (!confirm(`「${track.label}」をサーバーから完全に削除します。よろしいですか?`)) {
      return;
    }
    setStatus(`削除中: ${track.label} ...`);
    try {
      const res = await fetch(`/api/uploads/${fileId}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus(`エラー: ${data.error || "削除に失敗しました"}`, true);
        return;
      }
    } catch (err) {
      setStatus(`通信エラー: ${err}`, true);
      return;
    }
    delete state.bufferCache[fileId];
  }

  if (track.clips.some((c) => c.clipId === state.selectedClipId)) {
    state.selectedClipId = null;
  }
  state.tracks = state.tracks.filter((t) => t.trackId !== track.trackId);

  setStatus(`削除しました: ${track.label}`);
  renderAll();
}

// サーバーに保存されている音源ファイルを(前回セッション分も含めて)まとめて削除する
el.clearUploadsBtn.addEventListener("click", async () => {
  if (!confirm("サーバーに保存されている音源ファイルを全て削除します。よろしいですか?\n(現在編集中のタイムラインも空になります)")) {
    return;
  }
  setStatus("音源を全削除中...");
  try {
    const res = await fetch("/api/uploads", { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setStatus(`エラー: ${data.error || "削除に失敗しました"}`, true);
      return;
    }
    stopPlayback();
    state.tracks = [];
    state.selectedClipId = null;
    state.bufferCache = {};
    setStatus(`削除しました(${data.deleted ?? 0}件)`);
    renderAll();
  } catch (err) {
    setStatus(`通信エラー: ${err}`, true);
  }
});

// ---------- 再生ヘッド / シーク ----------

function seekFromClientX(clientX, referenceEl) {
  const rect = referenceEl.getBoundingClientRect();
  const x = clientX - rect.left;
  let sec = Math.max(0, x / PX_PER_SEC);

  // グリッド(1秒刻み)や他クリップの端(カットでできた前後のパートなど)に近ければスナップさせる。
  // 「カット」は再生ヘッドの位置で行われるため、これによりカット位置もぴったり合わせられる。
  const snapDelta = bestSnapDelta(sec, collectSnapCandidates());
  if (snapDelta !== null) {
    sec = Math.max(0, sec + snapDelta);
  }

  state.playheadSec = sec;
  renderPlayheadOnly();
}

// ドラッグ中はクリップを再構築せず、再生ヘッドの位置だけ動かす(軽量・無段階)
function renderPlayheadOnly() {
  const playheadEl = document.getElementById("playheadEl");
  if (playheadEl) {
    playheadEl.style.left = `${LABEL_WIDTH + state.playheadSec * PX_PER_SEC}px`;
  }
  updateTimeDisplay(state.playheadSec);
}

// ルーラー、または再生ヘッドのつまみを押しながら動かす(スクラブ)ことで
// 無段階に再生ヘッドを移動できるようにする。
// triggerEl: mousedownを検知する要素 / referenceEl: 座標(秒)計算の基準にする要素
function attachScrub(triggerEl, referenceEl = triggerEl) {
  triggerEl.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (state.isPlaying) {
      stopPlayback();
    }
    seekFromClientX(e.clientX, referenceEl);

    function onMove(ev) {
      seekFromClientX(ev.clientX, referenceEl);
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

attachScrub(el.ruler);
// ---------- 再生 / 停止 ----------

function stopPlayback() {
  state.isPlaying = false;
  state.activeSources.forEach((source) => {
    try {
      source.stop();
    } catch (e) {
      // 既に再生を終えたノードのstop()はエラーになるだけなので無視してよい
    }
  });
  state.activeSources = [];
  if (state.rafId) cancelAnimationFrame(state.rafId);
  state.rafId = null;
}

el.playBtn.addEventListener("click", async () => {
  stopPlayback();
  const ctx = getAudioContext();
  state.isPlaying = true;
  const startPlayhead = state.playheadSec;

  // 再生対象のクリップを先に洗い出す
  const targets = [];
  for (const track of state.tracks) {
    for (const clip of track.clips) {
      const dur = clip.trimEnd - clip.trimStart;
      const clipStartT = clip.timelineStart;
      const clipEndT = clip.timelineStart + dur;
      if (clipEndT <= startPlayhead) continue; // 既に終わっている
      targets.push({ clip, clipStartT, clipEndT });
    }
  }

  if (targets.length === 0) {
    setStatus("再生できるクリップがありません", true);
    state.isPlaying = false;
    return;
  }

  // 全クリップの音声データを先に確保してから、まとめて同じ基準時刻でスケジュールする。
  // バラバラにawaitすると、クリップごとの再生開始タイミングがズレてカットした
  // 境目にノイズが生じるため。
  let buffers;
  try {
    buffers = await Promise.all(targets.map((t) => loadBuffer(t.clip.fileId, t.clip.url)));
  } catch (err) {
    setStatus(`音声の読み込みに失敗しました: ${err}`, true);
    state.isPlaying = false;
    return;
  }

  if (!state.isPlaying) return; // 読み込み待ちの間に停止/再クリックされていたら何もしない

  // 少し先の時刻を共通の基準にすることで、全クリップをサンプル単位でぴったり同期させる
  const baseWhen = ctx.currentTime + 0.05;
  state.playStartCtxTime = baseWhen;
  state._playStartSec = startPlayhead;

  targets.forEach(({ clip, clipStartT, clipEndT }, i) => {
    const source = ctx.createBufferSource();
    source.buffer = buffers[i];
    source.connect(ctx.destination);

    const offsetIntoClip = clip.trimStart + Math.max(0, startPlayhead - clipStartT);
    const startDelay = Math.max(0, clipStartT - startPlayhead);
    const playDuration = clipEndT - Math.max(clipStartT, startPlayhead);

    source.start(baseWhen + startDelay, offsetIntoClip, playDuration);
    state.activeSources.push(source);
  });

  setStatus("再生中...");
  tickPlayhead();
});

function tickPlayhead() {
  if (!state.isPlaying) return;
  const elapsed = Math.max(0, getAudioContext().currentTime - state.playStartCtxTime);
  const nowSec = state._playStartSec + elapsed;
  const playheadEl = document.getElementById("playheadEl");
  if (playheadEl) {
    playheadEl.style.left = `${LABEL_WIDTH + nowSec * PX_PER_SEC}px`;
  }
  updateTimeDisplay(nowSec);
  state.rafId = requestAnimationFrame(tickPlayhead);
}

el.stopBtn.addEventListener("click", () => {
  if (state.isPlaying) {
    const elapsed = Math.max(0, getAudioContext().currentTime - state.playStartCtxTime);
    state.playheadSec = state._playStartSec + elapsed;
  }
  stopPlayback();
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

  const fmt = el.formatSelect.value;

  // 対応ブラウザ(Chrome/Edgeなど)では、実際にミックスダウンする前に保存先を選んでもらう。
  // ここでキャンセルされた場合はサーバー側での処理自体を行わない。
  // 非対応ブラウザ(Firefox/Safariなど)では従来通りブラウザのダウンロード機能にお任せする。
  let saveHandle = null;
  if (window.showSaveFilePicker) {
    try {
      saveHandle = await window.showSaveFilePicker({
        suggestedName: `mix.${fmt}`,
        types: [
          {
            description: fmt === "mp3" ? "MP3音声" : "WAV音声",
            accept: { [fmt === "mp3" ? "audio/mpeg" : "audio/wav"]: [`.${fmt}`] },
          },
        ],
      });
    } catch (err) {
      if (err.name === "AbortError") {
        setStatus("書き出しをキャンセルしました");
      } else {
        setStatus(`保存先の選択に失敗しました: ${err}`, true);
      }
      return;
    }
  }

  setStatus("書き出し中...");
  try {
    const res = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clips, format: fmt }),
    });
    const data = await res.json();
    if (!res.ok) {
      setStatus(`エラー: ${data.error || "書き出しに失敗しました"}`, true);
      return;
    }

    // サーバー上の書き出し結果をこちらで完全に取得してから保存する。
    // (保存方法によらず、取得が終わった時点でサーバー側の一時ファイルを削除できるようにするため)
    const blob = await (await fetch(data.url)).blob();

    if (saveHandle) {
      const writable = await saveHandle.createWritable();
      await writable.write(blob);
      await writable.close();
      setStatus("書き出し完了。指定した保存先に保存しました。");
    } else {
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = data.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(blobUrl);
      setStatus("書き出し完了。ダウンロードを開始します。");
    }

    // ダウンロード(取得)が完了したので、サーバー上に溜まっていく書き出しファイルは削除しておく
    fetch(`/api/exports/${encodeURIComponent(data.filename)}`, { method: "DELETE" }).catch((err) => {
      console.warn("書き出しファイルのサーバー側削除に失敗しました", err);
    });
  } catch (err) {
    setStatus(`書き出しに失敗しました: ${err}`, true);
  }
});

// 初期描画
renderAll();