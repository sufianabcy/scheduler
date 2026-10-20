import { useEffect, useRef, useState } from 'preact/hooks';
import { Icon } from './Icon.jsx';

// The app tour: a short walkthrough of what Planner does, one screen per feature. It opens by itself the first time
// someone logs in on a device, and again from More → App tour. "Seen" is remembered per user in this browser only.

const seenKey = (userId) => `planner.tourSeen.${userId}`;

export function tourSeen(userId) {
  try {
    return localStorage.getItem(seenKey(userId)) === '1';
  } catch {
    return true; // storage blocked (private mode): don't nag on every visit
  }
}

function markSeen(userId) {
  try {
    localStorage.setItem(seenKey(userId), '1');
  } catch {
    // Fine: it just shows again next time.
  }
}

/* ---------- The small pictures, drawn with the app's own parts ---------- */

function FakeCheck({ done, prio }) {
  return (
    <span class={`check${prio ? ` prio-${prio}` : ''}`} aria-checked={done ? 'true' : 'false'}>
      <Icon name="check" size={13} stroke-width={3.4} />
    </span>
  );
}

function FakeTask({ title, done, prio, meta }) {
  return (
    <div class={`tour-row${done ? ' is-done' : ''}`}>
      <FakeCheck done={done} prio={prio} />
      <div class="row-main">
        <div class="row-title">{title}</div>
        {meta && <div class="row-meta meta-line">{meta}</div>}
      </div>
    </div>
  );
}

const PICTURES = {
  welcome: () => (
    <div class="tour-pic tour-pic-center">
      <img class="tour-logo" src="/icons/icon-192.png" alt="" />
    </div>
  ),
  today: () => (
    <div class="tour-pic">
      <div class="tour-mini-head">
        <strong>Tuesday</strong>
        <span>2 of 3 done</span>
      </div>
      <div class="tour-bar">
        <span style={{ width: '66%' }} />
      </div>
      <FakeTask title="Morning run" done />
      <FakeTask title="Submit lab record" done prio={1} />
      <FakeTask title="Call the bank" prio={2} meta={<span><Icon name="bell" size={12} /> 3:00 PM</span>} />
    </div>
  ),
  quickAdd: () => (
    <div class="tour-pic">
      <div class="tour-input">
        gym tomorrow 7am every mon wed p1<span class="tour-caret" />
      </div>
      <div class="tour-arrow">
        <Icon name="down" size={18} />
      </div>
      <div class="tour-chips">
        <span class="tour-chip"><Icon name="calendar" size={13} /> Tomorrow</span>
        <span class="tour-chip"><Icon name="bell" size={13} /> 7:00 AM</span>
        <span class="tour-chip"><Icon name="repeat" size={13} /> Every Mon, Wed</span>
        <span class="tour-chip prio-text prio-1"><Icon name="flag" size={13} /> P1</span>
      </div>
    </div>
  ),
  plan: () => (
    <div class="tour-pic">
      <div class="tour-tabs">
        <span>Day</span>
        <span>Goals</span>
        <span class="is-on">Projects</span>
      </div>
      <div class="tour-mini-head">
        <strong>Portfolio site</strong>
        <span>50%</span>
      </div>
      <div class="tour-bar">
        <span style={{ width: '50%' }} />
      </div>
      <div class="tour-step is-done"><Icon name="check" size={14} /> Design</div>
      <div class="tour-step is-now"><Icon name="steps" size={14} /> Backend</div>
      <div class="tour-step is-locked"><Icon name="lock" size={14} /> Frontend</div>
    </div>
  ),
  reminders: () => (
    <div class="tour-pic tour-pic-center">
      <div class="tour-notice">
        <img src="/icons/icon-192.png" alt="" />
        <div>
          <strong>Plan tomorrow</strong>
          <span>Nothing planned for tomorrow yet. Two minutes now saves your morning.</span>
        </div>
        <em>11:00 PM</em>
      </div>
      <div class="tour-notice is-second">
        <img src="/icons/icon-192.png" alt="" />
        <div>
          <strong>Today: 3 tasks</strong>
          <span>Morning run · Submit lab record · Call the bank</span>
        </div>
        <em>6:00 AM</em>
      </div>
    </div>
  ),
  mail: () => (
    <div class="tour-pic">
      <div class="tour-mail">
        <span class="tour-dot" />
        <div class="row-main">
          <div class="row-title">Team standup moved to 10:30</div>
          <div class="row-meta">Ravi Kumar · Hi all, tomorrow we start at 10:30…</div>
        </div>
        <Icon name="star" size={16} class="tour-star" />
      </div>
      <div class="tour-mail-actions">
        <span class="tour-btn is-primary"><Icon name="plus" size={14} /> Make task</span>
        <span class="tour-btn"><Icon name="external" size={14} /> Open in Gmail</span>
      </div>
      <FakeTask title="Team standup moved to 10:30" meta={<span><Icon name="mail" size={12} /> Open mail</span>} />
    </div>
  ),
  lms: () => (
    <div class="tour-pic">
      <div class="tour-mini-head">
        <strong>LMS</strong>
        <span class="prio-text prio-1">1 overdue</span>
      </div>
      <div class="tour-lms">
        <div class="row-main">
          <div class="row-title">Lab report 3</div>
          <div class="row-meta prio-text prio-1">Was due Sun 10:00 AM</div>
        </div>
        <span class="badge badge-red">Overdue</span>
      </div>
      <div class="tour-lms">
        <div class="row-main">
          <div class="row-title">Quiz 2</div>
          <div class="row-meta">Due Thu 5:00 PM</div>
        </div>
      </div>
    </div>
  ),
  more: () => (
    <div class="tour-pic">
      <div class="tour-setting"><Icon name="moon" size={16} /> Dark or light theme</div>
      <div class="tour-setting"><Icon name="bell" size={16} /> Notification times</div>
      <div class="tour-setting"><Icon name="lock" size={16} /> Change your password</div>
      <div class="tour-setting"><Icon name="home" size={16} /> Install as an app</div>
    </div>
  ),
};

const STEPS = [
  {
    pic: 'welcome',
    title: 'Welcome to Planner',
    text: 'Plan your day, keep your monthly goals moving and finish projects one step at a time. This takes about a minute.',
  },
  {
    pic: 'today',
    title: 'Today is your home',
    text: "Your checklist for the day. Tick tasks as you go and the bar fills up. Anything still open at midnight moves to Unfinished, so nothing gets lost.",
  },
  {
    pic: 'quickAdd',
    title: 'Add a task in one line',
    text: 'Type it the way you would say it. Planner picks out the day, the reminder time, the repeat and the priority (p1 is the most important).',
  },
  {
    pic: 'plan',
    title: 'Plan: days, goals and projects',
    text: 'Day plans any date. Goals are this month’s targets, each with its own tasks. Projects are steps that unlock one after another, with a progress %.',
  },
  {
    pic: 'reminders',
    title: 'Reminders that keep you on track',
    text: 'Turn on notifications: at 11 PM you’re asked to plan tomorrow, at 6 AM you get today’s plan, and any task can have its own reminder.',
  },
  {
    pic: 'mail',
    title: 'Mail that turns into tasks',
    text: 'Connect Gmail in the Mail tab. Star what matters and use Make task to put a mail on your list, linked back to it.',
  },
  {
    pic: 'lms',
    title: 'Your LMS deadlines on Today',
    text: 'Connect your KL University LMS once. Assignments and quizzes sync every 2 hours; overdue work shows in red, and you’re told if something is missed.',
  },
  {
    pic: 'more',
    title: 'Make it yours',
    text: 'More has the theme, notification times, your password and how to install Planner as an app. You can watch this tour again from there too.',
  },
];

/** The tour itself, as a modal dialog. Arrow keys and swipes move between steps; Esc or Skip closes it. */
export function Tour({ userId, onClose }) {
  const dialog = useRef();
  const touch = useRef(null);
  const [step, setStep] = useState(0);
  const last = step === STEPS.length - 1;
  const { pic, title, text } = STEPS[step];
  const Picture = PICTURES[pic];

  useEffect(() => {
    const d = dialog.current;
    if (!d.open) d.showModal();
    return () => d.open && d.close();
  }, []);

  const close = () => {
    markSeen(userId);
    onClose();
  };
  const go = (n) => setStep(Math.max(0, Math.min(STEPS.length - 1, n)));

  const onKeyDown = (e) => {
    if (e.key === 'ArrowRight') go(step + 1);
    if (e.key === 'ArrowLeft') go(step - 1);
  };
  const onTouchStart = (e) => {
    touch.current = e.touches[0].clientX;
  };
  const onTouchEnd = (e) => {
    if (touch.current === null) return;
    const dx = e.changedTouches[0].clientX - touch.current;
    touch.current = null;
    if (Math.abs(dx) > 50) go(step + (dx < 0 ? 1 : -1));
  };

  return (
    <dialog
      ref={dialog}
      class="tour"
      aria-labelledby="tour-title"
      aria-describedby="tour-text"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onKeyDown={onKeyDown}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      <div class="tour-top">
        <span class="tour-count">
          {step + 1} of {STEPS.length}
        </span>
        {!last && (
          <button type="button" class="btn btn-ghost btn-small" onClick={close}>
            Skip
          </button>
        )}
      </div>

      <div class="tour-slide" key={step}>
        <div class="tour-stage" aria-hidden="true">
          <Picture />
        </div>
        <h2 id="tour-title" class="tour-title">
          {title}
        </h2>
        <p id="tour-text" class="tour-text">
          {text}
        </p>
      </div>

      <div class="tour-dots" role="group" aria-label="Tour steps">
        {STEPS.map((s, n) => (
          <button
            key={s.pic}
            type="button"
            class="tour-dot-btn"
            aria-label={`Step ${n + 1}: ${s.title}`}
            aria-current={n === step ? 'step' : undefined}
            onClick={() => go(n)}
          />
        ))}
      </div>

      <div class="tour-actions">
        {step > 0 ? (
          <button type="button" class="btn" onClick={() => go(step - 1)}>
            <Icon name="left" size={16} /> Back
          </button>
        ) : (
          <span />
        )}
        <button type="button" class="btn btn-primary" autofocus onClick={() => (last ? close() : go(step + 1))}>
          {last ? 'Start planning' : 'Next'} {!last && <Icon name="right" size={16} />}
        </button>
      </div>
    </dialog>
  );
}
