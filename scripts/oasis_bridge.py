import base64
import json
import os
import sys
import threading
import time
from io import BytesIO


def emit(payload):
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def read_json_line():
    line = sys.stdin.readline()
    if not line:
        return None
    return json.loads(line)


try:
    from decart_oasis import A2VClient
except Exception as exc:
    emit({
        "type": "error",
        "code": "missing_decart_oasis",
        "message": "Python-Paket decart-oasis fehlt. Installiere es mit: pip install -r requirements-oasis.txt",
        "detail": str(exc),
    })
    sys.exit(2)


try:
    from PIL import Image
except Exception:
    Image = None


state_lock = threading.Lock()
latest_control = {"throttle": 0.0, "steering": 0.0}
stop_event = threading.Event()


def stdin_loop():
    while not stop_event.is_set():
        try:
            msg = read_json_line()
        except Exception as exc:
            emit({"type": "error", "code": "bad_stdin", "message": str(exc)})
            stop_event.set()
            return
        if msg is None:
            stop_event.set()
            return

        msg_type = msg.get("type")
        if msg_type == "stop":
            stop_event.set()
            return
        if msg_type == "control":
            with state_lock:
                latest_control["throttle"] = max(-1.0, min(1.0, float(msg.get("throttle") or 0.0)))
                latest_control["steering"] = max(-1.0, min(1.0, float(msg.get("steering") or 0.0)))


def encode_frame(frame):
    height = int(frame.shape[0])
    width = int(frame.shape[1])

    if Image is not None:
        buffer = BytesIO()
        image = Image.fromarray(frame, "RGB")
        image.save(buffer, format="JPEG", quality=int(os.environ.get("OASIS_JPEG_QUALITY", "78")))
        return {
            "encoding": "jpeg",
            "mime": "image/jpeg",
            "width": width,
            "height": height,
            "data": base64.b64encode(buffer.getvalue()).decode("ascii"),
        }

    raw = frame.tobytes() if hasattr(frame, "tobytes") else bytes(frame)
    return {
        "encoding": "rgb",
        "mime": "application/octet-stream",
        "width": width,
        "height": height,
        "data": base64.b64encode(raw).decode("ascii"),
    }


def main():
    first = read_json_line()
    if not first or first.get("type") != "start":
        emit({"type": "error", "code": "bad_start", "message": "Startnachricht fehlt."})
        return 1

    prompt = str(first.get("prompt") or "").strip()
    if not prompt:
        emit({"type": "error", "code": "missing_prompt", "message": "Prompt fehlt."})
        return 1
    if not os.environ.get("DECART_API_KEY"):
        emit({"type": "error", "code": "missing_api_key", "message": "DECART_API_KEY fehlt."})
        return 1

    frames_per_chunk = max(1, min(4, int(os.environ.get("OASIS_FRAMES_PER_CHUNK", "4"))))
    stream_name = os.environ.get("OASIS_STREAM", "front")

    reader = threading.Thread(target=stdin_loop, daemon=True)
    reader.start()

    emit({"type": "status", "state": "connecting", "message": "Verbinde mit Decart Oasis 3..."})
    try:
        with A2VClient() as client:
            advertised = [stream.name for stream in client.streams]
            emit({"type": "status", "state": "connected", "message": ",".join(advertised)})
            client.prompt(prompt)
            emit({"type": "status", "state": "prompted", "message": "Szene ist bereit."})

            while not stop_event.is_set():
                with state_lock:
                    throttle = latest_control["throttle"]
                    steering = latest_control["steering"]
                actions = [[throttle, steering]] * 4
                result = client.infer(actions)
                frames = result.frames.get(stream_name) or result.frames.get("front") or next(iter(result.frames.values()))
                selected = frames[-frames_per_chunk:]
                for offset, frame in enumerate(selected):
                    if stop_event.is_set():
                        break
                    encoded = encode_frame(frame)
                    encoded.update({
                        "type": "frame",
                        "sequence": int(result.sequence_num),
                        "frame": offset,
                    })
                    emit(encoded)
                time.sleep(float(os.environ.get("OASIS_LOOP_SLEEP", "0.01")))
    except Exception as exc:
        emit({
            "type": "error",
            "code": exc.__class__.__name__,
            "message": str(exc) or "Oasis-Fehler",
        })
        return 1
    finally:
        stop_event.set()
    return 0


if __name__ == "__main__":
    sys.exit(main())
