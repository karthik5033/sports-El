/* ── app.js — PhysioAI frontend logic ──────────────────────── */
const socket = io();

// ── State ──────────────────────────────────────────────────────
let cfg = { mode: 'SQUATS', reps: 10, sets: 3 };
let sessionState = 'setup';   // 'setup' | 'running' | 'complete'
let currentSet   = 1;
let lastRepCount = 0;
let lastSetCompleteTime = 0;  // debounce: ignore duplicate session_complete events
let cameraEnabled = false;
let browserStream = null;
let voiceEnabled = true; // Voice guidance enabled by default
let lastSpokenFeedback = '';

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

const REST_DURATION = 30; // seconds between sets
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

// ── Screen helpers ─────────────────────────────────────────────
function showScreen(name) {
  Object.values(screens).forEach(s => { s.classList.remove('active'); s.style.display = 'none'; });
  const s = screens[name];
  s.style.display = 'flex';
  requestAnimationFrame(() => s.classList.add('active'));
}

// ── Setup screen ───────────────────────────────────────────────
let reps = 10, sets = 3;

// ── Exercise preview data ──────────────────────────────────────
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
    u.rate = 1.15; // Slightly faster for quick fluid guidance
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
      // Ask user for browser camera permission with a timeout for headless environments
      const streamPromise = navigator.mediaDevices.getUserMedia({ video: true });
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error("Timeout")), 3000)
      );
      
      browserStream = await Promise.race([streamPromise, timeoutPromise]).catch(err => {
        console.warn("Camera check bypassed/timed out, continuing to backend:", err.message);
        return null;
      });
      
      if (browserStream) {
        // Stop the browser stream track immediately to save resources,
        // as backend OpenCV is doing the actual capturing.
        browserStream.getTracks().forEach(track => track.stop());
        browserStream = null;
      }
      
      cameraEnabled = true;
      updateCameraUI(true);
      socket.emit('camera_toggle', { enabled: true });
      
      // Reset UI elements if running
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
    
    // Hide active video feed and show off placeholder if running
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

// ── Session start ──────────────────────────────────────────────
async function startSession() {
  if (!cameraEnabled) {
    const proceed = confirm('📷 Camera is currently OFF.\n\nWould you like to turn it ON and grant camera permissions to start tracking your movements?');
    if (proceed) {
      await toggleCamera(true);
      if (!cameraEnabled) {
        // User denied or failed to turn camera ON, abort session start
        return;
      }
    } else {
      return;
    }
  }

  currentSet   = 1;
  lastRepCount = 0;
  lastSetCompleteTime = 0;
  sessionState = 'running';

  // Cancel any in-progress rest timer from a previous set
  if (restTimerId) { clearInterval(restTimerId); restTimerId = null; }
  if (restOverlay) restOverlay.style.display = 'none';

  // Reset video feed
  if (videoFeed) {
    videoFeed.style.display = 'none';
    videoFeed.src = '';
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
}

// ── Stop ───────────────────────────────────────────────────────
$('btn-stop').addEventListener('click', () => {
  // Cancel rest timer if it is running
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
    sessionState = 'setup';
    showScreen('setup');
    return;
  }

  if (data.type === 'frame' && sessionState === 'running') {
    if (cameraEnabled && videoFeed) {
      videoFeed.src = 'data:image/jpeg;base64,' + data.data;
      // Use computed style to correctly detect hidden state (CSS rule vs inline style)
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
  correctCount.textContent   = d.correct   ?? 0;
  incorrectCount.textContent = d.incorrect ?? 0;

  // Accuracy
  const total = (d.correct ?? 0) + (d.incorrect ?? 0);
  if (total > 0) {
    const acc = Math.round((d.correct / total) * 100);
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
  // Debounce: ignore rapid duplicate events
  const now = Date.now();
  if (now - lastSetCompleteTime < 4000) return;
  lastSetCompleteTime = now;

  if (currentSet < cfg.sets) {
    // Show rest timer with stats from the just-completed set
    showRestTimer(currentSet, d);
  } else {
    // All sets done
    sessionState = 'complete';
    socket.emit('stop');
    voiceSpeak("Session complete! Excellent job, you have completed all your sets!");
    showComplete(d);
  }
}

// ── Rest timer between sets ─────────────────────────────────────
function showRestTimer(completedSet, d) {
  // Populate previous-set stats inside the overlay
  const correct   = d.correct   ?? 0;
  const incorrect = d.incorrect ?? 0;
  const total     = correct + incorrect;
  const acc       = total > 0 ? Math.round((correct / total) * 100) : 0;
  restPrevStats.innerHTML = `
    <div class="rps-item"><span class="rps-val" style="color:var(--green)">${correct}</span><span class="rps-lbl">Correct</span></div>
    <div class="rps-item"><span class="rps-val" style="color:var(--red)">${incorrect}</span><span class="rps-lbl">Errors</span></div>
    <div class="rps-item"><span class="rps-val" style="color:var(--accent2)">${acc}%</span><span class="rps-lbl">Accuracy</span></div>
  `;

  // Show overlay
  restOverlay.style.display = 'flex';
  restOverlay.style.animation = 'none';
  restOverlay.offsetHeight;
  restOverlay.style.animation = '';

  let remaining = REST_DURATION;
  restCountdown.textContent    = remaining;
  restBarFill.style.transition = 'none';
  restBarFill.style.width      = '100%';



  voiceSpeak(`Set ${completedSet} complete! Rest for ${REST_DURATION} seconds.`);

  // Kick off progress bar shrink
  requestAnimationFrame(() => {
    restBarFill.style.transition = `width ${REST_DURATION}s linear`;
    restBarFill.style.width      = '0%';
  });

  if (restTimerId) clearInterval(restTimerId);

  // Wire skip button
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

    // Pulse on tick
    restCountdown.style.transform = 'scale(1.18)';
    setTimeout(() => { restCountdown.style.transform = 'scale(1)'; }, 120);

    if (remaining === 10) voiceSpeak('10 seconds remaining. Get ready!');
    if (remaining === 5)  voiceSpeak('5 seconds. Get ready!');
    if (remaining === 3)  voiceSpeak('3');
    if (remaining === 2)  voiceSpeak('2');
    if (remaining === 1)  voiceSpeak('1');

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
  socket.emit('next_set', { set: currentSet, reps: cfg.reps });
  setFeedback(`Set ${currentSet} — Go!`, 'green', '🚀');
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
  showScreen('complete');
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
  repFlash.offsetHeight; // reflow
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
    $('ph-down').classList.add('active');
  } else if (state.includes('up') || state.includes('extension') || state.includes('stand')) {
    $('ph-up').classList.add('active');
  }
}

function modeLabel(m) {
  return { SQUATS:'Squats', STS:'Sit to Stand', LUNGES:'Lunges', SHOULDER_ABD:'Shoulder Abduction' }[m] || m;
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
  ringFill.setAttribute('stroke','url(#ringGrad)');
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
showScreen('setup');
