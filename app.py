"""
マルチトラック音声エディタ - Flaskバックエンド

機能:
  - 複数音声ファイルのアップロード（トラック化）
  - タイムライン情報(開始位置・トリム範囲)に基づくミックスダウン書き出し
    (トリミング / カット / 結合はフロントエンド側で非破壊的に管理し、
     書き出し時にpydubで実際の音声処理を行う)

事前準備:
  pip install -r requirements.txt
  ffmpeg がシステムにインストールされている必要があります
    - macOS: brew install ffmpeg
    - Ubuntu/Debian: sudo apt install ffmpeg
    - Windows: https://ffmpeg.org/download.html からダウンロードしPATHに追加

起動:
  python app.py
  ブラウザで http://127.0.0.1:5000 を開く
"""

import os
import uuid

from flask import Flask, request, jsonify, send_from_directory, render_template
from pydub import AudioSegment

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
EXPORT_DIR = os.path.join(BASE_DIR, "exports")
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(EXPORT_DIR, exist_ok=True)

ALLOWED_EXT = {"mp3", "wav", "ogg", "m4a", "flac", "aac", "wma"}
MAX_CONTENT_LENGTH = 300 * 1024 * 1024  # 300MB

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_CONTENT_LENGTH


def allowed_file(filename: str) -> bool:
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXT


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/upload", methods=["POST"])
def upload():
    if "file" not in request.files:
        return jsonify({"error": "ファイルがありません"}), 400

    f = request.files["file"]
    if f.filename == "" or not allowed_file(f.filename):
        return jsonify({"error": "対応していないファイル形式です"}), 400

    ext = f.filename.rsplit(".", 1)[1].lower()
    file_id = uuid.uuid4().hex
    saved_name = f"{file_id}.{ext}"
    path = os.path.join(UPLOAD_DIR, saved_name)
    f.save(path)

    try:
        audio = AudioSegment.from_file(path)
    except Exception as e:  # noqa: BLE001
        os.remove(path)
        return jsonify({"error": f"音声を読み込めませんでした: {e}"}), 400

    duration = len(audio) / 1000.0  # 秒

    return jsonify(
        {
            "id": file_id,
            "ext": ext,
            "filename": f.filename,
            "url": f"/uploads/{saved_name}",
            "duration": duration,
        }
    )


@app.route("/uploads/<path:filename>")
def serve_upload(filename):
    return send_from_directory(UPLOAD_DIR, filename)


@app.route("/exports/<path:filename>")
def serve_export(filename):
    return send_from_directory(EXPORT_DIR, filename, as_attachment=True)


@app.route("/api/exports/<filename>", methods=["DELETE"])
def delete_export(filename):
    for name in os.listdir(EXPORT_DIR):
        if name == filename:
            os.remove(os.path.join(EXPORT_DIR, name))
            return jsonify({"ok": True})
    return jsonify({"error": "ファイルが見つかりません"}), 404


@app.route("/api/uploads/<file_id>", methods=["DELETE"])
def delete_upload(file_id):
    deleted = False
    for name in os.listdir(UPLOAD_DIR):
        if name.rsplit(".", 1)[0] == file_id:
            os.remove(os.path.join(UPLOAD_DIR, name))
            deleted = True
            break
    if not deleted:
        return jsonify({"error": "ファイルが見つかりません"}), 404
    return jsonify({"ok": True})


@app.route("/api/uploads", methods=["DELETE"])
def delete_all_uploads():
    count = 0
    for name in os.listdir(UPLOAD_DIR):
        path = os.path.join(UPLOAD_DIR, name)
        if os.path.isfile(path):
            os.remove(path)
            count += 1
    return jsonify({"ok": True, "deleted": count})


@app.route("/api/export", methods=["POST"])
def export():
    """
    リクエストJSON形式:
    {
      "format": "wav" | "mp3",
      "clips": [
        {
          "fileId": "...",
          "ext": "mp3",
          "trimStart": 0.0,      # 元ファイル内での開始秒
          "trimEnd": 5.2,        # 元ファイル内での終了秒
          "timelineStart": 3.0   # タイムライン上での開始秒
        },
        ...
      ]
    }
    """
    data = request.get_json(force=True, silent=True) or {}
    clips = data.get("clips", [])
    fmt = data.get("format", "wav")
    if fmt not in {"wav", "mp3"}:
        fmt = "wav"

    if not clips:
        return jsonify({"error": "クリップがありません"}), 400

    loaded = []  # [(timeline_start_ms, clip_audio), ...] トリム済み・サンプリングレート未統一のクリップ

    for c in clips:
        file_id = c.get("fileId")
        ext = c.get("ext")
        path = os.path.join(UPLOAD_DIR, f"{file_id}.{ext}")
        if not file_id or not ext or not os.path.exists(path):
            return jsonify({"error": f"ファイルが見つかりません: {file_id}"}), 400

        audio = AudioSegment.from_file(path)
        src_len_ms = len(audio)

        trim_start_ms = max(0, int(float(c.get("trimStart", 0)) * 1000))
        trim_end_ms = int(float(c.get("trimEnd", src_len_ms / 1000)) * 1000)
        trim_end_ms = min(trim_end_ms, src_len_ms)
        if trim_end_ms <= trim_start_ms:
            continue  # 空クリップはスキップ

        clip_audio = audio[trim_start_ms:trim_end_ms]

        timeline_start_ms = max(0, int(float(c.get("timelineStart", 0)) * 1000))
        loaded.append((timeline_start_ms, clip_audio))

    if not loaded:
        return jsonify({"error": "有効なクリップがありません"}), 400

    # ---- サンプリングレートの統一 ----
    # 各クリップの元ファイルはサンプリングレートがバラバラな場合がある。統一しないまま
    # overlay()を繰り返すと、pydubが重ね合わせのたびに暗黙的・段階的にリサンプリングし、
    # クリップの並び順次第で音質が変わってしまう。ここで明示的に単一のターゲットレート
    # （今回のクリップ群のうち最大の値）へ揃えてからミックスすることで、不要なダウン
    # サンプリングを避けつつ一貫した音質にする。
    target_frame_rate = max(clip_audio.frame_rate for _, clip_audio in loaded)
    segments = [
        (start_ms, clip_audio.set_frame_rate(target_frame_rate))
        for start_ms, clip_audio in loaded
    ]
    total_end_ms = max(start_ms + len(clip_audio) for start_ms, clip_audio in segments)

    mix = AudioSegment.silent(duration=total_end_ms, frame_rate=target_frame_rate)
    for start_ms, clip_audio in segments:
        mix = mix.overlay(clip_audio, position=start_ms)

    out_name = f"mix_{uuid.uuid4().hex}.{fmt}"
    out_path = os.path.join(EXPORT_DIR, out_name)
    mix.export(out_path, format=fmt)

    return jsonify({"url": f"/exports/{out_name}", "filename": out_name})


if __name__ == "__main__":
    app.run(debug=True, port=5000)