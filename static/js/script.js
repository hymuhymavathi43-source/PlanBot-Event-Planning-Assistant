/* PlanBot front end: persistent conversations, event planning, and the saved-plan dashboard. */
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const ACTIVE_CHAT_KEY = 'planbot.activeConversation.v1';
const GUEST_CONVERSATIONS_KEY = 'planbot.guestConversations.v1';
const THEME_KEY = 'planbot.theme';
const COLLAPSED_KEY = 'planbot.sidebar.collapsed';
const EVENT_TYPES = ['Birthday Party', 'Wedding', 'College Event', 'Corporate Event', 'Engagement', 'Anniversary'];
let toastTimer;

function notify(message, error = false) {
  const toast = $('#toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.toggle('error', error);
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3000);
}

async function api(url, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const tokenResponse = await fetchPlanBot('/api/auth/csrf', {credentials: 'same-origin'});
    if (!tokenResponse.ok) throw new Error('Could not verify this request. Please reload and try again.');
    const token = await tokenResponse.json();
    headers.set('X-CSRF-Token', token.csrf_token);
  }
  const response = await fetchPlanBot(url, {...options, method, headers, credentials: 'same-origin'});
  let data;
  try { data = await response.json(); }
  catch { throw new Error('The server returned an unreadable response.'); }
  if (!response.ok) {
    const fieldErrors = Object.values(data.fields || {}).join(' ');
    throw new Error(fieldErrors || data.error || 'Something went wrong. Please try again.');
  }
  return data;
}

async function fetchPlanBot(url, options) {
  try {
    return await fetch(url, options);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error('Cannot reach the PlanBot server. Run `python app.py` in the project folder, then open http://127.0.0.1:5000.');
    }
    throw error;
  }
}

function formatMoney(amount) {
  const value = Number(amount);
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 0,
    maximumFractionDigits: Number.isInteger(value) ? 0 : 2
  }).format(value);
}

function parseMoneyAmount(raw) {
  const normalized = String(raw)
    .trim()
    .replace(/^(?:₹|INR|Rs\.?)\s*/i, '')
    .replace(/(?:\s*(?:rupees?|INR|Rs\.?))$/i, '')
    .replace(/,/g, '')
    .trim()
    .toLowerCase();
  const match = normalized.match(/^(\d+(?:\.\d{1,2})?)\s*(thousands?|k|lakhs?|lacs?|l|crores?|cr)?$/);
  if (!match) return 0;
  const unit = match[2] || '';
  const multiplier = /^(?:k|thousands?)$/.test(unit)
    ? 1000
    : /^(?:l|lakhs?|lacs?)$/.test(unit)
      ? 100000
      : /^(?:cr|crores?)$/.test(unit)
        ? 10000000
        : 1;
  const amount = Number(match[1]) * multiplier;
  return Number.isFinite(amount) ? amount : 0;
}

function normalizeDate(value) {
  const text = String(value).trim();
  let year;
  let month;
  let day;
  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) {
    [, year, month, day] = match.map(Number);
  } else {
    match = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (!match) return '';
    [, day, month, year] = match.map(Number);
  }
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return '';
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function formatDate(value) {
  if (!value) return 'Date to be decided';
  const normalized = normalizeDate(value);
  if (!normalized) return 'Date to be decided';
  const [year, month, day] = normalized.split('-').map(Number);
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC'
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function todayISO() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function setTheme(theme) {
  const selected = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = selected;
  try { localStorage.setItem(THEME_KEY, selected); } catch { /* Keep the current session theme. */ }
  const iconClass = selected === 'dark' ? 'fa-regular fa-sun' : 'fa-regular fa-moon';
  ['#theme-toggle .action-icon i', '#theme-toggle-top i'].forEach(selector => {
    const icon = $(selector);
    if (icon) icon.className = iconClass;
  });
  const label = $('.theme-label');
  if (label) label.textContent = selected === 'dark' ? 'Light mode' : 'Dark mode';
  const select = $('#settings-theme');
  if (select) select.value = selected;
}

function initTheme() {
  let saved = 'light';
  try { saved = localStorage.getItem(THEME_KEY) || 'light'; } catch { /* Use light mode by default. */ }
  setTheme(saved);
  ['#theme-toggle', '#theme-toggle-top'].forEach(selector => {
    const button = $(selector);
    if (button) button.addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
  });
  const dialog = $('#settings-dialog');
  const settings = $('#open-settings');
  const close = $('#close-settings');
  const selector = $('#settings-theme');
  if (settings && dialog) settings.addEventListener('click', () => dialog.showModal());
  if (close && dialog) close.addEventListener('click', () => dialog.close());
  if (selector) selector.addEventListener('change', () => setTheme(selector.value));
  if (dialog) dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
}

function initSidebar() {
  const shell = $('#app-shell');
  const collapse = $('#sidebar-collapse');
  const expand = $('#sidebar-expand');
  const mobile = $('#mobile-menu');
  const scrim = $('#sidebar-scrim');
  let collapsed = false;
  try { collapsed = localStorage.getItem(COLLAPSED_KEY) === 'true'; } catch { /* Use expanded mode. */ }
  if (shell && collapsed) shell.classList.add('sidebar-collapsed');
  if (collapse && shell) collapse.addEventListener('click', () => {
    shell.classList.add('sidebar-collapsed');
    try { localStorage.setItem(COLLAPSED_KEY, 'true'); } catch { /* Session-only UI state. */ }
  });
  if (expand && shell) expand.addEventListener('click', () => {
    shell.classList.remove('sidebar-collapsed');
    try { localStorage.setItem(COLLAPSED_KEY, 'false'); } catch { /* Session-only UI state. */ }
  });
  const closeMobile = () => shell && shell.classList.remove('sidebar-open');
  if (mobile && shell) mobile.addEventListener('click', () => shell.classList.toggle('sidebar-open'));
  if (scrim) scrim.addEventListener('click', closeMobile);
  $$('.sidebar-action[href], .topbar-plans').forEach(link => link.addEventListener('click', closeMobile));
  const logout = $('#profile-logout');
  if (logout) logout.addEventListener('click', async () => {
    try {
      await api('/api/auth/logout', {method: 'POST'});
      window.location.assign('/home');
    } catch (error) {
      notify(`Could not log out: ${error.message}`, true);
    }
  });
}

async function initChat() {
  const messagesNode = $('#chat-messages');
  if (!messagesNode) return;
  const welcome = $('#welcome-screen');
  const conversationView = $('#conversation-view');
  const input = $('#chat-input');
  const dateInput = $('#date-input');
  const replies = $('#quick-replies');
  const form = $('#chat-form');
  const status = $('#chat-status');
  let conversations = [];
  let isAuthenticated = false;
  let activeId = localStorage.getItem(ACTIVE_CHAT_KEY);
  let active = null;
  let busy = false;
  let persistTimer;

  function persist() {
    active.updatedAt = Date.now();
    const position = conversations.findIndex(item => item.id === active.id);
    if (position === -1) conversations.push(active);
    else conversations[position] = active;
    conversations.sort((a, b) => b.updatedAt - a.updatedAt);
    if (conversations.length > 40) conversations.length = 40;
    try {
      localStorage.setItem(ACTIVE_CHAT_KEY, active.id);
    } catch { notify('This browser could not remember the active chat.', true); }
    clearTimeout(persistTimer);
    const conversationToSave = JSON.parse(JSON.stringify(active));
    if (!isAuthenticated) {
      try { localStorage.setItem(GUEST_CONVERSATIONS_KEY, JSON.stringify(conversations)); }
      catch { notify('This browser could not save the guest conversation.', true); }
      return;
    }
    persistTimer = setTimeout(() => {
      api(`/api/conversations/${encodeURIComponent(conversationToSave.id)}`, {
        method: 'PUT',
        body: JSON.stringify(conversationToSave)
      }).catch(error => notify(`Chat history could not be saved: ${error.message}`, true));
    }, 250);
  }

  function newConversation() {
    if (busy) { notify('Wait for PlanBot to finish this response first.'); return; }
    if (active && !active.messages.length) {
      conversations = conversations.filter(item => item.id !== active.id);
      if (isAuthenticated) {
        api(`/api/conversations/${encodeURIComponent(active.id)}`, {method: 'DELETE'})
          .catch(error => {
            if (!error.message.includes('not found')) notify(`Empty chat could not be removed: ${error.message}`, true);
          });
      }
    }
    active = {id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`, title: 'New chat', updatedAt: Date.now(), messages: [], answers: {}, step: 0, savedPlan: null};
    persist();
    renderConversation();
    showReplies([]);
    configureInput(null);
    input.value = '';
  }

  function renderRecent() {
    const list = $('#recent-list');
    if (!list) return;
    const search = ($('#chat-search')?.value || '').trim().toLowerCase();
    const matching = conversations.filter(chat => {
      const body = `${chat.title} ${(chat.messages || []).map(item => item.text || item.plan?.title || '').join(' ')}`.toLowerCase();
      return (chat.messages || []).length && body.includes(search);
    }).sort((a, b) => b.updatedAt - a.updatedAt);
    list.replaceChildren();
    $('#recent-count').textContent = matching.length ? matching.length : '';
    if (!matching.length) {
      const empty = document.createElement('p');
      empty.className = 'recent-empty';
      empty.textContent = search ? 'No matching chats' : 'Your conversations will appear here';
      list.append(empty);
      return;
    }
    matching.forEach(chat => {
      const row = document.createElement('div');
      row.className = 'recent-chat-row';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `recent-chat${chat.id === active.id ? ' active' : ''}`;
      const icon = document.createElement('i');
      icon.className = 'fa-regular fa-message';
      const label = document.createElement('span');
      label.textContent = chat.title || 'Event plan';
      button.append(icon, label);
      button.title = chat.title || 'Event plan';
      button.addEventListener('click', () => selectConversation(chat.id));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'recent-chat-delete';
      remove.setAttribute('aria-label', `Delete ${chat.title || 'event plan'} conversation`);
      remove.title = 'Delete conversation';
      remove.innerHTML = '<i class="fa-regular fa-trash-can" aria-hidden="true"></i>';
      remove.addEventListener('click', () => deleteConversation(chat.id));
      row.append(button, remove);
      list.append(row);
    });
  }

  async function deleteConversation(id) {
    if (busy) {
      notify('Wait for PlanBot to finish this response first.');
      return;
    }
    const conversation = conversations.find(chat => chat.id === id);
    if (!conversation || !window.confirm(`Delete "${conversation.title || 'Event plan'}" conversation?`)) return;
    if (isAuthenticated) {
      try {
        await api(`/api/conversations/${encodeURIComponent(id)}`, {method: 'DELETE'});
      } catch (error) {
        notify(`Conversation could not be deleted: ${error.message}`, true);
        return;
      }
    }
    conversations = conversations.filter(chat => chat.id !== id);
    if (active && active.id === id) {
      notify('Conversation deleted.');
      newConversation();
      return;
    }
    if (!isAuthenticated) {
      try { localStorage.setItem(GUEST_CONVERSATIONS_KEY, JSON.stringify(conversations)); }
      catch (error) {
        renderRecent();
        notify(`Conversation was deleted, but browser storage could not be updated: ${error.message}`, true);
        return;
      }
    }
    renderRecent();
    notify('Conversation deleted.');
  }

  function renderPlanCard(plan) {
    const card = document.createElement('div');
    card.className = 'generated-plan-card';
    const heading = document.createElement('div');
    heading.className = 'generated-plan-heading';
    const title = document.createElement('b');
    title.textContent = plan.title;
    const saved = document.createElement('span');
    saved.className = 'saved-label';
    saved.innerHTML = plan.guestPreview
      ? '<i class="fa-regular fa-eye"></i> Guest preview · not saved'
      : '<i class="fa-solid fa-circle-check"></i> Saved to My Plans';
    heading.append(title, saved);
    const subtitle = document.createElement('p');
    subtitle.textContent = `${formatDate(plan.event_date)}  |  ${plan.location}  |  ${Number(plan.guests).toLocaleString('en-IN')} guests`;
    const summary = document.createElement('p');
    summary.className = 'plan-summary';
    summary.textContent = `Event overview: ${plan.overview || `${plan.event_type} for ${Number(plan.guests).toLocaleString('en-IN')} guests in ${plan.location}. ${plan.theme} theme with ${plan.food} catering.`}`;
    const budgetHeading = document.createElement('div');
    budgetHeading.className = 'plan-budget-heading';
    const budgetLabel = document.createElement('span');
    budgetLabel.textContent = 'Estimated expenses';
    const total = document.createElement('b');
    total.textContent = formatMoney(plan.budget);
    budgetHeading.append(budgetLabel, total);
    const breakdown = document.createElement('div');
    breakdown.className = 'plan-budget-grid';
    Object.entries(plan.allocation || {}).forEach(([name, amount]) => {
      const line = document.createElement('div');
      line.className = 'plan-budget-line';
      const label = document.createElement('span');
      label.textContent = name;
      const value = document.createElement('b');
      value.textContent = formatMoney(amount);
      line.append(label, value);
      const track = document.createElement('span');
      track.className = 'chat-budget-track';
      const fill = document.createElement('i');
      fill.style.width = `${Math.min(100, Number(amount) / Number(plan.budget) * 100)}%`;
      track.append(fill);
      line.append(track);
      breakdown.append(line);
    });
    const allocationTotal = Object.values(plan.allocation || {}).reduce((sum, value) => sum + Number(value), 0);
    const budgetBalance = document.createElement('div');
    budgetBalance.className = 'budget-balance-row';
    const allocated = document.createElement('span');
    allocated.textContent = `Allocated ${formatMoney(plan.allocated_total ?? allocationTotal)}`;
    const remaining = document.createElement('b');
    remaining.textContent = `Remaining ${formatMoney(plan.remaining_budget ?? Math.max(0, Number(plan.budget) - allocationTotal))}`;
    budgetBalance.append(allocated, remaining);
    const sections = [
      ['Planning guidance', 'suggestions'],
      ['Venue suggestions', 'venue_suggestions'],
      ['Food ideas', 'food_suggestions'],
      ['Decoration ideas', 'decoration_suggestions'],
      ['Photography suggestions', 'photography_suggestions'],
      ['Entertainment ideas', 'entertainment_suggestions'],
      ['Event schedule', 'schedule'],
      ['Preparation checklist', 'checklist']
    ];
    const sectionNodes = sections.map(([headingText, key]) => {
      const section = document.createElement('section');
      section.className = 'plan-result-section';
      const heading = document.createElement('h4');
      heading.textContent = headingText;
      const list = document.createElement('ul');
      (plan[key] || []).forEach(entry => {
        const item = document.createElement('li');
        if (key === 'schedule' && typeof entry === 'object') {
          const strong = document.createElement('b');
          strong.textContent = `${entry.time} · ${entry.title}`;
          const detail = document.createElement('span');
          detail.textContent = entry.detail;
          item.append(strong, detail);
        } else item.textContent = entry;
        list.append(item);
      });
      section.append(heading, list);
      return section;
    });
    const action = document.createElement('a');
    action.className = 'plan-card-action';
    action.href = isAuthenticated ? '/dashboard' : '/register';
    action.innerHTML = isAuthenticated
      ? 'Open full plan <i class="fa-solid fa-arrow-up-right-from-square"></i>'
      : 'Create an account to save plans <i class="fa-solid fa-arrow-right"></i>';
    card.append(heading, subtitle, summary, budgetHeading, breakdown, budgetBalance, ...sectionNodes, action);
    return card;
  }

  function updatePlannerBrief() {
    const brief = $('#brief-title');
    if (!brief) return;
    const answers = active.answers || {};
    const complete = ['event_type', 'event_date', 'guests', 'budget', 'location', 'theme', 'food']
      .filter(key => answers[key] !== undefined && answers[key] !== '').length;
    brief.textContent = answers.event_type ? `${answers.theme || 'A lovely'} ${answers.event_type.toLowerCase()} is taking shape.` : 'A lovely day starts with an idea.';
    $('#brief-event').textContent = answers.event_type || 'Not decided yet';
    $('#brief-date').textContent = answers.event_date ? formatDate(answers.event_date) : 'Add your date';
    $('#brief-guests').textContent = answers.guests ? `${Number(answers.guests).toLocaleString('en-IN')} guests` : 'Add a guest count';
    $('#brief-budget').textContent = answers.budget ? formatMoney(answers.budget) : 'Set your budget';
    $('#brief-location').textContent = answers.location || 'Choose a location';
    $('#brief-style').textContent = answers.theme || answers.food ? [answers.theme, answers.food].filter(Boolean).join(' · ') : 'Add your preferences';
    $('#brief-progress-value').textContent = `${Math.round(complete / 7 * 100)}%`;
    $('#brief-progress-fill').style.width = `${complete / 7 * 100}%`;
  }

  function renderConversation() {
    const isEmpty = !active.messages.length;
    welcome.hidden = !isEmpty;
    conversationView.hidden = isEmpty;
    $('#conversation-title').textContent = active.title || 'New chat';
    messagesNode.replaceChildren();
    active.messages.forEach(message => {
      const row = document.createElement('article');
      row.className = `chat-message ${message.role === 'user' ? 'user-message' : 'assistant-message'}`;
      if (message.role === 'assistant') {
        const avatar = document.createElement('span');
        avatar.className = 'message-avatar';
        avatar.innerHTML = '<i class="fa-solid fa-sparkles"></i>';
        row.append(avatar);
      }
      const content = document.createElement('div');
      content.className = 'message-content';
      if (message.type === 'plan' && message.plan) content.append(renderPlanCard(message.plan));
      else {
        const text = document.createElement('p');
        text.textContent = message.text;
        content.append(text);
      }
      const time = document.createElement('time');
      time.textContent = new Date(message.time).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});
      content.append(time);
      row.append(content);
      messagesNode.append(row);
    });
    renderRecent();
    updatePlannerBrief();
    conversationView.scrollTop = conversationView.scrollHeight;
  }

  function addMessage(role, text, type = 'text', plan = null) {
    active.messages.push({role, text, type, plan, time: Date.now()});
    persist();
    renderConversation();
  }

  function showReplies(choices, eventChoices = false) {
    replies.replaceChildren();
    choices.forEach(choice => {
      const button = document.createElement('button');
      button.type = 'button';
      if (eventChoices) {
        button.className = 'event-choice';
        const icons = {'Birthday Party': 'fa-cake-candles', 'Wedding': 'fa-ring', 'College Event': 'fa-graduation-cap', 'Corporate Event': 'fa-briefcase', 'Engagement': 'fa-gem', 'Anniversary': 'fa-heart'};
        const icon = document.createElement('i');
        icon.className = `fa-solid ${icons[choice] || 'fa-calendar'}`;
        button.append(icon, document.createTextNode(choice));
      } else button.textContent = choice;
      button.addEventListener('click', () => handleMessage(choice));
      replies.append(button);
    });
  }

  function configureInput(question) {
    const isDate = question?.type === 'date';
    // Keep free-text chat available during every guided planning question.
    input.hidden = false;
    dateInput.hidden = !isDate;
    if (isDate) {
      dateInput.min = todayISO();
      dateInput.value = '';
      input.placeholder = 'Type a message or choose a date...';
      input.focus();
    } else if (question) {
      input.placeholder = question.type === 'number' ? 'Enter a number...' : 'Message PlanBot...';
      input.inputMode = question.type === 'number' ? 'decimal' : 'text';
      input.focus();
    } else {
      input.placeholder = 'Message PlanBot...';
      input.inputMode = 'text';
    }
  }

  function currentQuestion() {
    return [
      {key: 'event_type', label: 'What are we celebrating?', choices: EVENT_TYPES},
      {key: 'event_date', label: 'When is the big day?', type: 'date'},
      {key: 'guests', label: 'Roughly how many guests are you expecting?', type: 'number', choices: ['Under 25', '25-50', '50-100', '100+']},
      {key: 'budget', label: 'What total budget should I plan around? Enter an amount in INR.', type: 'number', choices: ['25000', '50000', '100000']},
      {key: 'location', label: 'Where would you like to celebrate? A city or area works.'},
      {key: 'theme', label: 'What theme or overall feeling do you have in mind?', choices: ['Garden party', 'Modern and minimal', 'Classic elegance', 'Bright and playful', 'Help me decide']},
      {key: 'food', label: 'What should the food feel like? You can mention a cuisine or dietary preference.', choices: ['Vegetarian', 'Non-vegetarian', 'Mixed menu', 'Buffet', 'Help me decide']}
    ][active.step];
  }

  function askNext() {
    if (active.step >= 7) {
      configureInput(null);
      if (active.savedPlan) showReplies(['Ask about budget', 'Venue ideas', 'Food planning', 'Start over']);
      else generatePlan();
      return;
    }
    const question = currentQuestion();
    if (question.key === 'event_type') {
      if (!active.messages.length || active.messages.at(-1).text !== question.label) addMessage('assistant', question.label);
      configureInput(null);
      showReplies(EVENT_TYPES, true);
      return;
    }
    if (!active.messages.length || active.messages.at(-1).text !== question.label) addMessage('assistant', question.label);
    configureInput(question);
    showReplies(question.choices || []);
  }

  function parseValue(raw, question) {
    if (question.key === 'guests') {
      const ranges = {'Under 25': 20, '25-50': 40, '50-100': 75, '100+': 120};
      if (ranges[raw]) return ranges[raw];
      const match = raw.match(/^\s*(\d[\d,]*)\s*(?:guests?)?\s*$/i);
      return match ? Number(match[1].replaceAll(',', '')) : 0;
    }
    if (question.key === 'budget') {
      return parseMoneyAmount(raw);
    }
    if (question.key === 'event_date') return normalizeDate(raw);
    return raw.trim();
  }

  function setConversationTitle(eventType) {
    active.title = `${eventType} plan`;
    $('#conversation-title').textContent = active.title;
  }

  function beginEvent(eventType, promptText) {
    active.answers = {event_type: eventType};
    active.step = 1;
    setConversationTitle(eventType);
    addMessage('user', promptText || `Plan a ${eventType}`);
    askNext();
    $('#app-shell').classList.remove('sidebar-open');
  }

  async function handleAnswer(raw) {
    const question = currentQuestion();
    const value = parseValue(raw, question);
    if (question.key === 'event_type' && !EVENT_TYPES.includes(value)) {
      notify('Choose one of the event types to get started.', true);
      return;
    }
    if (question.key === 'event_date' && (!value || value < todayISO())) {
      notify('Choose today or a future date.', true);
      return;
    }
    if (question.key === 'guests' && (!Number.isInteger(value) || value < 1 || value > 10000)) {
      notify('Enter a whole guest count from 1 to 10,000.', true);
      return;
    }
    if (question.key === 'budget' && (!Number.isFinite(value) || value < 1 || value > 100000000)) {
      notify('Enter a budget from ₹1 to ₹100,000,000.', true);
      return;
    }
    if (['location', 'theme', 'food'].includes(question.key) && value.length < 2) {
      notify('Please provide at least two characters for this detail.', true);
      return;
    }
    if (busy) return;
    addMessage('user', raw);
    active.answers[question.key] = value;
    if (question.key === 'event_type') setConversationTitle(value);
    active.step += 1;
    persist();
    busy = true;
    input.disabled = true;
    dateInput.disabled = true;
    status.textContent = 'PlanBot is thinking...';
    replies.replaceChildren();
    await new Promise(resolve => setTimeout(resolve, 220));
    status.textContent = '';
    busy = false;
    input.disabled = false;
    dateInput.disabled = false;
    persist();
    askNext();
  }

  function inferEventType(text) {
    const value = text.toLowerCase();
    if (value.includes('birthday')) return 'Birthday Party';
    if (value.includes('wedding')) return 'Wedding';
    if (value.includes('college')) return 'College Event';
    if (value.includes('corporate') || value.includes('company')) return 'Corporate Event';
    if (value.includes('engagement')) return 'Engagement';
    if (value.includes('anniversary')) return 'Anniversary';
    return null;
  }

  function captureDetails(text) {
    const lower = text.toLowerCase();
    const details = {};
    const eventType = inferEventType(text);
    if (eventType && !active.answers.event_type) details.event_type = eventType;
    const budget = lower.match(/(?:budget|spend|cost|\binr\b|\brs\.?|₹)\s*(?:is|of|around|about|:|=)?\s*₹?\s*([\d,]+(?:\.\d{1,2})?\s*(?:thousands?|k|lakhs?|lacs?|l|crores?|cr)?\s*(?:rupees?|inr)?)/i);
    if (budget) {
      const amount = parseMoneyAmount(budget[1]);
      if (Number.isFinite(amount) && amount >= 1 && amount <= 100000000) details.budget = amount;
    }
    const guests = lower.match(/(?:expect(?:ing)?|around|about|approximately)\D{0,24}(\d[\d,]*)\s*(?:guests?|people|attendees?)?|\b(\d[\d,]*)\s*(?:guests?|people|attendees?)\b/i);
    if (guests) {
      const count = Number((guests[1] || guests[2]).replaceAll(',', ''));
      if (Number.isInteger(count) && count >= 1 && count <= 10000) details.guests = count;
    }
    const dateMatch = text.match(/\b(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/-]\d{1,2}[/-]\d{4})\b/);
    const eventDate = dateMatch ? normalizeDate(dateMatch[1]) : '';
    if (eventDate && eventDate >= todayISO()) details.event_date = eventDate;
    return details;
  }

  function isChatQuestion(text) {
    return /\?|\b(hi|hello|hey|thank|suggest|recommend|ideas?|how can|how do|what should|help me|can you|tell me|explain|reduce|save money|affordable|cheap|decorations?|themes?|food|menu|venue|budget|expenses?|schedule|checklist|entertainment|photograph)\b/i.test(text);
  }

  async function askFreeform(raw) {
    addMessage('user', raw);
    busy = true;
    input.disabled = true;
    dateInput.disabled = true;
    status.textContent = 'PlanBot is thinking...';
    replies.replaceChildren();
    try {
      const history = active.messages.slice(0, -1).slice(-12).map(item => ({role: item.role, text: item.text || ''}));
      const result = await api('/api/chat', {method: 'POST', body: JSON.stringify({message: raw, event: active.answers, history})});
      addMessage('assistant', result.reply);
    } catch (error) {
      addMessage('assistant', `I couldn’t reach a reply just now. ${error.message}`);
    } finally {
      busy = false;
      input.disabled = false;
      dateInput.disabled = false;
      status.textContent = '';
      if (active.step < 7) {
        const question = currentQuestion();
        configureInput(question);
        showReplies(question.choices || []);
      } else showReplies(['Ask about budget', 'Venue ideas', 'Food planning', 'Start over']);
      input.focus();
    }
  }

  function acceptCapturedDetails(raw, details, alreadyDisplayed = false) {
    if (!alreadyDisplayed) addMessage('user', raw);
    Object.assign(active.answers, details);
    if (details.event_type) setConversationTitle(details.event_type);
    if (active.step === 0 && active.answers.event_type) active.step = 1;
    else {
      const current = currentQuestion();
      if (current && details[current.key] !== undefined) active.step += 1;
    }
    persist();
    const captured = [];
    if (details.event_type) captured.push(details.event_type);
    if (details.budget) captured.push(`${formatMoney(details.budget)} budget`);
    if (details.guests) captured.push(`${details.guests} guests`);
    if (details.event_date) captured.push(formatDate(details.event_date));
    addMessage('assistant', `Got it — I’ve noted ${captured.join(', ')}.`);
    askNext();
  }

  async function generatePlan() {
    if (busy || active.savedPlan) return;
    busy = true;
    input.disabled = true;
    dateInput.disabled = true;
    status.textContent = 'Putting your event plan together...';
    replies.replaceChildren();
    try {
      const plan = isAuthenticated
        ? await api('/api/plans', {method: 'POST', body: JSON.stringify(active.answers), keepalive: true})
        : await api('/api/plan-preview', {method: 'POST', body: JSON.stringify(active.answers), keepalive: true});
      if (!isAuthenticated) plan.guestPreview = true;
      active.savedPlan = plan;
      active.step = 7;
      addMessage('assistant', isAuthenticated
        ? (plan.already_saved
          ? 'I found this event already in My Plans and brought it back for you.'
          : 'Your event plan is ready and has been saved automatically. Here is the budget overview.')
        : 'Your event plan is ready to explore. This guest preview and conversation are kept in this browser. Sign in before planning to save plans to My Plans.');
      addMessage('assistant', '', 'plan', plan);
      notify(isAuthenticated
        ? (plan.already_saved ? 'Your existing plan is ready.' : 'Your plan was saved to My Plans.')
        : 'Plan preview ready. Create an account to save it.');
    } catch (error) {
      status.textContent = '';
      addMessage('assistant', `I could not save the plan yet: ${error.message}`);
      showReplies(['Retry saving plan']);
    } finally {
      busy = false;
      input.disabled = false;
      dateInput.disabled = false;
      status.textContent = '';
      configureInput(null);
      if (active.savedPlan) showReplies(['Ask about budget', 'Venue ideas', 'Food planning', 'Start over']);
    }
  }

  async function askFollowup(raw) {
    if (raw.toLowerCase() === 'start over') return newConversation();
    addMessage('user', raw);
    busy = true;
    input.disabled = true;
    status.textContent = 'PlanBot is thinking...';
    replies.replaceChildren();
    try {
      const history = active.messages.slice(0, -1).slice(-12).map(item => ({role: item.role, text: item.text || ''}));
      const result = await api('/api/chat', {method: 'POST', body: JSON.stringify({message: raw, event: active.answers, history})});
      addMessage('assistant', result.reply);
    } catch (error) { addMessage('assistant', error.message); }
    finally {
      busy = false;
      input.disabled = false;
      status.textContent = '';
      showReplies(['Ask about budget', 'Venue ideas', 'Food planning', 'Start over']);
      input.focus();
    }
  }

  async function handleMessage(raw) {
    if (busy || !raw.trim()) return;
    if (active.step < 7) {
      if (active.step === 0) {
        const eventType = EVENT_TYPES.find(item => item.toLowerCase() === raw.toLowerCase()) || inferEventType(raw);
        if (eventType) {
          if (raw === eventType) return handleAnswer(eventType);
          const details = captureDetails(raw);
          delete details.event_type;
          if (Object.keys(details).length) {
            active.answers = {event_type: eventType};
            active.step = 1;
            setConversationTitle(eventType);
            addMessage('user', raw);
            acceptCapturedDetails(raw, details, true);
            $('#app-shell').classList.remove('sidebar-open');
          } else beginEvent(eventType, raw);
          return;
        }
        return askFreeform(raw);
      }
      const details = captureDetails(raw);
      if (Object.keys(details).length) return acceptCapturedDetails(raw, details);
      if (isChatQuestion(raw)) return askFreeform(raw);
      return handleAnswer(raw);
    }
    if (!active.savedPlan && raw.toLowerCase() === 'retry saving plan') return generatePlan();
    return askFollowup(raw);
  }

  function selectConversation(id) {
    if (busy) { notify('Wait for PlanBot to finish this response first.'); return; }
    const match = conversations.find(item => item.id === id);
    if (!match) return;
    active = match;
    localStorage.setItem(ACTIVE_CHAT_KEY, active.id);
    renderConversation();
    resumeConversation();
    $('#app-shell').classList.remove('sidebar-open');
  }

  function resumeConversation() {
    if (!active.messages.length) {
      showReplies([]);
      configureInput(null);
      return;
    }
    if (active.step >= 7) {
      if (active.savedPlan) {
        configureInput(null);
        showReplies(['Ask about budget', 'Venue ideas', 'Food planning', 'Start over']);
      } else generatePlan();
      return;
    }
    const question = currentQuestion();
    configureInput(question);
    if (active.step === 0) showReplies(EVENT_TYPES, true);
    else showReplies(question.choices || []);
  }

  function choosePrompt(eventType) {
    if (busy) return;
    beginEvent(eventType, `Plan a ${eventType}`);
  }

  $('#new-chat').addEventListener('click', newConversation);
  $('#other-events').addEventListener('click', () => {
    if (!active.messages.length) addMessage('assistant', 'Of course. What kind of event are you planning?');
    showReplies(EVENT_TYPES, true);
  });
  $$('.suggestion-card, .planner-prompt').forEach(button => button.addEventListener('click', () => choosePrompt(button.dataset.event)));
  $('#chat-search').addEventListener('input', event => {
    $('#search-clear').hidden = !event.target.value;
    renderRecent();
  });
  $('#search-clear').addEventListener('click', () => {
    $('#chat-search').value = '';
    $('#search-clear').hidden = true;
    renderRecent();
    $('#chat-search').focus();
  });
  $('#composer-add').addEventListener('click', () => {
    if (active.step === 0) showReplies(EVENT_TYPES, true);
    else if (active.step < 7) showReplies(currentQuestion()?.choices || []);
    else showReplies(['Ask about budget', 'Venue ideas', 'Food planning', 'Start over']);
    if (!active.messages.length) $('#other-events').focus();
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    const value = input.value.trim() || (!dateInput.hidden ? dateInput.value : '');
    input.value = '';
    if (!dateInput.hidden) dateInput.value = '';
    handleMessage(value || '');
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      newConversation();
    }
  });

  try {
    const auth = await api('/api/auth/me');
    isAuthenticated = Boolean(auth.user);
    const plannerName = $('#planner-account-name');
    const plannerStatus = $('#planner-account-status');
    const plannerLogin = $('#planner-login-link');
    const topLogin = $('#planner-top-login-link');
    const plannerLogout = $('#profile-logout');
    if (plannerName) plannerName.textContent = auth.user ? auth.user.email : 'Guest planner';
    if (plannerStatus) plannerStatus.textContent = auth.user ? 'Your private planning workspace' : 'Sign in to save your plans';
    if (plannerLogin) plannerLogin.hidden = isAuthenticated;
    if (topLogin) topLogin.hidden = isAuthenticated;
    if (plannerLogout) plannerLogout.hidden = !isAuthenticated;
    if (isAuthenticated) conversations = await api('/api/conversations');
    else {
      const savedGuestConversations = JSON.parse(localStorage.getItem(GUEST_CONVERSATIONS_KEY) || '[]');
      conversations = Array.isArray(savedGuestConversations) ? savedGuestConversations : [];
    }
    active = conversations.find(item => item.id === activeId) || null;
  } catch (error) {
    notify(`Chat history could not be loaded: ${error.message}`, true);
  }
  const requestedEvent = new URLSearchParams(window.location.search).get('event');
  if (requestedEvent && EVENT_TYPES.includes(requestedEvent)) {
    newConversation();
    beginEvent(requestedEvent, `Plan a ${requestedEvent}`);
    window.history.replaceState({}, '', window.location.pathname);
  } else if (!active) newConversation();
  else {
    renderConversation();
    resumeConversation();
  }
}

async function initDashboard() {
  const grid = $('#plans-grid');
  if (!grid) return;
  const dialog = $('#plan-dialog');
  const search = $('#plan-search');
  const filter = $('#plan-filter');
  const sort = $('#plan-sort');
  const toolbar = $('.plans-toolbar');
  let plans = [];

  function render() {
    grid.replaceChildren();
    $('#plan-count').textContent = plans.length;
    $('#total-budget').textContent = formatMoney(plans.reduce((sum, plan) => sum + Number(plan.budget), 0));
    $('#total-guests').textContent = plans.reduce((sum, plan) => sum + Number(plan.guests), 0).toLocaleString('en-IN');
    const today = new Date().toISOString().slice(0, 10);
    $('#upcoming-count').textContent = plans.filter(plan => plan.event_date >= today).length;
    $('#empty-state').hidden = plans.length !== 0;
    toolbar.hidden = plans.length === 0;
    const term = search.value.trim().toLowerCase();
    let shown = plans.filter(plan => [plan.title, plan.event_type, plan.theme, plan.location].some(value => String(value).toLowerCase().includes(term)) && (filter.value === 'all' || plan.event_type === filter.value));
    shown.sort((a, b) => {
      if (sort.value === 'budget-desc') return Number(b.budget) - Number(a.budget);
      if (sort.value === 'budget-asc') return Number(a.budget) - Number(b.budget);
      return sort.value === 'date-desc' ? b.event_date.localeCompare(a.event_date) : a.event_date.localeCompare(b.event_date);
    });
    $('#no-results').hidden = plans.length === 0 || shown.length > 0;
    shown.forEach(plan => {
      const card = document.createElement('article');
      card.className = 'plan-card';
      const top = document.createElement('div');
      top.className = 'plan-card-top';
      const type = document.createElement('span');
      type.className = 'plan-type';
      type.textContent = plan.event_type;
      const date = document.createElement('span');
      date.className = 'plan-date';
      date.textContent = formatDate(plan.event_date);
      top.append(type, date);
      const title = document.createElement('h2');
      title.textContent = plan.title;
      const location = document.createElement('div');
      location.className = 'plan-location';
      location.textContent = `${plan.location} / ${plan.theme}`;
      const metrics = document.createElement('div');
      metrics.className = 'plan-metrics';
      [['TOTAL BUDGET', formatMoney(plan.budget)], ['GUESTS', Number(plan.guests).toLocaleString('en-IN')]].forEach(([label, value]) => {
        const item = document.createElement('div');
        const small = document.createElement('small');
        small.textContent = label;
        const strong = document.createElement('b');
        strong.textContent = value;
        item.append(small, strong);
        metrics.append(item);
      });
      const actions = document.createElement('div');
      actions.className = 'plan-card-actions';
      const view = document.createElement('button');
      view.textContent = 'View Details';
      view.addEventListener('click', () => showPlan(plan));
      const edit = document.createElement('button');
      edit.textContent = 'Edit Plan';
      edit.addEventListener('click', () => editPlan(plan));
      const remove = document.createElement('button');
      remove.className = 'delete-plan';
      remove.title = 'Delete Plan';
      remove.setAttribute('aria-label', 'Delete Plan');
      remove.innerHTML = '<i class="fa-regular fa-trash-can"></i>';
      remove.addEventListener('click', () => removePlan(plan));
      actions.append(view, edit, remove);
      card.append(top, title, location, metrics, actions);
      grid.append(card);
    });
  }

  function showPlan(plan) {
    const root = $('#dialog-content');
    root.replaceChildren();
    const title = document.createElement('h2');
    title.className = 'dialog-title';
    title.textContent = plan.title;
    const subtitle = document.createElement('p');
    subtitle.className = 'dialog-subtitle';
    subtitle.textContent = `${formatDate(plan.event_date)} / ${plan.location} / ${plan.guests} guests / ${plan.theme}`;
    const overview = document.createElement('p');
    overview.className = 'dialog-subtitle';
    overview.textContent = `Event overview: ${plan.overview || `${plan.event_type} for ${plan.guests} guests with ${plan.food} food preferences.`}`;
    root.append(title, subtitle, overview);
    const budgetTitle = document.createElement('h3');
    budgetTitle.className = 'dialog-section-title';
    budgetTitle.textContent = `Estimated expenses / ${formatMoney(plan.budget)}`;
    root.append(budgetTitle);
    const budgetHelp = document.createElement('p');
    budgetHelp.className = 'budget-editor-help';
    budgetHelp.textContent = 'Adjust category estimates below. Allocated expenses cannot exceed the event budget.';
    root.append(budgetHelp);
    const chart = document.createElement('div');
    chart.className = 'budget-chart';
    chart.setAttribute('role', 'img');
    chart.setAttribute('aria-label', 'Budget allocation by expense category');
    const budget = document.createElement('div');
    budget.className = 'dialog-budget';
    const chartSegments = [];
    const categoryInputs = [];
    const colors = ['#7858b8', '#bd8065', '#d2a35f', '#7586b2', '#719579', '#648e9a', '#a67b9b'];
    Object.entries(plan.allocation || {}).forEach(([name, amount]) => {
      const color = colors[categoryInputs.length % colors.length];
      const item = document.createElement('label');
      item.className = 'budget-item';
      const row = document.createElement('div');
      row.className = 'budget-item-heading';
      const swatch = document.createElement('i');
      swatch.className = 'budget-swatch';
      swatch.style.backgroundColor = color;
      const small = document.createElement('small');
      small.textContent = name;
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.max = String(plan.budget);
      input.step = '0.01';
      input.value = Number(amount).toFixed(2);
      input.dataset.category = name;
      input.setAttribute('aria-label', `${name} estimated expense`);
      row.append(swatch, small, input);
      const track = document.createElement('span');
      track.className = 'budget-track';
      const fill = document.createElement('i');
      fill.style.backgroundColor = color;
      track.append(fill);
      item.append(row, track);
      budget.append(item);
      const segment = document.createElement('span');
      segment.style.backgroundColor = color;
      segment.setAttribute('aria-hidden', 'true');
      chart.append(segment);
      chartSegments.push(segment);
      categoryInputs.push(input);
    });
    root.append(chart, budget);
    const allocationTotal = Object.values(plan.allocation || {}).reduce((sum, value) => sum + Number(value), 0);
    const remainingBudget = Number(plan.remaining_budget ?? Math.max(0, Number(plan.budget) - allocationTotal));
    const balance = document.createElement('p');
    balance.className = 'budget-balance-row';
    const allocated = document.createElement('span');
    allocated.textContent = `Allocated ${formatMoney(plan.allocated_total ?? allocationTotal)}`;
    const remaining = document.createElement('b');
    remaining.textContent = `Remaining ${formatMoney(remainingBudget)}`;
    balance.append(allocated, remaining);
    const budgetError = document.createElement('p');
    budgetError.className = 'budget-error';
    budgetError.setAttribute('role', 'alert');
    budgetError.hidden = true;
    const budgetActions = document.createElement('div');
    budgetActions.className = 'dialog-actions budget-editor-actions';
    const saveBudget = document.createElement('button');
    saveBudget.type = 'button';
    saveBudget.textContent = 'Save expenses';
    budgetActions.append(saveBudget);
    root.append(balance, budgetError, budgetActions);

    const totalBudgetCents = Math.round(Number(plan.budget) * 100);
    const updateBudgetPreview = () => {
      let allocatedCents = 0;
      let valid = true;
      categoryInputs.forEach((input, index) => {
        const amount = Number(input.value);
        const inputValid = input.value.trim() !== '' && input.validity.valid && Number.isFinite(amount) && amount >= 0;
        input.toggleAttribute('aria-invalid', !inputValid);
        valid = valid && inputValid;
        const amountCents = inputValid ? Math.round(amount * 100) : 0;
        allocatedCents += amountCents;
        const percentage = totalBudgetCents ? Math.max(0, amountCents / totalBudgetCents * 100) : 0;
        chartSegments[index].style.width = `${Math.min(100, percentage)}%`;
        budget.querySelectorAll('.budget-track i')[index].style.width = `${Math.min(100, percentage)}%`;
      });
      const overBudget = allocatedCents > totalBudgetCents;
      allocated.textContent = `Allocated ${formatMoney(allocatedCents / 100)}`;
      remaining.textContent = overBudget
        ? `Over by ${formatMoney((allocatedCents - totalBudgetCents) / 100)}`
        : `Remaining ${formatMoney((totalBudgetCents - allocatedCents) / 100)}`;
      budgetError.textContent = !valid
        ? 'Enter a non-negative amount with no more than two decimal places for every category.'
        : overBudget
          ? 'Allocated expenses exceed the event budget. Adjust them before saving.'
          : '';
      budgetError.hidden = valid && !overBudget;
      saveBudget.disabled = !valid || overBudget;
    };
    categoryInputs.forEach(input => input.addEventListener('input', updateBudgetPreview));
    saveBudget.addEventListener('click', async () => {
      saveBudget.disabled = true;
      saveBudget.textContent = 'Saving…';
      try {
        const allocation = Object.fromEntries(categoryInputs.map(input => [input.dataset.category, Number(input.value)]));
        const updatedPlan = await api(`/api/plans/${plan.id}/budget`, {
          method: 'PUT',
          body: JSON.stringify({allocation})
        });
        Object.assign(plan, updatedPlan);
        notify('Expense estimates updated.');
        dialog.close();
        await load();
      } catch (error) {
        budgetError.textContent = error.message;
        budgetError.hidden = false;
        saveBudget.disabled = false;
      } finally {
        saveBudget.textContent = 'Save expenses';
      }
    });
    updateBudgetPreview();

    let scheduleItems = (plan.schedule || []).map(item => ({...item}));
    const scheduleTitle = document.createElement('h3');
    scheduleTitle.className = 'dialog-section-title';
    scheduleTitle.textContent = 'Event schedule';
    const scheduleRows = document.createElement('div');
    scheduleRows.className = 'schedule-editor';
    const scheduleError = document.createElement('p');
    scheduleError.className = 'planning-error';
    scheduleError.setAttribute('role', 'alert');
    scheduleError.hidden = true;
    const scheduleActions = document.createElement('div');
    scheduleActions.className = 'dialog-actions';
    const saveSchedule = document.createElement('button');
    saveSchedule.type = 'button';
    saveSchedule.textContent = 'Save schedule';
    scheduleActions.append(saveSchedule);
    const renderSchedule = () => {
      scheduleRows.replaceChildren();
      scheduleItems.forEach((activity, index) => {
        const row = document.createElement('article');
        row.className = 'schedule-editor-row';
        const timeLabel = document.createElement('label');
        timeLabel.textContent = 'Timing';
        const timeInput = document.createElement('input');
        timeInput.type = 'text';
        timeInput.maxLength = 40;
        timeInput.value = activity.time;
        timeInput.setAttribute('aria-label', `Activity ${index + 1} timing`);
        timeInput.addEventListener('input', () => { scheduleItems[index].time = timeInput.value; });
        timeLabel.append(timeInput);
        const titleLabel = document.createElement('label');
        titleLabel.textContent = 'Activity';
        const titleInput = document.createElement('input');
        titleInput.type = 'text';
        titleInput.maxLength = 120;
        titleInput.value = activity.title;
        titleInput.setAttribute('aria-label', `Activity ${index + 1} name`);
        titleInput.addEventListener('input', () => { scheduleItems[index].title = titleInput.value; });
        titleLabel.append(titleInput);
        const detailLabel = document.createElement('label');
        detailLabel.textContent = 'Details';
        const detailInput = document.createElement('textarea');
        detailInput.maxLength = 400;
        detailInput.value = activity.detail;
        detailInput.setAttribute('aria-label', `Activity ${index + 1} details`);
        detailInput.addEventListener('input', () => { scheduleItems[index].detail = detailInput.value; });
        detailLabel.append(detailInput);
        row.append(timeLabel, titleLabel, detailLabel);
        scheduleRows.append(row);
      });
    };
    saveSchedule.addEventListener('click', async () => {
      saveSchedule.disabled = true;
      scheduleError.hidden = true;
      try {
        const updatedPlan = await api(`/api/plans/${plan.id}/schedule`, {
          method: 'PUT',
          body: JSON.stringify({schedule: scheduleItems})
        });
        plan.schedule = updatedPlan.schedule;
        notify('Event schedule updated.');
      } catch (error) {
        scheduleError.textContent = error.message;
        scheduleError.hidden = false;
      } finally {
        saveSchedule.disabled = false;
      }
    });
    renderSchedule();
    root.append(scheduleTitle, scheduleRows, scheduleError, scheduleActions);

    const sections = [
      ['Thoughtful next steps', 'suggestions', value => value],
      ['Venue suggestions', 'venue_suggestions', value => value],
      ['Food and catering', 'food_suggestions', value => value],
      ['Decoration ideas', 'decoration_suggestions', value => value],
      ['Photography suggestions', 'photography_suggestions', value => value],
      ['Entertainment ideas', 'entertainment_suggestions', value => value]
    ];
    sections.forEach(([headingText, key, format]) => {
      const heading = document.createElement('h3');
      heading.className = 'dialog-section-title';
      heading.textContent = headingText;
      root.append(heading);
      const list = document.createElement('ul');
      list.className = 'suggestion-list';
      (plan[key] || []).forEach(value => {
        const item = document.createElement('li');
        item.textContent = format(value);
        list.append(item);
      });
      root.append(list);
    });
    const checklistTitle = document.createElement('h3');
    checklistTitle.className = 'dialog-section-title';
    checklistTitle.textContent = 'Your planning checklist';
    root.append(checklistTitle);
    const checklistHelp = document.createElement('p');
    checklistHelp.className = 'checklist-help';
    checklistHelp.textContent = 'Progress and task changes save automatically to this event plan.';
    root.append(checklistHelp);
    const progress = document.createElement('div');
    progress.className = 'check-progress';
    const progressLabel = document.createElement('span');
    const track = document.createElement('span');
    track.className = 'check-progress-track';
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    const fill = document.createElement('i');
    track.append(fill);
    progress.append(progressLabel, track);
    root.append(progress);
    const checklist = document.createElement('ul');
    checklist.className = 'checklist';
    let checklistItems = (plan.checklist_items || (plan.checklist || []).map(task => ({task, completed: false}))
    ).map(item => ({task: item.task, completed: item.completed === true}));
    let checklistSaveChain = Promise.resolve();
    const updateProgress = () => {
      const done = checklistItems.filter(item => item.completed).length;
      const percentage = checklistItems.length ? Math.round(done / checklistItems.length * 100) : 0;
      progressLabel.textContent = `${percentage}% complete (${done}/${checklistItems.length})`;
      track.setAttribute('aria-valuenow', String(percentage));
      fill.style.width = `${percentage}%`;
    };
    const checklistStatus = document.createElement('p');
    checklistStatus.className = 'checklist-status';
    checklistStatus.setAttribute('role', 'status');
    checklistStatus.textContent = 'Saved';
    const persistChecklist = () => {
      const snapshot = checklistItems.map(item => ({...item}));
      checklistSaveChain = checklistSaveChain.catch(() => {}).then(async () => {
      checklistStatus.textContent = 'Saving...';
      const updatedPlan = await api(`/api/plans/${plan.id}/checklist`, {
        method: 'PUT',
        body: JSON.stringify({items: snapshot})
      });
      plan.checklist_items = updatedPlan.checklist_items;
      plan.checklist = updatedPlan.checklist;
      checklistStatus.textContent = 'Saved';
      }).catch(error => {
      checklistStatus.textContent = 'Save failed.';
      notify(error.message, true);
      });
    };
    const renderChecklist = () => {
      checklist.replaceChildren();
      checklistItems.forEach((task, index) => {
      const item = document.createElement('li');
      item.className = 'checklist-row';
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = task.completed;
      checkbox.addEventListener('change', () => {
        checklistItems[index].completed = checkbox.checked;
        updateProgress();
        persistChecklist();
      });
      const textNode = document.createElement('span');
      textNode.textContent = task.task;
      label.append(checkbox, textNode);
      const removeTask = document.createElement('button');
      removeTask.type = 'button';
      removeTask.className = 'checklist-remove';
      removeTask.textContent = 'Remove';
      removeTask.setAttribute('aria-label', `Remove task: ${task.task}`);
      removeTask.addEventListener('click', () => {
        checklistItems.splice(index, 1);
        renderChecklist();
        persistChecklist();
      });
      item.append(label, removeTask);
      checklist.append(item);
      });
      updateProgress();
    };
    const addTaskForm = document.createElement('form');
    addTaskForm.className = 'checklist-add-form';
    const addTaskInput = document.createElement('input');
    addTaskInput.type = 'text';
    addTaskInput.maxLength = 200;
    addTaskInput.placeholder = 'Add a preparation task';
    addTaskInput.setAttribute('aria-label', 'New checklist task');
    addTaskInput.required = true;
    const addTaskButton = document.createElement('button');
    addTaskButton.type = 'submit';
    addTaskButton.textContent = 'Add task';
    addTaskForm.append(addTaskInput, addTaskButton);
    addTaskForm.addEventListener('submit', event => {
      event.preventDefault();
      const task = addTaskInput.value.trim();
      if (!task) return;
      checklistItems.push({task, completed: false});
      addTaskInput.value = '';
      renderChecklist();
      persistChecklist();
    });
    renderChecklist();
    root.append(checklist, addTaskForm, checklistStatus);
    dialog.showModal();
  }

  function editPlan(plan) {
    const root = $('#dialog-content');
    root.replaceChildren();
    const title = document.createElement('h2');
    title.className = 'dialog-title';
    title.textContent = 'Edit your event';
    root.append(title);
    const form = document.createElement('form');
    form.className = 'edit-form';
    const fields = [
      ['event_type', 'Event type', 'select', EVENT_TYPES], ['event_date', 'Date', 'date'],
      ['location', 'Location', 'text'], ['guests', 'Guests', 'number'], ['budget', 'Budget in INR', 'number'],
      ['theme', 'Theme', 'text'], ['food', 'Food preference', 'text']
    ];
    fields.forEach(([key, label, type, options]) => {
      const wrapper = document.createElement('label');
      wrapper.textContent = label;
      const control = document.createElement(type === 'select' ? 'select' : 'input');
      if (type !== 'select') control.type = type;
      control.name = key;
      if (options) options.forEach(option => {
        const item = document.createElement('option');
        item.value = option;
        item.textContent = option;
        control.append(item);
      });
      control.value = plan[key];
      if (key === 'event_date') control.min = plan.event_date < todayISO() ? plan.event_date : todayISO();
      wrapper.append(control);
      form.append(wrapper);
    });
    const actions = document.createElement('div');
    actions.className = 'dialog-actions wide';
    const save = document.createElement('button');
    save.textContent = 'Save changes';
    save.type = 'submit';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'secondary';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => dialog.close());
    actions.append(save, cancel);
    form.append(actions);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      save.disabled = true;
      try {
        const updatedPlan = await api(`/api/plans/${plan.id}`, {method: 'PUT', body: JSON.stringify(Object.fromEntries(new FormData(form)))});
        notify('Your plan has been updated.');
        dialog.close();
        await load();
      } catch (error) { notify(error.message, true); save.disabled = false; }
    });
    root.append(form);
    dialog.showModal();
  }

  async function removePlan(plan) {
    if (!window.confirm(`Delete "${plan.title}"? This cannot be undone.`)) return;
    try {
      await api(`/api/plans/${plan.id}`, {method: 'DELETE'});
      notify('Plan deleted.');
      await load();
    } catch (error) { notify(error.message, true); }
  }

  async function load() {
    try { plans = await api('/api/plans'); render(); }
    catch (error) { notify(error.message, true); }
  }

  search.addEventListener('input', render);
  [filter, sort].forEach(control => control.addEventListener('change', render));
  $('.dialog-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  await load();
}

async function initLandingPreview() {
  if (!$('#landing-plan-preview')) return;
  try {
    const auth = await api('/api/auth/me');
    if (!auth.user) return;
    const plans = await api('/api/plans');
    const plan = plans[0];
    if (!plan) return;
    $('#preview-status').innerHTML = '<i class="fa-solid fa-circle"></i> SAVED PLAN';
    $('#preview-type').textContent = plan.event_type.toUpperCase();
    $('#preview-title').textContent = plan.title;
    $('#preview-date').textContent = `Event date · ${formatDate(plan.event_date)}`;
    $('#preview-guests').textContent = `${Number(plan.guests).toLocaleString('en-IN')} guests`;
    $('#preview-budget').textContent = `Planned budget · ${formatMoney(plan.budget)}`;
  } catch { /* The landing page stays useful when the plans API is temporarily unavailable. */ }
}

document.addEventListener('DOMContentLoaded', () => { initTheme(); initSidebar(); initChat(); initDashboard(); initLandingPreview(); });
