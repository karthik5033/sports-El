import cv2
import mediapipe as mp
from mediapipe.tasks import python
from mediapipe.tasks.python import vision
import os
import time
import math
import threading
import queue
import pyttsx3
import json
import sys
import base64

# --- Stdout JSON emitter (read by Node.js server) ---
_emit_lock = threading.Lock()
def _emit(data):
    with _emit_lock:
        sys.stdout.write(json.dumps(data) + "\n")
        sys.stdout.flush()

# --- TTS Engine ---
class TTSManager:
    def __init__(self):
        self.q = queue.Queue()
        self.thread = threading.Thread(target=self._worker, daemon=True)
        self.thread.start()
        self.last_spoken = 0
        self.cooldown = 3.0 # seconds

    def _worker(self):
        import pythoncom
        pythoncom.CoInitialize()
        try:
            engine = pyttsx3.init()
            engine.setProperty('rate', 160)
        except Exception as e:
            print("TTS Init Error:", e)
            return

        while True:
            try:
                text = self.q.get()
                if text is None: break
                engine.say(text)
                engine.runAndWait()
                self.q.task_done()
            except Exception as e:
                print("TTS Speak Error:", e)
                try:
                    engine = pyttsx3.init()
                    engine.setProperty('rate', 160)
                except: pass

    def speak(self, text, force=False):
        now = time.time()
        
        # Prevent queue from building up unplayed messages
        if not force and self.q.qsize() > 0:
            return
            
        if force or (now - self.last_spoken > self.cooldown):
            _emit({"type": "speak", "text": text})
            self.last_spoken = now

tts = TTSManager()

# --- Session Manager ---
class SessionManager:
    def __init__(self, target_reps=10):
        self.target_reps = target_reps
        self.total_reps = 0
        self.correct_reps = 0
        self.incorrect_reps = 0
        self.current_rep_errors = set()
        self.completed = False
        self.last_rep_time = 0          # cooldown: prevent rapid false reps
        self.rep_cooldown = 0.5         # minimum seconds between reps
        self.pending_state = None
        self.pending_frames = 0
        self.confirmed_state = None
        self.frames_to_confirm = 5
        self.reached_depth = False      # True once user hits proper squat/lunge depth this rep
        
    def add_error(self, error_msg):
        self.current_rep_errors.add(error_msg)
    
    def try_transition(self, new_state):
        """Returns True only after new_state has been consistent for N frames."""
        if new_state == self.confirmed_state:
            self.pending_state = None
            self.pending_frames = 0
            return True  # already in this state
        if new_state == self.pending_state:
            self.pending_frames += 1
            if self.pending_frames >= self.frames_to_confirm:
                self.confirmed_state = new_state
                self.pending_state = None
                self.pending_frames = 0
                return True  # transition confirmed
            return False  # not yet confirmed
        else:
            # New candidate state
            self.pending_state = new_state
            self.pending_frames = 1
            return False
        
    def complete_rep(self, exercise_mode=""):
        now = time.time()
        if now - self.last_rep_time < self.rep_cooldown:
            return  # too soon — ignore (likely noise)
        self.last_rep_time = now
        
        self.total_reps += 1
        if len(self.current_rep_errors) == 0:
            self.correct_reps += 1
            # Mode-specific praise with rep count
            if exercise_mode == "SQUATS":
                tts.speak(f"Rep {self.total_reps}. Good squat! Keep it up.", force=True)
            elif exercise_mode == "STS":
                tts.speak(f"Rep {self.total_reps}. Good stand! Lower back down slowly.", force=True)
            elif exercise_mode == "LUNGES":
                tts.speak(f"Rep {self.total_reps}. Good lunge!", force=True)
            elif exercise_mode == "SHOULDER_ABD":
                tts.speak(f"Rep {self.total_reps}. Good raise! Lower arm slowly.", force=True)
            else:
                tts.speak(f"Rep {self.total_reps}. Good repetition.", force=True)
        else:
            self.incorrect_reps += 1
            # Mode-specific correction cue with rep count
            if exercise_mode == "SQUATS":
                tts.speak(f"Rep {self.total_reps} completed with errors. Go deeper and keep your back straight.", force=True)
            elif exercise_mode == "STS":
                tts.speak(f"Rep {self.total_reps} completed with errors. Stand fully upright and extend your hips.", force=True)
            elif exercise_mode == "LUNGES":
                tts.speak(f"Rep {self.total_reps} completed with errors. Keep your torso upright and front knee behind toes.", force=True)
            elif exercise_mode == "SHOULDER_ABD":
                tts.speak(f"Rep {self.total_reps} completed with errors. Keep your elbow straight and raise higher.", force=True)
            else:
                tts.speak(f"Rep {self.total_reps} completed with errors. Try to improve your form.", force=True)
            
        self.current_rep_errors.clear()
        
        if self.total_reps >= self.target_reps:
            self.completed = True

    def get_summary(self):
        score = 0
        if self.total_reps > 0:
            score = (self.correct_reps / self.total_reps) * 100
            
        if score >= 90: grade = "Excellent"
        elif score >= 70: grade = "Good"
        elif score >= 50: grade = "Average"
        else: grade = "Needs improvement"
        
        summary = (f"Exercise completed. You performed {self.total_reps} repetitions. "
                   f"{self.correct_reps} were correct and {self.incorrect_reps} need improvement. "
                   f"Overall performance: {grade}.")
        return summary

session = SessionManager(target_reps=10)

# _emit defined at top of file

# --- Pose logic functions ---
def calculate_angle(a, b, c):
    radians = math.atan2(c[1] - b[1], c[0] - b[0]) - math.atan2(a[1] - b[1], a[0] - b[0])
    angle = abs(radians * 180.0 / math.pi)
    if angle > 180.0: angle = 360 - angle
    return angle

script_dir = os.path.dirname(os.path.abspath(__file__))
model_path = os.path.join(script_dir, 'pose_landmarker_full.task')

base_options = python.BaseOptions(model_asset_path=model_path)
options = vision.PoseLandmarkerOptions(
    base_options=base_options,
    output_segmentation_masks=False,
    running_mode=vision.RunningMode.VIDEO)
detector = vision.PoseLandmarker.create_from_options(options)

POSE_CONNECTIONS = [(0, 1), (1, 2), (2, 3), (3, 7), (0, 4), (4, 5), (5, 6), (6, 8), (9, 10), (11, 12), (11, 13), (13, 15), (15, 17), (15, 19), (15, 21), (17, 19), (12, 14), (14, 16), (16, 18), (16, 20), (16, 22), (18, 20), (11, 23), (12, 24), (23, 24), (23, 25), (24, 26), (25, 27), (26, 28), (27, 29), (28, 30), (29, 31), (30, 32), (27, 31), (28, 32)]

# Force DirectShow backend for instant camera initialization on Windows
cap = None
# Window creation removed to integrate with UI

def init_mode(m, speak=True):
    global mode, state, session, summary_spoken, abd_states, abd_history, abd_fb_state
    mode = m
    state = "up" if m not in ["STS", "SHOULDER_ABD"] else ("sitting" if m == "STS" else "down")
    session = SessionManager(target_reps=10)
    summary_spoken = False
    abd_states = {}
    abd_history = {"l_sh": [], "r_sh": [], "l_el": [], "r_el": [], "torso": []}
    abd_fb_state = {"msg": "", "col": (0,255,0), "frames": 0, "last_spoken": ""}

    if speak:
        # Clear any pending TTS queue and reset cooldown so intro always plays
        while not tts.q.empty():
            try: tts.q.get_nowait()
            except: pass
        tts.last_spoken = 0  # reset cooldown so intro fires immediately

        if m == "SQUATS":
            tts.speak("Starting squats. Stand facing the camera. Feet shoulder-width apart, lower slowly.", force=True)
        elif m == "STS":
            tts.speak("Starting sit to stand. Use a chair. Push through your heels and stand tall.", force=True)
        elif m == "LUNGES":
            tts.speak("Starting lunges. Stand at a 45 degree angle so both legs are visible. Step forward with control.", force=True)
        elif m == "SHOULDER_ABD":
            tts.speak("Starting shoulder abduction. Raise both arms sideways to shoulder height.", force=True)

mode = "SQUATS"
abd_states = {}
current_set = 1
total_sets  = 1
init_mode(mode, speak=False)

active_session = False
camera_enabled = False

# --- Stdin reader: accepts JSON commands from Node.js ---
def _stdin_reader():
    global current_set, total_sets, active_session, camera_enabled
    while True:
        raw = sys.stdin.readline()
        if not raw:
            break
        raw = raw.strip()
        if not raw:
            continue
        try:
            cmd = json.loads(raw)
            t = cmd.get("type", "")
            if t == "config":
                m    = cmd.get("mode", mode)
                reps = int(cmd.get("reps", 10))
                sets = int(cmd.get("sets", 1))
                total_sets  = sets
                current_set = 1
                init_mode(m)
                session.target_reps = reps
                active_session = True
            elif t == "next_set":
                current_set = int(cmd.get("set", current_set))
                init_mode(mode)
                session.target_reps = int(cmd.get("reps", session.target_reps))
                active_session = True
            elif t == "stop":
                active_session = False
                # clear pending voice queues
                while not tts.q.empty():
                    try: tts.q.get_nowait()
                    except: pass
            elif t == "camera_toggle":
                camera_enabled = bool(cmd.get("enabled", False))
                if not camera_enabled:
                    # clear voice queues when camera turned off
                    while not tts.q.empty():
                        try: tts.q.get_nowait()
                        except: pass
        except Exception as e:
            pass

_t = threading.Thread(target=_stdin_reader, daemon=True)
_t.start()

# --- Warm-up inference to prevent delay on first start ---
import numpy as np
dummy_img = np.zeros((480, 640, 3), dtype=np.uint8)
dummy_rgb = cv2.cvtColor(dummy_img, cv2.COLOR_BGR2RGB)
mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=dummy_rgb)
try:
    detector.detect_for_video(mp_image, int(time.time() * 1000))
except: pass

while True:
    if not camera_enabled:
        if cap is not None:
            cap.release()
            cap = None
        time.sleep(0.1)
        continue

    # Camera is enabled: ensure cap is initialized
    if cap is None:
        cap = cv2.VideoCapture(0, cv2.CAP_DSHOW)
        if cap.isOpened():
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
        else:
            cap = None
            _emit({"type": "error", "message": "Failed to open webcam. Make sure it is not in use by another application."})
            camera_enabled = False
            time.sleep(1.0)
            continue

    success, img = cap.read()
    if not success:
        # Camera read failed or disconnected
        cap.release()
        cap = None
        time.sleep(1.0)
        continue

    h, w, c = img.shape
    
    if not active_session:
        # If camera is enabled but no session is active, still stream raw frames to preview (if UI supports it)
        _, buffer = cv2.imencode('.jpg', img, [int(cv2.IMWRITE_JPEG_QUALITY), 50])
        frame_b64 = base64.b64encode(buffer).decode('utf-8')
        _emit({"type": "frame", "data": frame_b64})
        continue
    
    if session.completed:
        if not summary_spoken:
            tts.speak(session.get_summary(), force=True)
            summary_spoken = True
            # Emit ONCE when session first completes (not every frame)
            _emit({"type": "session_complete",
                   "set": current_set, "total_sets": total_sets,
                   "correct": session.correct_reps,
                   "incorrect": session.incorrect_reps,
                   "total": session.total_reps})
        
        # Still encode and emit frames even when complete so the UI shows the last state
        _, buffer = cv2.imencode('.jpg', img, [int(cv2.IMWRITE_JPEG_QUALITY), 50])
        frame_b64 = base64.b64encode(buffer).decode('utf-8')
        _emit({"type": "frame", "data": frame_b64})

        key = cv2.waitKey(1) & 0xFF
        if key == 27: break
        elif key == ord('1'): init_mode("SQUATS")
        elif key == ord('2'): init_mode("STS")
        elif key == ord('3'): init_mode("LUNGES")
        elif key == ord('4'): init_mode("SHOULDER_ABD")
        continue

    img_rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=img_rgb)
    timestamp_ms = int(time.time() * 1000)
    detection_result = detector.detect_for_video(mp_image, timestamp_ms)
    
    feedback = ""
    color = (0, 255, 0)
    current_angle = None
    
    if detection_result.pose_landmarks:
        for pose_landmarks in detection_result.pose_landmarks:
            for connection in POSE_CONNECTIONS:
                si, ei = connection
                cv2.line(img, (int(pose_landmarks[si].x * w), int(pose_landmarks[si].y * h)), (int(pose_landmarks[ei].x * w), int(pose_landmarks[ei].y * h)), (0, 255, 0), 2)
            
            for landmark in pose_landmarks:
                cv2.circle(img, (int(landmark.x * w), int(landmark.y * h)), 5, (255, 0, 0), cv2.FILLED)
                
            l_shoulder, l_hip, l_knee, l_ankle = pose_landmarks[11], pose_landmarks[23], pose_landmarks[25], pose_landmarks[27]
            r_shoulder, r_hip, r_knee, r_ankle = pose_landmarks[12], pose_landmarks[24], pose_landmarks[26], pose_landmarks[28]
            
            if mode == "SQUATS":
                if l_hip.visibility > 0.5 and l_knee.visibility > 0.5 and l_ankle.visibility > 0.5 and \
                   r_hip.visibility > 0.5 and r_knee.visibility > 0.5 and r_ankle.visibility > 0.5 and \
                   l_shoulder.visibility > 0.5 and r_shoulder.visibility > 0.5:
                    
                    l_heel, l_foot_index = pose_landmarks[29], pose_landmarks[31]
                    r_heel, r_foot_index = pose_landmarks[30], pose_landmarks[32]

                    l_s_c = (l_shoulder.x * w, l_shoulder.y * h)
                    l_h_c = (l_hip.x * w, l_hip.y * h)
                    l_k_c = (l_knee.x * w, l_knee.y * h)
                    l_a_c = (l_ankle.x * w, l_ankle.y * h)
                    
                    r_s_c = (r_shoulder.x * w, r_shoulder.y * h)
                    r_h_c = (r_hip.x * w, r_hip.y * h)
                    r_k_c = (r_knee.x * w, r_knee.y * h)
                    r_a_c = (r_ankle.x * w, r_ankle.y * h)
                    
                    l_knee_angle = calculate_angle(l_h_c, l_k_c, l_a_c)
                    r_knee_angle = calculate_angle(r_h_c, r_k_c, r_a_c)
                    avg_knee_angle = (l_knee_angle + r_knee_angle) / 2
                    current_angle = avg_knee_angle
                    
                    l_hip_angle = calculate_angle(l_s_c, l_h_c, l_k_c)
                    r_hip_angle = calculate_angle(r_s_c, r_h_c, r_k_c)
                    avg_hip_angle = (l_hip_angle + r_hip_angle) / 2
                    
                    l_heel_c = (l_heel.x * w, l_heel.y * h)
                    l_toe_c = (l_foot_index.x * w, l_foot_index.y * h)
                    r_heel_c = (r_heel.x * w, r_heel.y * h)
                    r_toe_c = (r_foot_index.x * w, r_foot_index.y * h)
                    
                    l_foot_len = math.hypot(l_toe_c[0] - l_heel_c[0], l_toe_c[1] - l_heel_c[1]) + 1e-5
                    r_foot_len = math.hypot(r_toe_c[0] - r_heel_c[0], r_toe_c[1] - r_heel_c[1]) + 1e-5
                    
                    l_heel_lift = (l_toe_c[1] - l_heel_c[1]) / l_foot_len > 0.85
                    r_heel_lift = (r_toe_c[1] - r_heel_c[1]) / r_foot_len > 0.85
                    heel_lifted = (l_heel_lift or r_heel_lift) and avg_knee_angle < 140
                    
                    knee_dist = abs(l_k_c[0] - r_k_c[0])
                    ankle_dist = abs(l_a_c[0] - r_a_c[0])
                    knees_collapse = knee_dist < (0.6 * ankle_dist)
                    
                    asymmetry = abs(l_knee_angle - r_knee_angle) > 45 and avg_knee_angle < 130
                    bent_back = avg_hip_angle < 60
                    shallow = 90 < avg_knee_angle < 130
                    correct_depth = 70 <= avg_knee_angle <= 90
                    
                    if state not in ["standing", "descending", "squatting", "ascending"]:
                        state = "standing"
                        
                    if avg_knee_angle > 160:
                        if state in ["squatting", "ascending", "descending"]:
                            if state != "standing" and session.pending_frames > 0: # Ensure we actually started a rep
                                if not session.reached_depth:
                                    session.add_error("shallow_squat")
                                session.complete_rep(exercise_mode="SQUATS")
                                session.reached_depth = False
                        state = "standing"
                        session.pending_frames = 1 # Mark that standing state is active
                    elif avg_knee_angle < 90:
                        if state in ["standing", "descending"]:
                            state = "squatting"
                            session.reached_depth = True
                    else:
                        if state == "standing":
                            state = "descending"
                            session.reached_depth = False
                        elif state == "squatting":
                            state = "ascending"
                            
                    if state in ["descending", "squatting", "ascending"]:
                        if bent_back: session.add_error("bent_back")
                        if heel_lifted: session.add_error("heel_lifted")
                        if asymmetry: session.add_error("asymmetry")
                        if knees_collapse: session.add_error("knees_collapse")
                            
                    if bent_back:
                        feedback, color = "Straighten Your Back", (0, 0, 255)
                        tts.speak("Straighten Your Back")
                    elif heel_lifted:
                        feedback, color = "Keep Heels Grounded", (0, 0, 255)
                        tts.speak("Keep Heels Grounded")
                    elif asymmetry:
                        feedback, color = "Balance Your Weight Evenly", (0, 165, 255)
                        tts.speak("Balance Your Weight Evenly")
                    elif knees_collapse:
                        feedback, color = "Push Knees Outward", (0, 0, 255)
                        tts.speak("Push Knees Outward")
                    elif shallow and state == "descending":
                        feedback, color = "Go Lower", (0, 165, 255)
                    elif correct_depth and state == "squatting":
                        feedback, color = "Good Depth", (0, 255, 0)
                    elif state == "standing":
                        feedback, color = "STANDING", (0, 255, 0)
                    elif state == "ascending":
                        feedback, color = "COMING UP...", (0, 255, 0)
                    else:
                        feedback, color = "LOWER...", (0, 165, 255)

                    cv2.putText(img, f"Knee: {int(avg_knee_angle)} deg", (int(l_k_c[0])+20, int(l_k_c[1])), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255,255,255), 2)
                    cv2.putText(img, f"Hip: {int(avg_hip_angle)} deg", (int(l_k_c[0])+20, int(l_k_c[1])+30), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255,255,255), 2)

            elif mode == "STS":
                if l_shoulder.visibility > 0.5 and l_hip.visibility > 0.5 and l_knee.visibility > 0.5 and l_ankle.visibility > 0.5:
                    s_c = (l_shoulder.x * w, l_shoulder.y * h)
                    h_c = (l_hip.x * w, l_hip.y * h)
                    k_c = (l_knee.x * w, l_knee.y * h)
                    a_c = (l_ankle.x * w, l_ankle.y * h)
                    v_c = (h_c[0], h_c[1] - 100)
                    
                    knee_angle = calculate_angle(h_c, k_c, a_c)
                    current_angle = knee_angle
                    hip_angle = calculate_angle(s_c, h_c, k_c)
                    back_angle = 90 - calculate_angle(v_c, h_c, s_c)
                    
                    if state not in ["sitting", "flexion", "lift-off", "extension", "stabilization"]: state = "sitting"
                    
                    if state == "sitting":
                        if knee_angle < 120 and back_angle < 75: state = "flexion"
                    elif state == "flexion":
                        if knee_angle > 115: state = "lift-off"
                        elif back_angle > 80: state = "sitting"
                    elif state == "lift-off":
                        if knee_angle > 150 and hip_angle > 150: state = "extension"
                        elif knee_angle < 110: state = "sitting"
                    elif state == "extension":
                        if knee_angle >= 150 and hip_angle >= 150 and back_angle >= 65:
                            state = "stabilization"
                            session.complete_rep(exercise_mode="STS")
                        elif knee_angle < 110: state = "sitting"
                    elif state == "stabilization":
                        if knee_angle < 110: state = "sitting"
                        
                    # Feedback: only show "Good posture" when fully standing (stabilization state)
                    if back_angle < 60:
                        feedback, color = "Reduce forward bending", (0,0,255)
                        tts.speak("Reduce forward bending")
                        session.add_error("forward_bending")
                    elif state in ["sitting", "flexion", "lift-off"]:
                        # Still in process of standing — give neutral cue, not "Good posture"
                        feedback, color = "Keep rising...", (0, 165, 255)
                    elif knee_angle < 160:
                        feedback, color = "Stand fully upright", (0,165,255)
                    elif hip_angle < 150:
                        feedback, color = "Extend hips properly", (0,165,255)
                        tts.speak("Extend your hips more")
                        session.add_error("hip_extension")
                    else:
                        feedback, color = "Good posture", (0,255,0)
                        # Good form — clear transitional errors
                        session.current_rep_errors.discard("forward_bending")
                        session.current_rep_errors.discard("hip_extension")

            elif mode == "LUNGES":
                # Visibility gate: require ALL key landmarks to be visible
                lunge_visible = (
                    l_shoulder.visibility > 0.5 and r_shoulder.visibility > 0.5 and
                    l_hip.visibility > 0.5 and r_hip.visibility > 0.5 and
                    l_knee.visibility > 0.5 and r_knee.visibility > 0.5 and
                    l_ankle.visibility > 0.5 and r_ankle.visibility > 0.5
                )
                if not lunge_visible:
                    feedback, color = "Stand at 45° angle to camera", (0, 165, 255)
                else:
                    facing_right = l_shoulder.x < r_shoulder.x 
                    if facing_right: is_left_forward = l_ankle.x > r_ankle.x
                    else: is_left_forward = l_ankle.x < r_ankle.x
                        
                    if is_left_forward:
                        f_s, f_h, f_k, f_a = l_shoulder, l_hip, l_knee, l_ankle
                        b_h, b_k, b_a = r_hip, r_knee, r_ankle
                    else:
                        f_s, f_h, f_k, f_a = r_shoulder, r_hip, r_knee, r_ankle
                        b_h, b_k, b_a = l_hip, l_knee, l_ankle
                    
                    f_s_c = (f_s.x * w, f_s.y * h)
                    f_h_c = (f_h.x * w, f_h.y * h)
                    f_k_c = (f_k.x * w, f_k.y * h)
                    f_a_c = (f_a.x * w, f_a.y * h)
                    
                    b_k_c = (b_k.x * w, b_k.y * h)
                    b_h_c = (b_h.x * w, b_h.y * h)
                    b_a_c = (b_a.x * w, b_a.y * h)
                    
                    front_knee_angle = calculate_angle(f_h_c, f_k_c, f_a_c)
                    current_angle = front_knee_angle
                    back_knee_angle = calculate_angle(b_h_c, b_k_c, b_a_c)
                    vertical_down = (f_h_c[0], f_h_c[1] + 100)
                    trunk_angle = calculate_angle(vertical_down, f_h_c, f_s_c)
                    
                    if facing_right: knee_over_toes = f_k.x > f_a.x
                    else: knee_over_toes = f_k.x < f_a.x
                        
                    if front_knee_angle >= 145 and back_knee_angle >= 145:
                        if state == "down":
                            session.complete_rep(exercise_mode="LUNGES")
                        state = "up"
                        session.reached_depth = False
                    elif front_knee_angle <= 100:
                        if state != "down":
                            session.reached_depth = True
                        state = "down"

                    # Feedback priority: trunk > knee alignment > depth > good
                    if trunk_angle < 140:
                        feedback, color = "Keep your torso upright", (0, 0, 255)
                        tts.speak("Keep torso upright during lunge")
                        if state == "down":
                            session.add_error("trunk")
                    elif knee_over_toes and front_knee_angle < 130:
                        feedback, color = "Knee past toes - step further", (0, 0, 255)
                        tts.speak("Step further forward, knee behind toes")
                        if state == "down":
                            session.add_error("knee_over_toes")
                    elif front_knee_angle > 120 and state != "up" and not session.reached_depth:
                        feedback, color = "Lower into the lunge", (0, 165, 255)
                        tts.speak("Lower into your lunge")
                    elif front_knee_angle < 70:
                        feedback, color = "Too deep - ease up", (0, 0, 255)
                        tts.speak("Too deep, ease up slightly")
                        if state == "down":
                            session.add_error("too_deep")
                    elif back_knee_angle > 120 and state != "up":
                        feedback, color = "Lower your back knee", (0, 165, 255)
                        tts.speak("Drop your back knee lower")
                    else:
                        if state == "down": feedback, color = "Good lunge form!", (0, 255, 0)
                        else: feedback, color = "Standing - step forward", (0, 255, 0)

            elif mode == "SHOULDER_ABD":
                l_elbow, l_wrist = pose_landmarks[13], pose_landmarks[15]
                r_elbow, r_wrist = pose_landmarks[14], pose_landmarks[16]

                if l_shoulder.visibility > 0.5 and r_shoulder.visibility > 0.5 and \
                   l_elbow.visibility > 0.5 and r_elbow.visibility > 0.5 and \
                   l_wrist.visibility > 0.5 and r_wrist.visibility > 0.5 and \
                   l_hip.visibility > 0.5 and l_knee.visibility > 0.5:
                   
                    l_s_c = (l_shoulder.x * w, l_shoulder.y * h)
                    r_s_c = (r_shoulder.x * w, r_shoulder.y * h)
                    l_e_c = (l_elbow.x * w, l_elbow.y * h)
                    r_e_c = (r_elbow.x * w, r_elbow.y * h)
                    l_w_c = (l_wrist.x * w, l_wrist.y * h)
                    r_w_c = (r_wrist.x * w, r_wrist.y * h)
                    l_h_c = (l_hip.x * w, l_hip.y * h)
                    l_k_c = (l_knee.x * w, l_knee.y * h)
                    
                    # 1. Raw Angles
                    raw_l_sh = calculate_angle(l_h_c, l_s_c, l_e_c)
                    raw_r_sh = calculate_angle((r_hip.x * w, r_hip.y * h), r_s_c, r_e_c)
                    raw_l_el = calculate_angle(l_s_c, l_e_c, l_w_c)
                    raw_r_el = calculate_angle(r_s_c, r_e_c, r_w_c)
                    
                    v_down = (l_h_c[0], l_h_c[1] + 100)
                    raw_torso = calculate_angle(v_down, l_h_c, l_s_c)
                    
                    # Moving average over 5 frames
                    abd_history["l_sh"].append(raw_l_sh)
                    abd_history["r_sh"].append(raw_r_sh)
                    abd_history["l_el"].append(raw_l_el)
                    abd_history["r_el"].append(raw_r_el)
                    abd_history["torso"].append(raw_torso)
                    
                    for key in abd_history:
                        if len(abd_history[key]) > 5:
                            abd_history[key].pop(0)
                            
                    if len(abd_history["l_sh"]) > 0:
                        l_sh = sum(abd_history["l_sh"]) / len(abd_history["l_sh"])
                        r_sh = sum(abd_history["r_sh"]) / len(abd_history["r_sh"])
                        avg_sh = (l_sh + r_sh) / 2
                        current_angle = avg_sh
                        
                        l_el = sum(abd_history["l_el"]) / len(abd_history["l_el"])
                        r_el = sum(abd_history["r_el"]) / len(abd_history["r_el"])
                        avg_el = (l_el + r_el) / 2
                        
                        torso = sum(abd_history["torso"]) / len(abd_history["torso"])
                        
                        # 2. Rep Counting Logic
                        if state not in ["down", "up"]:
                            state = "down"
                            
                        # Track max height reached during the current movement
                        if "max_sh" not in abd_states:
                            abd_states["max_sh"] = 0
                        abd_states["max_sh"] = max(abd_states["max_sh"], avg_sh)
                            
                        if l_sh < 30 and r_sh < 30:
                            # If they tried to lift but gave up before 80, count it as an error rep
                            if state == "down" and 45 < abd_states["max_sh"] < 80:
                                session.add_error("incomplete_raise")
                                session.complete_rep(exercise_mode="SHOULDER_ABD")
                            state = "down"
                            abd_states["max_sh"] = 0  # reset for next attempt
                        elif l_sh > 80 and r_sh > 80:
                            if state == "down":
                                state = "up"
                                session.complete_rep(exercise_mode="SHOULDER_ABD")
                                
                        # Priority Feedback System
                        is_torso_lean = torso < 160 and avg_sh > 50
                        is_bent_elbow = avg_el < 140 and avg_sh > 40
                        is_uneven = abs(l_sh - r_sh) > 15 and avg_sh > 40
                        is_incomplete = 40 < avg_sh < 80 and state == "down"
                        
                        is_good_form = (80 <= avg_sh <= 110 and avg_el > 140 and abs(l_sh - r_sh) < 15 and torso > 160)
                        
                        candidate_fb = ""
                        candidate_col = (0, 255, 0)
                        
                        if avg_sh < 30:
                            candidate_fb, candidate_col = "Ready", (0, 255, 0)
                        elif is_torso_lean:
                            candidate_fb, candidate_col = "Keep Torso Straight", (0, 0, 255)
                            session.add_error("torso_lean")
                        elif is_bent_elbow:
                            candidate_fb, candidate_col = "Keep Arms Straight", (0, 0, 255)
                            session.add_error("bent_elbow")
                        elif is_uneven:
                            candidate_fb, candidate_col = "Raise Both Arms Evenly", (0, 165, 255)
                            session.add_error("uneven_arms")
                        elif is_incomplete:
                            candidate_fb, candidate_col = "Raise Arms Higher", (0, 165, 255)
                        elif is_good_form:
                            candidate_fb, candidate_col = "Good Form", (0, 255, 0)
                        else:
                            if state == "up":
                                candidate_fb, candidate_col = "Good Form", (0, 255, 0)
                            else:
                                candidate_fb, candidate_col = "Raise Arms", (0, 165, 255)
                                
                        # Feedback debounce/persistence (require 5 frames)
                        if candidate_fb == abd_fb_state["msg"]:
                            abd_fb_state["frames"] += 1
                        else:
                            abd_fb_state["msg"] = candidate_fb
                            abd_fb_state["col"] = candidate_col
                            abd_fb_state["frames"] = 1
                            
                        if abd_fb_state["frames"] >= 5:
                            feedback = abd_fb_state["msg"]
                            color = abd_fb_state["col"]
                            # Speak only on transition of confirmed feedback
                            if feedback != abd_fb_state["last_spoken"]:
                                if feedback not in ["Ready", "Good Form", "Raise Arms"]:
                                    tts.speak(feedback)
                                abd_fb_state["last_spoken"] = feedback
                        else:
                            # use last confirmed
                            feedback = abd_fb_state["last_spoken"] if abd_fb_state["last_spoken"] else "Ready"
                            # Recover color based on string
                            if feedback in ["Keep Torso Straight", "Keep Arms Straight"]: color = (0,0,255)
                            elif feedback in ["Raise Both Arms Evenly", "Raise Arms Higher", "Raise Arms"]: color = (0,165,255)
                            else: color = (0,255,0)

                        cv2.putText(img, f"L:{int(l_sh)} R:{int(r_sh)}", (int(l_s_c[0])+20, int(l_s_c[1])-20), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)

    # --- Emit real-time status JSON to stdout (read by Node.js) ---
    _emit({
        "type":         "status",
        "mode":         mode,
        "state":        state,
        "rep":          session.total_reps,
        "target_reps":  session.target_reps,
        "correct":      session.correct_reps,
        "incorrect":    session.incorrect_reps,
        "feedback":     feedback,
        "color":        "green" if color == (0,255,0) else ("orange" if color == (0,165,255) else "red"),
        "set":          current_set,
        "total_sets":   total_sets,
        "completed":    session.completed,
        "angle":        round(current_angle) if current_angle is not None else None
    })

    # Encode frame as JPEG and emit to UI
    # Lower quality to 50% for better streaming performance
    _, buffer = cv2.imencode('.jpg', img, [int(cv2.IMWRITE_JPEG_QUALITY), 50])
    frame_b64 = base64.b64encode(buffer).decode('utf-8')
    _emit({"type": "frame", "data": frame_b64})

    key = cv2.waitKey(1) & 0xFF
    if key == 27:
        break
    elif key == ord('1') and mode != "SQUATS": init_mode("SQUATS")
    elif key == ord('2') and mode != "STS": init_mode("STS")
    elif key == ord('3') and mode != "LUNGES": init_mode("LUNGES")
    elif key == ord('4') and mode != "SHOULDER_ABD": init_mode("SHOULDER_ABD")

# Shutdown tts engine cleanly
tts.q.put(None)
cap.release()