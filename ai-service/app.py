from flask import Flask, request, jsonify
from flask_cors import CORS
import os
import cv2
import numpy as np
from uuid import uuid4
import math
import traceback
import json
import atexit

app = Flask(__name__)
CORS(app)

# Optional advanced face detection / recognition using insightface
HAS_INSIGHTFACE = False
face_app = None

# Optional FAISS for fast nearest neighbor search
HAS_FAISS = False
faiss_index = None
faiss_meta = []
FAISS_INDEX_PATH = 'faiss.index'
FAISS_META_PATH = 'faiss_meta.json'
try:
    import faiss
    HAS_FAISS = True
except Exception:
    HAS_FAISS = False

# Optional MediaPipe lightweight detector (fallback when insightface not available)
HAS_MEDIAPIPE = False
mp_face = None


def _init_optional_models():
    global HAS_INSIGHTFACE, face_app, HAS_MEDIAPIPE, mp_face
    if HAS_INSIGHTFACE and face_app is not None:
        return

    try:
        from insightface.app import FaceAnalysis
        face_app = FaceAnalysis(allowed_modules=['detection', 'recognition'])
        face_app.prepare(ctx_id=-1, det_size=(640, 640))
        HAS_INSIGHTFACE = True
    except Exception:
        HAS_INSIGHTFACE = False
        face_app = None

    try:
        import mediapipe as mp
        HAS_MEDIAPIPE = True
        mp_face = mp.solutions.face_detection
    except Exception:
        HAS_MEDIAPIPE = False
        mp_face = None

def _save_faiss():
    try:
        if HAS_FAISS and faiss_index is not None:
            faiss.write_index(faiss_index, FAISS_INDEX_PATH)
            with open(FAISS_META_PATH, 'w', encoding='utf-8') as f:
                json.dump(faiss_meta, f)
    except Exception:
        traceback.print_exc()

def _load_faiss():
    global faiss_index, faiss_meta
    try:
        if HAS_FAISS and os.path.exists(FAISS_INDEX_PATH) and os.path.exists(FAISS_META_PATH):
            faiss_index = faiss.read_index(FAISS_INDEX_PATH)
            with open(FAISS_META_PATH, 'r', encoding='utf-8') as f:
                faiss_meta = json.load(f)
    except Exception:
        traceback.print_exc()

_load_faiss()
atexit.register(_save_faiss)

# Detection / quality thresholds (tune on your dataset)
DET_CONF = 0.5
MIN_FACE_PX_RATIO = 0.12
MIN_FACE_PX_ABS = 80
# We keep warning thresholds reasonably high, but only reject on extreme values
BLUR_WARN = 40.0
BLUR_REJECT_EXTREME = 5.0
CONTRAST_WARN = 20.0
CONTRAST_REJECT_EXTREME = 3.0


def _temp_file_path(prefix, filename):
    return f"{prefix}_{uuid4().hex}_{filename or 'upload.jpg'}"


def _cleanup_file(path):
    if path and os.path.exists(path):
        os.remove(path)


def _is_blurry(face_img, threshold=75.0):
    if face_img is None or face_img.size == 0:
        return True, 0.0
    gray = cv2.cvtColor(face_img, cv2.COLOR_BGR2GRAY)
    fm = cv2.Laplacian(gray, cv2.CV_64F).var()
    return fm < threshold, fm


def _is_low_contrast(face_img, threshold=20.0):
    if face_img is None or face_img.size == 0:
        return True, 0.0
    gray = cv2.cvtColor(face_img, cv2.COLOR_BGR2GRAY)
    std_dev = gray.std()
    return std_dev < threshold, std_dev


def _auto_gamma_correction(img, target_mean=100):
    # simple gamma correction to move mean brightness towards target_mean
    if img is None or img.size == 0:
        return img
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    v = hsv[:, :, 2]
    mean = np.mean(v)
    if mean <= 0:
        return img
    gamma = math.log(target_mean / 255.0) / math.log(mean / 255.0) if mean != target_mean else 1.0
    gamma = max(0.5, min(2.2, gamma))
    invGamma = 1.0 / gamma
    table = np.array([((i / 255.0) ** invGamma) * 255 for i in np.arange(0, 256)]).astype('uint8')
    return cv2.LUT(img, table)


def _apply_clahe(img):
    # apply CLAHE on the luminance channel in Lab space
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    cl = clahe.apply(l)
    limg = cv2.merge((cl, a, b))
    return cv2.cvtColor(limg, cv2.COLOR_LAB2BGR)


def _denoise(img):
    try:
        return cv2.fastNlMeansDenoisingColored(img, None, 10, 10, 7, 21)
    except Exception:
        return img


def _laplacian_variance(img_gray):
    return cv2.Laplacian(img_gray, cv2.CV_64F).var()


def _normalize_and_resize(img, size=(112, 112)):
    # Resize, convert to RGB, and return
    resized = cv2.resize(img, size, interpolation=cv2.INTER_AREA)
    if len(resized.shape) == 2:
        resized = cv2.cvtColor(resized, cv2.COLOR_GRAY2BGR)
    return resized


def _validate_face_quality(img, x, y, w, h):
    img_h, img_w = img.shape[:2]
    x1, y1 = max(0, x), max(0, y)
    x2, y2 = min(img_w, x + w), min(img_h, y + h)
    
    face_img = img[y1:y2, x1:x2]
    if face_img.size == 0:
        return False, "Detected face region is empty."
        
    face_w, face_h = x2 - x1, y2 - y1
    if face_w < 50 or face_h < 50:
        return False, f"The face in the image is too small or low-resolution ({face_w}x{face_h}px). Please upload a high-quality close-up photo."

    # Tolerant validation: reject only on extreme unreadable images.
    is_blurry_flag, fm = _is_blurry(face_img, threshold=BLUR_WARN)
    if fm < BLUR_REJECT_EXTREME:
        return False, f"The face in the image is extremely blurry or unreadable (sharpness score: {fm:.1f})."

    is_low_c, std_dev = _is_low_contrast(face_img, threshold=CONTRAST_WARN)
    if std_dev < CONTRAST_REJECT_EXTREME:
        return False, f"The image contrast is extremely low ({std_dev:.1f}); the image appears unreadable."

    # Otherwise accept; minor blur/contrast issues are tolerated.
    return True, None


def _face_boxes_from_path(img_path):
    _init_optional_models()
    img = cv2.imread(img_path)
    if img is None:
        return img, []
    try:
        if HAS_INSIGHTFACE and face_app is not None:
            faces = face_app.get(img)
            boxes = []
            for f in faces:
                x1, y1, x2, y2 = int(f.bbox[0]), int(f.bbox[1]), int(f.bbox[2]), int(f.bbox[3])
                boxes.append((x1, y1, x2 - x1, y2 - y1))
            return img, boxes
    except Exception:
        # fall through to OpenCV fallback
        traceback.print_exc()

    # Try MediaPipe if available (lighter weight, often more accurate than Haar cascades)
    try:
        if HAS_MEDIAPIPE and mp_face is not None:
            with mp_face.FaceDetection(model_selection=1, min_detection_confidence=0.4) as detector:
                img_rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
                results = detector.process(img_rgb)
                boxes = []
                if results.detections:
                    h, w = img.shape[:2]
                    for d in results.detections:
                        loc = d.location_data.relative_bounding_box
                        x = int(loc.xmin * w)
                        y = int(loc.ymin * h)
                        bw = int(loc.width * w)
                        bh = int(loc.height * h)
                        boxes.append((x, y, bw, bh))
                if boxes:
                    return img, boxes
    except Exception:
        traceback.print_exc()

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
    boxes = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=4, minSize=(30, 30))
    return img, boxes



def _opencv_embedding(img_path):
    _init_optional_models()
    img, boxes = _face_boxes_from_path(img_path)
    if img is None:
        raise ValueError("Could not read image")
    # If insightface is available, prefer its embeddings
    try:
        if HAS_INSIGHTFACE and face_app is not None:
            faces = face_app.get(img)
            if faces and len(faces) > 0:
                # pick primary
                f = faces[0]
                emb = getattr(f, 'embedding', None)
                if emb is not None:
                    vec = np.array(emb, dtype=np.float32)
                    # normalize
                    n = np.linalg.norm(vec) or 1.0
                    return (vec / n).tolist()
    except Exception:
        traceback.print_exc()

    if len(boxes) > 0:
        x, y, w, h = boxes[0]
        roi = img[y:y + h, x:x + w]
    else:
        roi = img

    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    resized = cv2.resize(gray, (64, 64), interpolation=cv2.INTER_AREA)
    normalized = resized.astype(np.float32) / 255.0
    return normalized.flatten().tolist()


def _cosine_similarity(vec_a, vec_b):
    a = np.array(vec_a, dtype=np.float32)
    b = np.array(vec_b, dtype=np.float32)
    denom = (np.linalg.norm(a) * np.linalg.norm(b))
    if denom == 0:
        return 0.0
    return float(np.dot(a, b) / denom)


# ============================================================
#  FAISS / Indexing endpoints
# ============================================================
@app.route('/index-add', methods=['POST'])
def index_add():
    try:
        data = request.get_json() or {}
        pid = data.get('id')
        emb = data.get('embedding')
        if not pid or not emb:
            return jsonify({'error': 'id and embedding required'}), 400

        vec = np.array(emb, dtype=np.float32)
        # normalize for cosine similarity using inner product
        n = np.linalg.norm(vec) or 1.0
        vec = (vec / n).astype('float32')

        if HAS_FAISS:
            global faiss_index, faiss_meta
            d = vec.shape[0]
            if faiss_index is None:
                faiss_index = faiss.IndexFlatIP(d)
                faiss_meta = []
            faiss_index.add(np.expand_dims(vec, axis=0))
            faiss_meta.append({'id': pid})
            _save_faiss()
            return jsonify({'ok': True, 'indexed': True})
        else:
            # fallback: persist to meta list in file
            faiss_meta.append({'id': pid, 'embedding': vec.tolist()})
            with open(FAISS_META_PATH, 'w', encoding='utf-8') as f:
                json.dump(faiss_meta, f)
            return jsonify({'ok': True, 'indexed': False, 'note': 'faiss not available, stored meta'})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/index-search', methods=['POST'])
def index_search():
    try:
        data = request.get_json() or {}
        emb = data.get('embedding')
        k = int(data.get('k') or 5)
        if not emb:
            return jsonify({'error': 'embedding required'}), 400
        vec = np.array(emb, dtype=np.float32)
        n = np.linalg.norm(vec) or 1.0
        vec = (vec / n).astype('float32')

        if HAS_FAISS and faiss_index is not None and faiss_index.ntotal > 0:
            D, I = faiss_index.search(np.expand_dims(vec, axis=0), k)
            results = []
            for dist, idx in zip(D[0].tolist(), I[0].tolist()):
                if idx < 0 or idx >= len(faiss_meta):
                    continue
                meta = faiss_meta[idx]
                results.append({ 'id': meta.get('id'), 'similarity': float(dist) })
            return jsonify({'results': results})
        else:
            # fallback linear search
            candidates = []
            if os.path.exists(FAISS_META_PATH):
                with open(FAISS_META_PATH, 'r', encoding='utf-8') as f:
                    try:
                        items = json.load(f)
                    except Exception:
                        items = faiss_meta
            else:
                items = faiss_meta

            for it in items:
                other_emb = it.get('embedding') or it.get('vec')
                if not other_emb:
                    continue
                sim = _cosine_similarity(vec, np.array(other_emb, dtype=np.float32))
                candidates.append({'id': it.get('id'), 'similarity': float(sim)})

            candidates.sort((lambda a, b: -1 if a['similarity'] > b['similarity'] else 1))
            return jsonify({'results': candidates[:k]})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


# Mock database of embeddings for demonstration if DB not connected directly here
# In production, this service would fetch known embeddings from the DB or a vector DB
# Here we will receive an image and return its embedding, or compare two images.

@app.route('/health', methods=['GET'])
def health():
    return jsonify({"status": "AI Service Operational"})


@app.route('/', methods=['GET'])
def root():
    return jsonify({
        "service": "AI Service",
        "status": "ok",
        "health": "/health",
        "endpoints": ["/generate-embedding", "/validate-face", "/validate-id", "/verify"]
    })

@app.route('/generate-embedding', methods=['POST'])
def generate_embedding():
    _init_optional_models()
    if 'image' not in request.files:
        return jsonify({"error": "No image provided"}), 400
    
    file = request.files['image']
    temp_path = _temp_file_path("temp", file.filename)
    file.save(temp_path)
    
    try:
        # Prefer insightface embeddings when available, else try DeepFace, else fallback to opencv-based descriptor
        img = cv2.imread(temp_path)
        if img is None:
            return jsonify({"error": "Could not read uploaded image"}), 400

        try:
            if HAS_INSIGHTFACE and face_app is not None:
                faces = face_app.get(img)
                if faces and len(faces) > 0:
                    emb = getattr(faces[0], 'embedding', None)
                    if emb is not None:
                        vec = np.array(emb, dtype=np.float32)
                        n = np.linalg.norm(vec) or 1.0
                        return jsonify({"embedding": (vec / n).tolist(), "model": "insightface"})
        except Exception:
            traceback.print_exc()

        try:
            from deepface import DeepFace
            embedding = DeepFace.represent(img_path=temp_path, model_name="Facenet", enforce_detection=False)[0]["embedding"]
            return jsonify({"embedding": embedding, "model": "deepface-facenet"})
        except Exception:
            embedding = _opencv_embedding(temp_path)
            return jsonify({"embedding": embedding, "model": "opencv-fallback"})
    except Exception as e:
        return jsonify({"error": "AI backend error: " + str(e)}), 500
    finally:
        _cleanup_file(temp_path)

@app.route('/verify', methods=['POST'])
def verify_face():
    # Compare uploaded image against a list of candidate images (paths)
    data = request.json
    img_path_1 = data.get('img1_path')  # This would need to be accessible path
    img_path_2 = data.get('img2_path')
    
    try:
        try:
            from deepface import DeepFace
            result = DeepFace.verify(img1_path=img_path_1, img2_path=img_path_2, model_name="Facenet")
            return jsonify(result)
        except Exception:
            emb1 = _opencv_embedding(img_path_1)
            emb2 = _opencv_embedding(img_path_2)
            similarity = _cosine_similarity(emb1, emb2)
            return jsonify({
                "verified": similarity >= 0.75,
                "distance": 1.0 - similarity,
                "similarity": similarity,
                "model": "opencv-fallback"
            })
    except Exception as e:
        return jsonify({"error": "AI backend error: " + str(e)}), 500


# ============================================================
#  VALIDATE FACE — Ensures uploaded photo contains a human face
#  Used by the Report Missing Person form
# ============================================================
@app.route('/validate-face', methods=['POST'])
def validate_face():
    _init_optional_models()
    if 'image' not in request.files:
        return jsonify({"error": "No image provided"}), 400
    
    file = request.files['image']
    temp_path = _temp_file_path("temp_face", file.filename)
    file.save(temp_path)
    
    try:
        img = cv2.imread(temp_path)
        if img is None:
            return jsonify({
                "is_human_face": False,
                "confidence": 0.0,
                "faces_detected": 0,
                "reason": "Could not read the uploaded file as an image",
                "detector": "quality-checker"
            })

        detector_name = 'opencv-fallback'
        faces = []
        try:
            if HAS_INSIGHTFACE and face_app is not None:
                dets = face_app.get(img)
                detector_name = 'insightface'
                for f in dets:
                    bbox = [int(v) for v in f.bbox]
                    score = float(getattr(f, 'det_score', 0.0) or 0.0)
                    faces.append({
                        'bbox': bbox,
                        'score': score,
                        'kps': getattr(f, 'kps', None),
                        'embedding': getattr(f, 'embedding', None)
                    })
        except Exception:
            traceback.print_exc()

        if not faces:
            # fallback detection
            _, detects = _face_boxes_from_path(temp_path)
            detector_name = 'opencv-fallback'
            for b in detects:
                x, y, w, h = int(b[0]), int(b[1]), int(b[2]), int(b[3])
                faces.append({'bbox': [x, y, x + w, y + h], 'score': 0.0, 'kps': None, 'embedding': None})

        faces_detected = len(faces)
        img_h, img_w = img.shape[:2]
        min_face_px = max(MIN_FACE_PX_ABS, int(MIN_FACE_PX_RATIO * min(img_w, img_h)))

        # filter by score and size
        filtered = []
        for f in faces:
            x1, y1, x2, y2 = f['bbox'][0], f['bbox'][1], f['bbox'][2], f['bbox'][3]
            w = max(0, x2 - x1)
            h = max(0, y2 - y1)
            area = w * h
            size_ok = (w >= min_face_px and h >= min_face_px)
            score_ok = (f.get('score', 0.0) >= DET_CONF)
            if size_ok or score_ok:
                filtered.append({**f, 'w': w, 'h': h, 'area': area})

        if not filtered:
            return jsonify({
                'is_human_face': False,
                'confidence': 0.0,
                'faces_detected': faces_detected,
                'reason': 'No clear face detected (face too small or low confidence). Try a closer crop or higher-resolution photo.',
                'detector': detector_name
            })

        # pick primary by largest area and closeness to center
        cx, cy = img_w / 2.0, img_h / 2.0
        def score_primary(f):
            center_x = (f['bbox'][0] + f['bbox'][2]) / 2.0
            center_y = (f['bbox'][1] + f['bbox'][3]) / 2.0
            dist = math.hypot(center_x - cx, center_y - cy)
            # prefer larger and more centered faces
            return f['area'] - (dist * 2.0)

        filtered.sort(key=score_primary, reverse=True)
        primary = filtered[0]

        # count large faces
        large_faces = [f for f in filtered if f['w'] >= min_face_px and f['h'] >= min_face_px]

        # crop primary face with a small margin
        x1, y1, x2, y2 = primary['bbox'][0], primary['bbox'][1], primary['bbox'][2], primary['bbox'][3]
        pad_w = int(max(10, 0.15 * (x2 - x1)))
        pad_h = int(max(10, 0.15 * (y2 - y1)))
        sx, sy = max(0, x1 - pad_w), max(0, y1 - pad_h)
        ex, ey = min(img_w, x2 + pad_w), min(img_h, y2 + pad_h)
        face_crop = img[sy:ey, sx:ex]

        # preprocessing
        face_proc = _auto_gamma_correction(face_crop)
        face_proc = _apply_clahe(face_proc)
        face_proc = _denoise(face_proc)
        gray = cv2.cvtColor(face_proc, cv2.COLOR_BGR2GRAY)
        blur_metric = _laplacian_variance(gray)
        contrast_metric = gray.std()

        # Tolerant handling: only reject on extreme unreadable metrics; otherwise return warnings
        warnings = []
        if blur_metric < BLUR_REJECT_EXTREME:
            return jsonify({
                'is_human_face': False,
                'confidence': 0.0,
                'faces_detected': faces_detected,
                'reason': 'Uploaded image is extremely blurry and unreadable. Please provide a clearer photo.',
                'detector': detector_name,
                'ai': {'blur': blur_metric, 'contrast': contrast_metric}
            })
        elif blur_metric < BLUR_WARN:
            warnings.append(f'The face appears somewhat blurry (sharpness: {blur_metric:.1f}); matching may be less accurate.')

        if contrast_metric < CONTRAST_REJECT_EXTREME:
            return jsonify({
                'is_human_face': False,
                'confidence': 0.0,
                'faces_detected': faces_detected,
                'reason': 'Uploaded image has extremely low contrast and appears unreadable. Please provide a clearer photo.',
                'detector': detector_name,
                'ai': {'blur': blur_metric, 'contrast': contrast_metric}
            })
        elif contrast_metric < CONTRAST_WARN:
            warnings.append(f'The image contrast is somewhat low (contrast: {contrast_metric:.1f}); consider improving lighting.')

        # build response; provide warnings rather than hard reject for multiple large faces
        multi_face_warning = None
        if len(large_faces) > 1:
            multi_face_warning = f'Multiple large faces detected ({len(large_faces)}). Primary face selected automatically; consider cropping to the missing person.'

        conf = float(primary.get('score', 0.0) or 0.9)
        combined_warning = None
        const_warnings = [w for w in warnings if w]
        if multi_face_warning:
            const_warnings.append(multi_face_warning)
        if const_warnings:
            combined_warning = ' '.join(const_warnings)

        return jsonify({
            'is_human_face': True,
            'confidence': conf,
            'faces_detected': faces_detected,
            'detector': detector_name,
            'warning': combined_warning,
            'ai': {'blur': blur_metric, 'contrast': contrast_metric, 'primary_box': primary['bbox']}
        })
        
    except Exception as e:
        return jsonify({"error": "Face validation error: " + str(e)}), 500
    finally:
        _cleanup_file(temp_path)



# ============================================================
#  VALIDATE ID — Checks if uploaded document is an official ID
#  Used by the Registration form for law enforcement / org roles
# ============================================================
@app.route('/validate-id', methods=['POST'])
def validate_id():
    if 'image' not in request.files:
        return jsonify({"error": "No image provided"}), 400
    
    file = request.files['image']
    temp_path = "temp_id_" + file.filename
    file.save(temp_path)
    
    try:
        # Read the image
        img = cv2.imread(temp_path)
        
        if img is None:
            os.remove(temp_path)
            return jsonify({
                "is_valid_id": False,
                "reason": "Could not read the uploaded file as an image"
            })
        
        height, width = img.shape[:2]
        aspect_ratio = width / height if height > 0 else 0
        
        # Convert to grayscale for analysis
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        
        # ── ID Document Heuristics ──
        # An ID card/document typically has:
        # 1. Rectangular aspect ratio (landscape or portrait card shape)
        # 2. Contains text regions (high edge density)
        # 3. Has structured layout (lines, borders)
        # 4. Contains a face photo region
        # 5. Not just a random photo of nature/objects
        
        is_valid = True
        document_type = "Official ID"
        confidence_score = 0.0
        
        # Check 1: Reasonable dimensions (not tiny, not extremely large aspect ratio)
        if width < 200 or height < 150:
            is_valid = False
        
        # Check 2: Aspect ratio — ID cards are typically between 1.2:1 and 2:1 (landscape)
        # or between 0.5:1 and 0.85:1 (portrait). Letters/docs can be taller.
        id_like_ratio = (0.5 <= aspect_ratio <= 2.2)
        if not id_like_ratio:
            is_valid = False
        
        # Check 3: Edge detection — ID documents have lots of text/lines
        edges = cv2.Canny(gray, 50, 150)
        edge_density = np.sum(edges > 0) / (width * height)
        
        # ID documents typically have 5-30% edge density (text, borders, etc.)
        has_text_structure = (0.04 <= edge_density <= 0.45)
        if not has_text_structure:
            is_valid = False
        
        # Check 4: Try to detect face in the document (many IDs have photo)
        face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
        faces = face_cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=4, minSize=(30, 30))
        has_face = len(faces) > 0
        
        # Check 5: Color distribution — ID cards are not solid colors or pure photos
        # They have mixed text/graphics regions
        hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
        saturation = hsv[:, :, 1]
        avg_saturation = np.mean(saturation)
        
        # Very high saturation = likely a colorful photo (not an ID)
        # Very low saturation = all grey (could be scan or not)
        
        # Calculate confidence
        confidence_factors = []
        
        if id_like_ratio:
            confidence_factors.append(0.25)
        if has_text_structure:
            confidence_factors.append(0.30)
        if has_face:
            confidence_factors.append(0.25)
            document_type = "Photo ID / Badge"
        if avg_saturation < 120:
            confidence_factors.append(0.10)
        if edge_density > 0.06:
            confidence_factors.append(0.10)
        
        confidence_score = sum(confidence_factors)
        
        # Final decision: need at least 0.55 confidence
        # Must have text structure at minimum
        if confidence_score < 0.55 or not has_text_structure:
            is_valid = False
        
        # Determine document type
        if has_face and has_text_structure:
            document_type = "Photo ID / Badge"
        elif has_text_structure and not has_face:
            document_type = "Authorization Letter / Document"
        
        os.remove(temp_path)
        
        return jsonify({
            "is_valid_id": is_valid,
            "confidence": round(confidence_score, 2),
            "document_type": document_type if is_valid else None,
            "reason": None if is_valid else "The uploaded image does not appear to be a valid official ID document or authorization letter"
        })
        
    except Exception as e:
        if os.path.exists(temp_path):
            os.remove(temp_path)
        return jsonify({"error": "ID validation error: " + str(e)}), 500


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 5001)), debug=False)
