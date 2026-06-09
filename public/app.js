/* ── app.js — PhysioAI frontend logic ──────────────────────── */
const socket = io();

// ── Settings & State ───────────────────────────────────────────
let settings = JSON.parse(localStorage.getItem('physioai_settings')) || {
  restDuration: 30,
  volume: 70,
  metronome: false,
  mirror: true
};

let cfg = { mode: 'SQUATS', reps: 10, sets: 3 };
let sessionState = 'setup';   // 'setup' | 'running' | 'complete'
let currentSet   = 1;
let lastRepCount = 0;
let lastCorrectCount = 0;
let lastIncorrectCount = 0;
let lastSetCompleteTime = 0;  // debounce: ignore duplicate session_complete events
let cameraEnabled = false;
let browserStream = null;
let voiceEnabled = true; // Voice guidance enabled by default
let lastSpokenFeedback = '';

// Session error logger for complete screen insights
let sessionErrors = new Set();
let metronomeIntervalId = null;

// ── DOM refs ───────────────────────────────────────────────────
const screens = {
  setup:    document.getElementById('setup-screen'),
  exercise: document.getElementById('exercise-screen'),
  complete: document.getElementById('complete-screen'),
};

const videoFeed = document.getElementById('video-feed');
const videoPlaceholder = document.getElementById('video-placeholder');
const $  = id => document.getElementById(id);
const repCounter    = $('rep-counter');
const repOf         = $('rep-of');
const setCounter    = $('set-counter');
const setOf         = $('set-of');
const correctCount  = $('correct-count');
const incorrectCount= $('incorrect-count');
const stateBadge    = $('state-badge');
const feedbackBox   = $('feedback-box');
const feedbackIcon  = $('feedback-icon');
const feedbackText  = $('feedback-text');
const repFlash      = $('rep-flash');
const sessionFill   = $('session-fill');
const progressPct   = $('progress-pct');
const accFill       = $('acc-fill');
const accuracyPct   = $('accuracy-pct');
const setDots       = $('set-dots');
const topMode       = $('top-mode');
const ringFill      = $('ring-fill');

// Rest-timer refs
const restOverlay   = $('rest-overlay');
const restCountdown = $('rest-countdown');
const restBarFill   = $('rest-bar-fill');
const restPrevStats = $('rest-prev-stats');

let   restTimerId   = null; // holds setInterval handle

const TIPS = {
  SQUATS:       ['Feet shoulder-width apart','Keep back straight','Knees track over toes'],
  STS:          ['Use armrests if needed','Lead with your chest','Push through your heels'],
  LUNGES:       ['Torso upright at all times','Front knee behind toes','Lower rear knee gently'],
  SHOULDER_ABD: ['Keep elbow fully straight','Raise to shoulder height','Control the lowering phase'],
};

const ICONS = {
  green:  '✅',
  orange: '⚠️',
  red:    '❌',
  default:'🎯',
};

const INSIGHTS_MAP = {
  // Squats
  "Straighten Your Back": "Ensure your spine remains neutral. Keep your chest proud and avoid bending forward from the waist.",
  "Keep Heels Grounded": "Your heels lifted during the squat. Press weight into your heels to maintain balance and engagement.",
  "Balance Your Weight Evenly": "We noticed side-to-side asymmetry. Try distributing your weight equally on both legs.",
  "Push Knees Outward": "Knees collapsed inward. Actively press your knees outward so they track in line with your toes.",
  "Go Lower": "Your squat depth was slightly shallow. Try to lower your hips until your thighs are parallel to the floor.",
  
  // Sit to Stand
  "Reduce forward bending": "Focus on standing tall using your leg strength rather than swinging your torso forward for momentum.",
  "Stand fully upright": "Make sure you extend your knees fully at the very top of each stand.",
  "Extend hips properly": "Squeeze your glutes at the top to achieve complete hip extension.",
  
  // Lunges
  "Keep your torso upright": "Keep your head and chest up throughout the lunge. Avoid leaning forward over your front thigh.",
  "Knee past toes - step further": "Step a bit further forward. Your front knee should stay directly above your ankle at the bottom of the lunge.",
  "Lower into the lunge": "Try lowering your hips closer to the ground to achieve a full 90-degree bend in both knees.",
  "Too deep - ease up": "You are descending below a safe range of motion. Keep your front thigh parallel to the floor.",
  "Lower your back knee": "Actively drop your rear knee down toward the floor to engage the glutes and core.",
  
  // Shoulder Abduction
  "Keep Torso Straight": "Engage your core and stand solid. Avoid leaning your body sideways as you raise your arms.",
  "Keep Arms Straight": "Try not to bend your elbows. Keep your arms fully extended to isolate the shoulder deltoid muscles.",
  "Raise Both Arms Evenly": "One arm raised higher than the other. Focus on lifting them symmetrically at the same speed.",
  "Raise Arms Higher": "Make sure to raise your arms all the way to shoulder height (90 degrees) to complete the motion."
};

// ── Sound Engine (Web Audio API) ──────────────────────────────
class SoundEngine {
  constructor() {
    this.ctx = null;
  }
  init() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }
  playSuccess() {
    this.init();
    const vol = parseFloat(settings.volume) / 100;
    if (vol <= 0) return;
    
    const osc1 = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    const gainNode = this.ctx.createGain();
    
    osc1.connect(gainNode);
    osc2.connect(gainNode);
    gainNode.connect(this.ctx.destination);
    
    gainNode.gain.setValueAtTime(0, this.ctx.currentTime);
    gainNode.gain.linearRampToValueAtTime(vol * 0.12, this.ctx.currentTime + 0.05);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.35);
    
    osc1.frequency.setValueAtTime(523.25, this.ctx.currentTime); // C5
    osc1.frequency.exponentialRampToValueAtTime(659.25, this.ctx.currentTime + 0.08); // E5
    osc2.frequency.setValueAtTime(783.99, this.ctx.currentTime); // G5
    
    osc1.start(this.ctx.currentTime);
    osc2.start(this.ctx.currentTime);
    osc1.stop(this.ctx.currentTime + 0.4);
    osc2.stop(this.ctx.currentTime + 0.4);
  }
  playError() {
    this.init();
    const vol = parseFloat(settings.volume) / 100;
    if (vol <= 0) return;
    
    const osc = this.ctx.createOscillator();
    const gainNode = this.ctx.createGain();
    
    osc.type = 'sawtooth';
    osc.connect(gainNode);
    gainNode.connect(this.ctx.destination);
    
    gainNode.gain.setValueAtTime(0, this.ctx.currentTime);
    gainNode.gain.linearRampToValueAtTime(vol * 0.15, this.ctx.currentTime + 0.05);
    gainNode.gain.linearRampToValueAtTime(0.0001, this.ctx.currentTime + 0.25);
    
    osc.frequency.setValueAtTime(120, this.ctx.currentTime);
    osc.frequency.linearRampToValueAtTime(80, this.ctx.currentTime + 0.2);
    
    osc.start(this.ctx.currentTime);
    osc.stop(this.ctx.currentTime + 0.3);
  }
  playTick() {
    this.init();
    const vol = parseFloat(settings.volume) / 100;
    if (vol <= 0) return;
    
    const osc = this.ctx.createOscillator();
    const gainNode = this.ctx.createGain();
    osc.type = 'triangle';
    osc.connect(gainNode);
    gainNode.connect(this.ctx.destination);
    
    gainNode.gain.setValueAtTime(vol * 0.15, this.ctx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.04);
    
    osc.frequency.setValueAtTime(900, this.ctx.currentTime);
    
    osc.start(this.ctx.currentTime);
    osc.stop(this.ctx.currentTime + 0.05);
  }
  playRestPip() {
    this.init();
    const vol = parseFloat(settings.volume) / 100;
    if (vol <= 0) return;
    
    const osc = this.ctx.createOscillator();
    const gainNode = this.ctx.createGain();
    osc.connect(gainNode);
    gainNode.connect(this.ctx.destination);
    
    gainNode.gain.setValueAtTime(vol * 0.12, this.ctx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.08);
    
    osc.frequency.setValueAtTime(1000, this.ctx.currentTime);
    
    osc.start(this.ctx.currentTime);
    osc.stop(this.ctx.currentTime + 0.1);
  }
  playRestGo() {
    this.init();
    const vol = parseFloat(settings.volume) / 100;
    if (vol <= 0) return;
    
    const osc = this.ctx.createOscillator();
    const gainNode = this.ctx.createGain();
    osc.connect(gainNode);
    gainNode.connect(this.ctx.destination);
    
    gainNode.gain.setValueAtTime(vol * 0.2, this.ctx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.25);
    
    osc.frequency.setValueAtTime(1320, this.ctx.currentTime);
    
    osc.start(this.ctx.currentTime);
    osc.stop(this.ctx.currentTime + 0.3);
  }
  playSessionComplete() {
    this.init();
    const vol = parseFloat(settings.volume) / 100;
    if (vol <= 0) return;
    
    const notes = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6
    notes.forEach((freq, idx) => {
      const osc = this.ctx.createOscillator();
      const gainNode = this.ctx.createGain();
      
      osc.connect(gainNode);
      gainNode.connect(this.ctx.destination);
      
      const startTime = this.ctx.currentTime + idx * 0.12;
      gainNode.gain.setValueAtTime(0, startTime);
      gainNode.gain.linearRampToValueAtTime(vol * 0.12, startTime + 0.03);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.35);
      
      osc.frequency.setValueAtTime(freq, startTime);
      
      osc.start(startTime);
      osc.stop(startTime + 0.45);
    });
  }
}
const sound = new SoundEngine();

// ── Canvas Waveform Chart plotter ──────────────────────────────
class WaveformChart {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext('2d');
    this.points = [];
    this.maxPoints = 80;
    this.currentColor = 'green';
    
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.draw();
  }
  resize() {
    if (!this.canvas) return;
    const rect = this.canvas.parentNode.getBoundingClientRect();
    this.canvas.width = rect.width * (window.devicePixelRatio || 1);
    this.canvas.height = rect.height * (window.devicePixelRatio || 1);
    this.ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
  }
  push(val, color) {
    if (val === null || val === undefined) return;
    this.currentColor = color || 'green';
    this.points.push(val);
    if (this.points.length > this.maxPoints) {
      this.points.shift();
    }
  }
  clear() {
    this.points = [];
  }
  draw() {
    if (!this.canvas) return;
    requestAnimationFrame(() => this.draw());
    
    const w = this.canvas.width / (window.devicePixelRatio || 1);
    const h = this.canvas.height / (window.devicePixelRatio || 1);
    
    this.ctx.clearRect(0, 0, w, h);
    
    // Draw horizontal grid lines (0, 45, 90, 135, 180 degrees)
    this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
    this.ctx.lineWidth = 1;
    this.ctx.fillStyle = 'rgba(148, 163, 184, 0.4)';
    this.ctx.font = '8px "JetBrains Mono", monospace';
    
    const gridAngles = [0, 45, 90, 135, 180];
    gridAngles.forEach(ang => {
      const y = h - (ang / 180) * (h - 14) - 7;
      this.ctx.beginPath();
      this.ctx.moveTo(35, y);
      this.ctx.lineTo(w, y);
      this.ctx.stroke();
      this.ctx.fillText(ang + '°', 6, y + 3);
    });
    
    if (this.points.length < 2) return;
    
    // Choose color theme
    let strokeColor = '#10b981'; // green
    if (this.currentColor === 'orange') strokeColor = '#f97316';
    else if (this.currentColor === 'red') strokeColor = '#ef4444';
    
    this.ctx.beginPath();
    const startX = 35;
    const step = (w - startX) / (this.maxPoints - 1);
    const pad = this.maxPoints - this.points.length;
    
    const getCoords = (idx) => {
      const val = this.points[idx];
      const x = startX + (idx + pad) * step;
      const y = h - (val / 180) * (h - 14) - 7;
      return { x, y };
    };
    
    let p0 = getCoords(0);
    this.ctx.moveTo(p0.x, p0.y);
    
    for (let i = 0; i < this.points.length - 1; i++) {
      const p1 = getCoords(i);
      const p2 = getCoords(i + 1);
      const xc = (p1.x + p2.x) / 2;
      const yc = (p1.y + p2.y) / 2;
      this.ctx.quadraticCurveTo(p1.x, p1.y, xc, yc);
    }
    
    const lastP = getCoords(this.points.length - 1);
    this.ctx.lineTo(lastP.x, lastP.y);
    
    // Stroke neon glowing path
    this.ctx.shadowBlur = 6;
    this.ctx.shadowColor = strokeColor;
    this.ctx.strokeStyle = strokeColor;
    this.ctx.lineWidth = 2.5;
    this.ctx.stroke();
    this.ctx.shadowBlur = 0;
    
    // Draw glowing node head
    this.ctx.beginPath();
    this.ctx.arc(lastP.x, lastP.y, 4, 0, 2 * Math.PI);
    this.ctx.fillStyle = '#ffffff';
    this.ctx.fill();
    this.ctx.strokeStyle = strokeColor;
    this.ctx.lineWidth = 1.5;
    this.ctx.stroke();
  }
}
let chart = null;

// ── Confetti Celebration Particle Engine ────────────────────────
class ConfettiEngine {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext('2d');
    this.particles = [];
    this.active = false;
    
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }
  resize() {
    if (!this.canvas) return;
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
  }
  start() {
    this.particles = [];
    this.active = true;
    this.resize();
    
    const colors = ['#6c63ff', '#00d9ff', '#10b981', '#f97316', '#ef4444', '#f59e0b'];
    for (let i = 0; i < 150; i++) {
      this.particles.push({
        x: window.innerWidth / 2 + (Math.random() - 0.5) * 60,
        y: window.innerHeight + 15,
        vx: (Math.random() - 0.5) * 15,
        vy: -Math.random() * 18 - 8,
        r: Math.random() * 5 + 3,
        color: colors[Math.floor(Math.random() * colors.length)],
        rot: Math.random() * 360,
        rotSp: (Math.random() - 0.5) * 12
      });
    }
    this.loop();
  }
  stop() {
    this.active = false;
    if (this.ctx && this.canvas) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }
  loop() {
    if (!this.active || !this.canvas) return;
    requestAnimationFrame(() => this.loop());
    
    const w = this.canvas.width;
    const h = this.canvas.height;
    
    this.ctx.clearRect(0, 0, w, h);
    
    let activeParticles = false;
    this.particles.forEach(p => {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.45; // gravity
      p.vx *= 0.985; // air drag
      p.rot += p.rotSp;
      
      if (p.y < h + 20) {
        activeParticles = true;
        this.ctx.save();
        this.ctx.translate(p.x, p.y);
        this.ctx.rotate(p.rot * Math.PI / 180);
        this.ctx.fillStyle = p.color;
        this.ctx.fillRect(-p.r, -p.r / 2, p.r * 2, p.r);
        this.ctx.restore();
      }
    });
    
    if (!activeParticles) {
      this.active = false;
    }
  }
}
const confetti = new ConfettiEngine('confetti-canvas');

// ── Screen Helpers ─────────────────────────────────────────────
function showScreen(name) {
  Object.values(screens).forEach(s => {
    if (!s) return;
    s.classList.remove('active');
    s.style.display = 'none';
  });
  const s = screens[name];
  if (!s) return;
  s.style.display = 'flex';
  requestAnimationFrame(() => s.classList.add('active'));
  
  if (name === 'setup') {
    confetti.stop();
    updateHistoryUI();
  }
}

// ── Stepper Setup ──────────────────────────────────────────────
let reps = 10, sets = 3;

const EXERCISE_PREVIEW = {
  SQUATS: {
    image: 'images/squats.png',
    name: 'Squats',
    desc: 'A fundamental lower body exercise that strengthens your quads, glutes, and core while improving mobility and balance.',
    tips: [
      'Feet shoulder-width apart',
      'Keep back straight and chest up',
      'Knees track over toes, not inward',
      'Lower until thighs are parallel to floor'
    ]
  },
  STS: {
    image: 'images/sts.png',
    name: 'Sit to Stand',
    desc: 'A functional rehabilitation exercise that builds leg and core strength essential for daily activities like getting up from a chair.',
    tips: [
      'Sit at the edge of a sturdy chair',
      'Lean forward slightly before standing',
      'Push through your heels to rise',
      'Stand fully upright, extend hips'
    ]
  },
  LUNGES: {
    image: 'images/lunges.png',
    name: 'Lunges',
    desc: 'A unilateral exercise that builds balance, glute and quad strength while improving coordination and lower body stability.',
    tips: [
      'Stand at 45° angle to camera',
      'Keep your torso upright throughout',
      'Front knee stays behind toes',
      'Lower rear knee gently toward floor'
    ]
  },
  SHOULDER_ABD: {
    image: 'images/shoulder_abd.png',
    name: 'Shoulder Abduction',
    desc: 'A rehabilitation exercise targeting shoulder range of motion. Strengthens deltoids and rotator cuff muscles for injury recovery.',
    tips: [
      'Keep elbows fully straight',
      'Raise arms sideways to shoulder height',
      'Control the movement both up and down',
      'Keep torso upright, avoid leaning'
    ]
  }
};

function updatePreview(mode) {
  const data = EXERCISE_PREVIEW[mode];
  if (!data) return;
  const previewImg = $('preview-img');
  const previewName = $('preview-name');
  const previewDesc = $('preview-desc');
  const previewTipsList = $('preview-tips-list');
  if (previewImg) previewImg.src = data.image;
  if (previewName) previewName.textContent = data.name;
  if (previewDesc) previewDesc.textContent = data.desc;
  if (previewTipsList) {
    previewTipsList.innerHTML = '';
    data.tips.forEach(tip => {
      const li = document.createElement('li');
      li.textContent = tip;
      previewTipsList.appendChild(li);
    });
  }
}

document.querySelectorAll('.ex-card').forEach(card => {
  card.addEventListener('click', () => {
    document.querySelectorAll('.ex-card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    cfg.mode = card.dataset.mode;
    updatePreview(cfg.mode);
  });
});

function makeStepper(decId, incId, valId, min, max, initial, onChange) {
  let val = initial;
  const display = $(valId);
  display.textContent = val;
  $(decId).addEventListener('click', () => { if (val > min) { val--; display.textContent = val; onChange(val); } });
  $(incId).addEventListener('click', () => { if (val < max) { val++; display.textContent = val; onChange(val); } });
  return () => val;
}

const getReps = makeStepper('reps-dec','reps-inc','reps-val', 1, 50, 10, v => { reps = v; });
const getSets = makeStepper('sets-dec','sets-inc','sets-val', 1, 10, 3,  v => { sets = v; });

// ── Voice Assistant ───────────────────────────────────────────
function voiceSpeak(text) {
  if (voiceEnabled && 'speechSynthesis' in window) {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.15;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  }
}

function toggleVoice(forceState) {
  voiceEnabled = forceState !== undefined ? forceState : !voiceEnabled;
  updateVoiceUI(voiceEnabled);
  if (!voiceEnabled) {
    window.speechSynthesis && window.speechSynthesis.cancel();
  } else {
    voiceSpeak('Voice assistant enabled');
  }
}

function updateVoiceUI(enabled) {
  const buttons = [$('btn-voice-toggle-setup'), $('btn-voice-toggle-ex')];
  buttons.forEach(btn => {
    if (!btn) return;
    if (enabled) {
      btn.className = 'btn-voice voice-enabled';
      btn.querySelector('.voice-status-text').textContent = 'Voice: ON';
    } else {
      btn.className = 'btn-voice voice-disabled';
      btn.querySelector('.voice-status-text').textContent = 'Voice: OFF';
    }
  });
}

// ── Camera Toggle & Permissions ───────────────────────────────
async function toggleCamera(forceState) {
  const targetState = forceState !== undefined ? forceState : !cameraEnabled;
  
  if (targetState) {
    try {
      const streamPromise = navigator.mediaDevices.getUserMedia({ video: true });
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error("Timeout")), 3000)
      );
      
      browserStream = await Promise.race([streamPromise, timeoutPromise]).catch(err => {
        console.warn("Camera check bypassed/timed out, continuing to backend:", err.message);
        return null;
      });
      
      if (browserStream) {
        browserStream.getTracks().forEach(track => track.stop());
        browserStream = null;
      }
      
      cameraEnabled = true;
      updateCameraUI(true);
      socket.emit('camera_toggle', { enabled: true });
      
      if (sessionState === 'running') {
        if (videoPlaceholder) {
          videoPlaceholder.textContent = 'Initializing Camera...';
        }
      }
    } catch (err) {
      console.error('Camera access error:', err);
      alert('⚠️ Camera Access Denied or Not Found.\n\nPlease allow camera permissions in your browser to use the AI Physiotherapy Assistant.');
      cameraEnabled = false;
      updateCameraUI(false);
      socket.emit('camera_toggle', { enabled: false });
    }
  } else {
    cameraEnabled = false;
    if (browserStream) {
      browserStream.getTracks().forEach(track => track.stop());
      browserStream = null;
    }
    updateCameraUI(false);
    socket.emit('camera_toggle', { enabled: false });
    
    if (sessionState === 'running') {
      if (videoFeed) videoFeed.style.display = 'none';
      if (videoPlaceholder) {
        videoPlaceholder.style.display = 'flex';
        videoPlaceholder.style.visibility = 'visible';
        videoPlaceholder.textContent = 'Camera is Turned OFF. Enable it from the top-right button.';
      }
    }
  }
}

function updateCameraUI(enabled) {
  const buttons = [$('btn-camera-toggle-setup'), $('btn-camera-toggle-ex')];
  buttons.forEach(btn => {
    if (!btn) return;
    if (enabled) {
      btn.className = 'btn-camera camera-enabled';
      btn.querySelector('.camera-status-text').textContent = 'Camera: ON';
    } else {
      btn.className = 'btn-camera camera-disabled';
      btn.querySelector('.camera-status-text').textContent = 'Camera: OFF';
    }
  });
}

$('btn-start').addEventListener('click', async () => {
  cfg.reps = getReps();
  cfg.sets = getSets();
  await startSession();
});

// ── Metronome Engine ───────────────────────────────────────────
function startMetronome() {
  stopMetronome();
  if (!settings.metronome) return;
  
  metronomeIntervalId = setInterval(() => {
    if (sessionState === 'running' && !restTimerId) {
      sound.playTick();
    }
  }, 1600); // 1.6s beat pacing
}

function stopMetronome() {
  if (metronomeIntervalId) {
    clearInterval(metronomeIntervalId);
    metronomeIntervalId = null;
  }
}

// ── Session start ──────────────────────────────────────────────
async function startSession() {
  if (!cameraEnabled) {
    const proceed = confirm('📷 Camera is currently OFF.\n\nWould you like to turn it ON and grant camera permissions to start tracking your movements?');
    if (proceed) {
      await toggleCamera(true);
      if (!cameraEnabled) return;
    } else {
      return;
    }
  }

  currentSet   = 1;
  lastRepCount = 0;
  lastCorrectCount = 0;
  lastIncorrectCount = 0;
  lastSetCompleteTime = 0;
  sessionState = 'running';
  sessionErrors.clear();

  if (restTimerId) { clearInterval(restTimerId); restTimerId = null; }
  if (restOverlay) restOverlay.style.display = 'none';

  // Apply camera mirror settings
  if (videoFeed) {
    videoFeed.style.display = 'none';
    videoFeed.src = '';
    if (settings.mirror) videoFeed.classList.add('mirrored');
    else videoFeed.classList.remove('mirrored');
  }
  if (videoPlaceholder) {
    videoPlaceholder.style.display = 'flex';
    videoPlaceholder.style.visibility = 'visible';
    videoPlaceholder.textContent = 'Initializing Camera...';
  }

  topMode.textContent = modeLabel(cfg.mode);
  buildSetDots(cfg.sets, 1);
  setCounter.textContent  = '1';
  setOf.textContent       = `/ ${cfg.sets}`;
  repOf.textContent       = `/ ${cfg.reps}`;
  repCounter.textContent  = '0';
  correctCount.textContent   = '0';
  incorrectCount.textContent = '0';
  accuracyPct.textContent = '—';
  sessionFill.style.width = '0%';
  progressPct.textContent = '0%';
  updateRing(0, cfg.reps);
  updateAccRing(null);

  // Clear chart
  if (chart) chart.clear();

  // Tips
  const tipsList = $('tips-list');
  tipsList.innerHTML = '';
  (TIPS[cfg.mode] || []).forEach(t => {
    const li = document.createElement('li');
    li.textContent = t;
    tipsList.appendChild(li);
  });

  setFeedback('Get into position and begin!', 'default', '🎯');
  stateBadge.textContent = 'READY';
  stateBadge.className = 'state-badge';
  resetPhase();

  showScreen('exercise');
  socket.emit('start', { mode: cfg.mode, reps: cfg.reps, sets: cfg.sets });
  
  sound.playRestGo();
  if (settings.metronome) startMetronome();
}

// ── Stop ───────────────────────────────────────────────────────
$('btn-stop').addEventListener('click', () => {
  stopMetronome();
  if (restTimerId) { clearInterval(restTimerId); restTimerId = null; }
  if (restOverlay) restOverlay.style.display = 'none';
  socket.emit('stop');
  sessionState = 'setup';
  showScreen('setup');
});

// ── Socket events ──────────────────────────────────────────────
socket.on('py_event', (data) => {
  if (data.type === 'speak') {
    voiceSpeak(data.text);
    return;
  }

  if (data.type === 'error') {
    alert('⚠️ Python Error: ' + data.message + '\n\nCheck that Python is installed and the model file exists.');
    sessionState = 'setup';
    showScreen('setup');
    return;
  }

  if (data.type === 'stopped' && sessionState === 'running') {
    stopMetronome();
    sessionState = 'setup';
    showScreen('setup');
    return;
  }

  if (data.type === 'frame' && sessionState === 'running') {
    if (cameraEnabled && videoFeed) {
      videoFeed.src = 'data:image/jpeg;base64,' + data.data;
      const computed = window.getComputedStyle(videoFeed);
      if (computed.display === 'none') {
        videoFeed.style.display = 'block';
      }
      if (videoPlaceholder) {
        videoPlaceholder.style.display = 'none';
      }
    } else if (!cameraEnabled) {
      if (videoFeed) videoFeed.style.display = 'none';
      if (videoPlaceholder) {
        videoPlaceholder.style.display = 'flex';
        videoPlaceholder.style.visibility = 'visible';
        videoPlaceholder.textContent = 'Camera is Turned OFF. Enable it from the top-right button.';
      }
    }
    return;
  }

  if (sessionState !== 'running' || !cameraEnabled) return;

  if (data.type === 'status') {
    handleStatus(data);
  } else if (data.type === 'session_complete') {
    handleSetComplete(data);
  }
});

// ── Status handler ─────────────────────────────────────────────
function handleStatus(d) {
  // Push raw angle to waveform graph
  if (chart && d.angle !== undefined && d.angle !== null) {
    chart.push(d.angle, d.color);
    const liveValDisplay = $('live-angle-val');
    if (liveValDisplay) liveValDisplay.textContent = d.angle + '°';
  }

  // Rep counter
  const rep = d.rep ?? 0;
  const targetReps = d.target_reps ?? cfg.reps;

  if (rep !== lastRepCount) {
    if (rep > lastRepCount) {
      flashRep('+1');
    }
    lastRepCount = rep;
  }
  repCounter.textContent = rep;
  repOf.textContent = `/ ${targetReps}`;
  updateRing(rep, targetReps);

  // Correct / incorrect
  const curCorr = d.correct ?? 0;
  const curIncorr = d.incorrect ?? 0;
  
  if (curCorr > lastCorrectCount) {
    sound.playSuccess();
    lastCorrectCount = curCorr;
  }
  if (curIncorr > lastIncorrectCount) {
    sound.playError();
    lastIncorrectCount = curIncorr;
  }
  
  correctCount.textContent   = curCorr;
  incorrectCount.textContent = curIncorr;

  // Track session errors for insights
  if (d.color === 'red' || d.color === 'orange') {
    if (d.feedback && d.feedback !== 'Keep going…') {
      sessionErrors.add(d.feedback);
    }
  }

  // Accuracy
  const total = curCorr + curIncorr;
  if (total > 0) {
    const acc = Math.round((curCorr / total) * 100);
    accuracyPct.textContent = acc + '%';
    updateAccRing(acc);
    accFill.style.stroke = acc >= 70 ? 'var(--green)' : acc >= 40 ? 'var(--orange)' : 'var(--red)';
  }

  // Session overall progress (sets * reps)
  const totalRepsSession = cfg.sets * cfg.reps;
  const doneRepsSession  = (currentSet - 1) * cfg.reps + rep;
  const pct = Math.min(100, Math.round((doneRepsSession / totalRepsSession) * 100));
  sessionFill.style.width  = pct + '%';
  progressPct.textContent  = pct + '%';

  // State badge
  const st = (d.state ?? '').toLowerCase();
  stateBadge.textContent = (d.state ?? 'READY').toUpperCase();
  stateBadge.className = 'state-badge' + (
    st.includes('down') || st.includes('sitting') ? ' state-down' :
    st.includes('up')   || st.includes('stand')   ? ' state-up'   : '');

  // Phase indicator
  updatePhase(st);

  // Feedback
  const fb  = d.feedback ?? '';
  const col = d.color    ?? 'green';
  setFeedback(fb || 'Keep going…', col, ICONS[col] ?? '🎯');
}

// ── Set / session complete handler ─────────────────────────────
function handleSetComplete(d) {
  const now = Date.now();
  if (now - lastSetCompleteTime < 4000) return;
  lastSetCompleteTime = now;

  stopMetronome();

  if (currentSet < cfg.sets) {
    showRestTimer(currentSet, d);
  } else {
    sessionState = 'complete';
    socket.emit('stop');
    voiceSpeak("Session complete! Excellent job, you have completed all your sets!");
    
    // Save to history logs
    const sessionLog = {
      date: new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
      mode: cfg.mode,
      sets: cfg.sets,
      reps: cfg.reps,
      correct: d.correct ?? 0,
      incorrect: d.incorrect ?? 0,
      total: d.total ?? 0,
      accuracy: d.total > 0 ? Math.round(((d.correct ?? 0) / d.total) * 100) : 0
    };
    let historyLogs = JSON.parse(localStorage.getItem('physioai_history')) || [];
    historyLogs.unshift(sessionLog);
    if (historyLogs.length > 20) historyLogs.pop();
    localStorage.setItem('physioai_history', JSON.stringify(historyLogs));
    
    showComplete(d);
  }
}

// ── Rest timer between sets ─────────────────────────────────────
function showRestTimer(completedSet, d) {
  const correct   = d.correct   ?? 0;
  const incorrect = d.incorrect ?? 0;
  const total     = correct + incorrect;
  const acc       = total > 0 ? Math.round((correct / total) * 100) : 0;
  
  restPrevStats.innerHTML = `
    <div class="rps-item"><span class="rps-val" style="color:var(--green)">${correct}</span><span class="rps-lbl">Correct</span></div>
    <div class="rps-item"><span class="rps-val" style="color:var(--red)">${incorrect}</span><span class="rps-lbl">Errors</span></div>
    <div class="rps-item"><span class="rps-val" style="color:var(--accent2)">${acc}%</span><span class="rps-lbl">Accuracy</span></div>
  `;

  restOverlay.style.display = 'flex';
  restOverlay.style.animation = 'none';
  restOverlay.offsetHeight;
  restOverlay.style.animation = '';

  let duration = parseInt(settings.restDuration);
  let remaining = duration;
  restCountdown.textContent    = remaining;
  restBarFill.style.transition = 'none';
  restBarFill.style.width      = '100%';

  voiceSpeak(`Set ${completedSet} complete! Rest for ${duration} seconds.`);

  requestAnimationFrame(() => {
    restBarFill.style.transition = `width ${duration}s linear`;
    restBarFill.style.width      = '0%';
  });

  if (restTimerId) clearInterval(restTimerId);

  const skipBtn = $('btn-skip-rest');
  const skipHandler = () => {
    if (restTimerId) { clearInterval(restTimerId); restTimerId = null; }
    window.speechSynthesis && window.speechSynthesis.cancel();
    skipBtn.removeEventListener('click', skipHandler);
    advanceToNextSet();
  };
  skipBtn.addEventListener('click', skipHandler);

  restTimerId = setInterval(() => {
    remaining--;
    restCountdown.textContent = remaining;

    restCountdown.style.transform = 'scale(1.15)';
    setTimeout(() => { restCountdown.style.transform = 'scale(1)'; }, 120);

    if (remaining === 10) voiceSpeak('10 seconds remaining. Get ready!');
    if (remaining === 5)  voiceSpeak('5 seconds!');
    if (remaining === 3)  { voiceSpeak('3'); sound.playRestPip(); }
    if (remaining === 2)  { voiceSpeak('2'); sound.playRestPip(); }
    if (remaining === 1)  { voiceSpeak('1'); sound.playRestPip(); }

    if (remaining <= 0) {
      clearInterval(restTimerId);
      restTimerId = null;
      skipBtn.removeEventListener('click', skipHandler);
      advanceToNextSet();
    }
  }, 1000);
}

function advanceToNextSet() {
  restOverlay.style.display = 'none';
  currentSet++;
  buildSetDots(cfg.sets, currentSet);
  setCounter.textContent = currentSet;
  lastRepCount = 0;
  lastCorrectCount = 0;
  lastIncorrectCount = 0;
  socket.emit('next_set', { set: currentSet, reps: cfg.reps });
  setFeedback(`Set ${currentSet} — Go!`, 'green', '🚀');
  
  sound.playRestGo();
  if (settings.metronome) startMetronome();
}

// ── Complete screen ────────────────────────────────────────────
function showComplete(d) {
  const cs = $('complete-stats');
  const total    = d.total    ?? 0;
  const correct  = d.correct  ?? 0;
  const incorrect= d.incorrect?? 0;
  const acc = total > 0 ? Math.round((correct / total) * 100) : 0;
  const grade = acc >= 90 ? '🥇 Excellent' : acc >= 70 ? '🥈 Good' : acc >= 50 ? '🥉 Average' : '📈 Keep Practicing';

  cs.innerHTML = `
    <div class="cstat"><div class="cstat-val" style="color:var(--accent2)">${cfg.sets}</div><div class="cstat-lbl">Sets Done</div></div>
    <div class="cstat"><div class="cstat-val" style="color:var(--green)">${correct}</div><div class="cstat-lbl">Correct Reps</div></div>
    <div class="cstat"><div class="cstat-val" style="color:var(--orange)">${incorrect}</div><div class="cstat-lbl">Needs Work</div></div>
    <div class="cstat" style="grid-column:span 3"><div class="cstat-val" style="color:var(--accent)">${acc}%</div><div class="cstat-lbl">${grade}</div></div>
  `;
  
  // Render coaching insights
  const insightsText = $('insights-text');
  if (insightsText) {
    if (sessionErrors.size > 0) {
      // Pick up to two distinct errors to report
      const errorList = Array.from(sessionErrors);
      const tips = errorList.slice(0, 2).map(err => {
        const text = INSIGHTS_MAP[err] || `Check your posture on warnings ("${err}").`;
        return `• <strong>${err}:</strong> ${text}`;
      }).join('<br><br>');
      insightsText.innerHTML = tips;
    } else {
      insightsText.innerHTML = "🌟 <strong>Perfect Form!</strong> You completed all repetitions with exceptional range of motion, symmetry, and posture. Fantastic job!";
    }
  }

  showScreen('complete');
  sound.playSessionComplete();
  confetti.start();
}

$('btn-again').addEventListener('click', () => startSession());
$('btn-home').addEventListener('click', () => { sessionState = 'setup'; showScreen('setup'); });

// ── Helpers ────────────────────────────────────────────────────
function setFeedback(text, color, icon) {
  feedbackText.textContent = text;
  feedbackIcon.textContent = icon;
  feedbackBox.className = 'feedback-box' + (color !== 'default' ? ` fb-${color}` : '');
}

function flashRep(label) {
  repFlash.textContent = label;
  repFlash.style.animation = 'none';
  repFlash.offsetHeight;
  repFlash.style.animation = 'flash .7s ease forwards';
}

function updateRing(rep, target) {
  const circ = 314;
  const pct  = target > 0 ? Math.min(rep / target, 1) : 0;
  ringFill.style.strokeDashoffset = circ - pct * circ;
}

function updateAccRing(pct) {
  const circ = 251;
  accFill.style.strokeDashoffset = pct != null ? circ - (pct / 100) * circ : circ;
}

function buildSetDots(total, active) {
  setDots.innerHTML = '';
  for (let i = 1; i <= total; i++) {
    const d = document.createElement('div');
    d.className = 'set-dot' + (i < active ? ' done' : i === active ? ' active' : '');
    setDots.appendChild(d);
  }
}

function resetPhase() {
  ['ph-down','ph-up'].forEach(id => {
    const el = $(id);
    if(el) el.classList.remove('active');
  });
}

function updatePhase(state) {
  resetPhase();
  if (state.includes('down') || state.includes('sitting') || state.includes('flexion')) {
    const downItem = $('ph-down');
    if (downItem) downItem.classList.add('active');
  } else if (state.includes('up') || state.includes('extension') || state.includes('stand')) {
    const upItem = $('ph-up');
    if (upItem) upItem.classList.add('active');
  }
}

function modeLabel(m) {
  return { SQUATS:'Squats', STS:'Sit to Stand', LUNGES:'Lunges', SHOULDER_ABD:'Shoulder Abduction' }[m] || m;
}

// ── Personal history UI binding ───────────────────────────────
function updateHistoryUI() {
  const historyLogs = JSON.parse(localStorage.getItem('physioai_history')) || [];
  
  const totalWorkoutsVal = $('stats-total-workouts');
  const avgAccuracyVal = $('stats-avg-accuracy');
  const streakVal = $('stats-streak');
  const historyList = $('history-list');
  
  if (totalWorkoutsVal) totalWorkoutsVal.textContent = historyLogs.length;
  
  if (avgAccuracyVal) {
    let sumAcc = 0;
    historyLogs.forEach(h => sumAcc += h.accuracy);
    avgAccuracyVal.textContent = historyLogs.length > 0 ? Math.round(sumAcc / historyLogs.length) + '%' : '—';
  }
  
  if (streakVal) {
    const uniqueDays = new Set(historyLogs.map(h => h.date.split(',')[0]));
    streakVal.textContent = uniqueDays.size;
  }
  
  if (historyList) {
    historyList.innerHTML = '';
    if (historyLogs.length === 0) {
      historyList.innerHTML = '<li class="history-empty">No workouts completed yet. Your logs will appear here!</li>';
      return;
    }
    
    historyLogs.forEach(h => {
      const li = document.createElement('li');
      li.className = 'history-item';
      
      const accClass = h.accuracy >= 80 ? 'acc-good' : h.accuracy >= 50 ? 'acc-mid' : 'acc-poor';
      const labelStr = modeLabel(h.mode);
      
      li.innerHTML = `
        <div class="history-item-left">
          <span class="history-item-name">${labelStr}</span>
          <span class="history-item-date">${h.date}</span>
        </div>
        <div class="history-item-right">
          <span class="history-badge">${h.sets}s × ${h.reps}r</span>
          <span class="history-badge ${accClass}">${h.accuracy}% Acc</span>
        </div>
      `;
      historyList.appendChild(li);
    });
  }
}

const clearHistoryBtn = $('btn-clear-history');
if (clearHistoryBtn) {
  clearHistoryBtn.addEventListener('click', () => {
    if (confirm('⚠️ Clear History?\n\nAre you sure you want to permanently delete your training logs?')) {
      localStorage.removeItem('physioai_history');
      updateHistoryUI();
    }
  });
}

// ── Settings modal event bindings ─────────────────────────────
const settingsToggleBtn = $('btn-settings-toggle');
const settingsCloseBtn = $('btn-settings-close');
const settingsModal = $('settings-modal');

if (settingsToggleBtn && settingsModal) {
  settingsToggleBtn.addEventListener('click', () => {
    settingsModal.style.display = 'flex';
    sound.init(); // Initialize context on user click
  });
}
if (settingsCloseBtn && settingsModal) {
  settingsCloseBtn.addEventListener('click', () => {
    settingsModal.style.display = 'none';
  });
}

// Sliders and toggles logic
const restDurInput = $('setting-rest-duration');
const restDurVal = $('val-rest-duration');
const volumeInput = $('setting-volume');
const volumeVal = $('val-volume');
const metronomeBtn = $('setting-metronome');
const mirrorBtn = $('setting-mirror');

// Initialize settings fields in DOM
if (restDurInput && restDurVal) {
  restDurInput.value = settings.restDuration;
  restDurVal.textContent = settings.restDuration + 's';
  
  restDurInput.addEventListener('input', (e) => {
    settings.restDuration = e.target.value;
    restDurVal.textContent = e.target.value + 's';
    localStorage.setItem('physioai_settings', JSON.stringify(settings));
  });
}

if (volumeInput && volumeVal) {
  volumeInput.value = settings.volume;
  volumeVal.textContent = settings.volume + '%';
  
  volumeInput.addEventListener('input', (e) => {
    settings.volume = e.target.value;
    volumeVal.textContent = e.target.value + '%';
    localStorage.setItem('physioai_settings', JSON.stringify(settings));
  });
  
  // Play quick click sound on release to test volume
  volumeInput.addEventListener('change', () => {
    sound.playTick();
  });
}

if (metronomeBtn) {
  metronomeBtn.className = 'btn-toggle ' + (settings.metronome ? 'toggle-on' : 'toggle-off');
  metronomeBtn.addEventListener('click', () => {
    settings.metronome = !settings.metronome;
    metronomeBtn.className = 'btn-toggle ' + (settings.metronome ? 'toggle-on' : 'toggle-off');
    localStorage.setItem('physioai_settings', JSON.stringify(settings));
    sound.playTick();
  });
}

if (mirrorBtn) {
  mirrorBtn.className = 'btn-toggle ' + (settings.mirror ? 'toggle-on' : 'toggle-off');
  mirrorBtn.addEventListener('click', () => {
    settings.mirror = !settings.mirror;
    mirrorBtn.className = 'btn-toggle ' + (settings.mirror ? 'toggle-on' : 'toggle-off');
    localStorage.setItem('physioai_settings', JSON.stringify(settings));
    sound.playTick();
    
    // Apply immediately to videoFeed if active
    if (videoFeed) {
      if (settings.mirror) videoFeed.classList.add('mirrored');
      else videoFeed.classList.remove('mirrored');
    }
  });
}

// Close modal when clicking outside the card
if (settingsModal) {
  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) {
      settingsModal.style.display = 'none';
    }
  });
}

// ── Inject SVG gradient for ring ──────────────────────────────
(function injectGrad() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.id = 'svg-defs'; svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
  svg.innerHTML = `<defs>
    <linearGradient id="ringGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%"   stop-color="#6c63ff"/>
      <stop offset="100%" stop-color="#00d9ff"/>
    </linearGradient>
  </defs>`;
  document.body.appendChild(svg);
  if (ringFill) ringFill.setAttribute('stroke','url(#ringGrad)');
})();

// Socket connection camera state synchronization
socket.on('connect', () => {
  console.log('Socket.io connected to server, syncing camera state:', cameraEnabled);
  socket.emit('camera_toggle', { enabled: cameraEnabled });
});

// Init
if (videoFeed) videoFeed.style.display = 'none';

const setupToggle = $('btn-camera-toggle-setup');
const exToggle = $('btn-camera-toggle-ex');
if (setupToggle) setupToggle.addEventListener('click', () => toggleCamera());
if (exToggle) exToggle.addEventListener('click', () => toggleCamera());

const setupVoiceToggle = $('btn-voice-toggle-setup');
const exVoiceToggle = $('btn-voice-toggle-ex');
if (setupVoiceToggle) setupVoiceToggle.addEventListener('click', () => toggleVoice());
if (exVoiceToggle) exVoiceToggle.addEventListener('click', () => toggleVoice());

updateCameraUI(cameraEnabled);
updateVoiceUI(voiceEnabled);

// Create real-time chart instance
chart = new WaveformChart('waveform-canvas');

// Show setup screen & render history
showScreen('setup');
