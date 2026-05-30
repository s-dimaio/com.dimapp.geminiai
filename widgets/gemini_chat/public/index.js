'use strict';

/* ─── Globals ─────────────────────────────────────────────────────────────── */
let _Homey;
let _isLoading = false;
const SCROLL_AMOUNT = 90; /* pixels per scroll-button press */

/* ─── Entry point ─────────────────────────────────────────────────────────── */
function onHomeyReady(Homey) {
  _Homey = Homey;

  // Localise placeholder and input
  const placeholder = Homey.__('widget.chat.input.placeholder') || 'Ask Gemini…';
  document.getElementById('command-input').placeholder = placeholder;
  document.getElementById('chat-placeholder').textContent =
    Homey.__('widget.chat.placeholder') || 'Ask Gemini to control your home.';

  // Wire up send button and Enter key
  const input = document.getElementById('command-input');
  const btn   = document.getElementById('send-btn');

  input.addEventListener('input', () => {
    btn.disabled = input.value.trim().length === 0 || _isLoading;
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !btn.disabled) _sendCommand();
  });

  btn.addEventListener('click', () => {
    if (!btn.disabled) _sendCommand();
  });

  // Helper for continuous scrolling on hold
  function _addContinuousScroll(btnId, direction) {
    const btn = document.getElementById(btnId);
    const log = document.getElementById('chat-log');
    let scrollInterval;

    const startScroll = (e) => {
      if (e.type === 'touchstart') e.preventDefault(); // Prevent default double-tap zoom or text selection on mobile
      if (scrollInterval) return;
      
      // Initial immediate scroll
      log.scrollBy({ top: direction * SCROLL_AMOUNT, behavior: 'smooth' });
      
      // Continuous scroll after a short delay to differentiate from a single tap
      scrollInterval = setInterval(() => {
        log.scrollBy({ top: direction * SCROLL_AMOUNT, behavior: 'smooth' });
      }, 150);
    };

    const stopScroll = () => {
      if (scrollInterval) {
        clearInterval(scrollInterval);
        scrollInterval = null;
      }
    };

    btn.addEventListener('mousedown', startScroll);
    btn.addEventListener('touchstart', startScroll, { passive: false });

    btn.addEventListener('mouseup', stopScroll);
    btn.addEventListener('mouseleave', stopScroll);
    btn.addEventListener('touchend', stopScroll);
    btn.addEventListener('touchcancel', stopScroll);
  }

  _addContinuousScroll('scroll-up-btn', -1);
  _addContinuousScroll('scroll-down-btn', 1);

  // Update scroll button visibility whenever the user scrolls
  document.getElementById('chat-log').addEventListener('scroll', _updateScrollButtons);

  // Restore previous conversation messages from the server on load
  _restoreHistory();

  // React to history being cleared (timeout or manual via settings)
  Homey.on('widget_history_cleared', _clearChat);

  // Signal that the widget is ready; keep height as defined in widget.compose.json
  Homey.ready();
}

/* ─── Send command ────────────────────────────────────────────────────────── */
function _sendCommand() {
  const input   = document.getElementById('command-input');
  const command = input.value.trim();
  if (!command || _isLoading) return;

  // Remove placeholder once the first message arrives
  const placeholder = document.getElementById('chat-placeholder');
  if (placeholder) placeholder.remove();

  // Show user bubble
  _appendMessage(command, 'user');
  input.value = '';
  _setLoading(true);

  // Show animated loading bubble
  const loadingBubble = _appendLoadingBubble();

  // POST /command returns immediately with { pending: true, taskId } to avoid
  // the 10-second crossframe bridge timeout imposed by Homey's crossframe.js.
  _Homey.api('POST', '/command', { command })
    .then((result) => {
      if (result.pending && result.taskId) {
        // Start polling — the actual response will be fetched asynchronously
        _pollCommandStatus(result.taskId, loadingBubble);
      } else {
        // Fallback: backend responded synchronously (e.g. validation error before task creation)
        loadingBubble.remove();
        _appendMessage(result.response, 'gemini');
        _setLoading(false);
      }
    })
    .catch((err) => {
      loadingBubble.remove();
      console.error('[gemini_chat widget] POST /command failed. Error details:', {
        message: err.message,
        stack: err.stack,
        statusCode: err.statusCode,
        status: err.status
      });

      // Forward error to the backend so it appears in the Homey terminal
      _Homey.api('POST', '/log-error', {
        message: err.message,
        stack: err.stack,
        statusCode: err.statusCode,
        status: err.status
      }).catch((logErr) => {
        console.warn('[gemini_chat widget] Could not forward error to backend:', logErr.message);
      });

      const errorText = _Homey.__('widget.chat.error.generic') || `Error: ${err.message}`;
      _appendMessage(errorText, 'gemini');
      _setLoading(false);
    });
}

/**
 * Polls the POST /command-status endpoint at regular intervals until the background
 * Gemini task with the given taskId is resolved (status 'done' or 'error').
 *
 * Each individual polling call is extremely fast (< 1ms round trip) and will never
 * approach the 10-second crossframe bridge timeout. The polling will stop automatically
 * after MAX_POLL_ATTEMPTS attempts (approximately 90 seconds), showing an error message
 * if Gemini takes too long to respond.
 *
 * NOTE: POST is used instead of GET because Homey's crossframe.js bridge does not
 * reliably forward the third argument of Homey.api('GET', ...) as query parameters.
 *
 * @private
 * @param {string} taskId - The unique identifier of the background task returned by POST /command.
 * @param {HTMLElement} loadingBubble - The animated loading bubble element, removed when polling ends.
 * @returns {void}
 * @example
 * // Invoked internally by _sendCommand after receiving a pending response:
 * _pollCommandStatus('task-1716678900000-x7f3k', loadingBubbleElement);
 */
function _pollCommandStatus(taskId, loadingBubble) {
  const POLL_INTERVAL_MS = 1500;  // Poll every 1.5 seconds
  const MAX_POLL_ATTEMPTS = 60;   // Maximum ~90 seconds total wait time

  let attempts = 0;
  let pollTimer = null;

  function _executePoll() {
    attempts++;

    if (attempts > MAX_POLL_ATTEMPTS) {
      clearTimeout(pollTimer);
      loadingBubble.remove();
      const errorText = _Homey.__('widget.chat.error.generic') || 'Gemini took too long to respond. Please try again.';
      _appendMessage(errorText, 'gemini');
      _setLoading(false);
      return;
    }

    _Homey.api('POST', '/command-status', { taskId })
      .then((result) => {
        if (result.status === 'pending') {
          // Not ready yet — schedule next poll
          pollTimer = setTimeout(_executePoll, POLL_INTERVAL_MS);
          return;
        }

        // Task completed: stop polling and render result
        clearTimeout(pollTimer);
        loadingBubble.remove();
        _appendMessage(result.response, 'gemini');
        _setLoading(false);
      })
      .catch((err) => {
        console.error('[gemini_chat widget] GET /command-status failed. Error details:', {
          message: err.message,
          stack: err.stack,
          statusCode: err.statusCode,
          status: err.status
        });

        // Forward error to the backend so it appears in the Homey terminal
        _Homey.api('POST', '/log-error', {
          message: err.message,
          stack: err.stack,
          statusCode: err.statusCode,
          status: err.status
        }).catch((logErr) => {
          console.warn('[gemini_chat widget] Could not forward poll error to backend:', logErr.message);
        });

        // A single poll failure is non-fatal — retry after interval
        pollTimer = setTimeout(_executePoll, POLL_INTERVAL_MS);
      });
  }

  // Start the first poll immediately
  _executePoll();
}



/* ─── UI helpers ──────────────────────────────────────────────────────────── */

/**
 * Appends a chat message bubble to the log.
 * @param {string} text   - The message text.
 * @param {'user'|'gemini'} role - Who sent the message.
 * @param {boolean} [animate=true] - Whether to use the typewriter effect.
 * @returns {HTMLElement} The created bubble element.
 */
function _appendMessage(text, role, animate = true) {
  if (!text) return null;

  // Filter out system maximum turn injection that models sometimes echo
  if (role === 'gemini' && text.includes('[System: maximum tool call attempts reached]')) {
    // Remove the system injection text, preserving anything Gemini appended after it
    text = text.replace(/\[System: maximum tool call attempts reached\][\s\S]*?(?:Do NOT call any function or tool\.\*?\*?|repeat the request trying to be more precise\.)/gi, '').trim();
    
    // Fallback if the string was truncated differently
    if (text.includes('[System: maximum tool call attempts reached]')) {
       text = text.replace(/\[System: maximum tool call attempts reached\][^\n]*/gi, '').trim();
    }
    
    if (!text) return null;
  }

  const log    = document.getElementById('chat-log');
  const bubble = document.createElement('div');
  bubble.classList.add('message', role === 'user' ? 'message-user' : 'message-gemini');
  log.appendChild(bubble);

  const formattedHtml = _formatMarkdown(text);

  if (animate) {
    // Natural typing speed: user is faster, Gemini is a bit more deliberate
    _typewriterEffect(bubble, formattedHtml, role === 'user' ? 20 : 40);
  } else {
    bubble.innerHTML = formattedHtml;
    log.scrollBy({ top: log.scrollHeight, behavior: 'smooth' });
    requestAnimationFrame(_updateScrollButtons);
  }

  return bubble;
}

/**
 * Typewriter effect for HTML content. Safely types out text while instantly applying HTML tags.
 * @private
 */
function _typewriterEffect(element, html, speedMs) {
  let i = 0;
  let currentHTML = "";
  const log = document.getElementById('chat-log');

  function type() {
    if (i < html.length) {
      // Fast-forward HTML tags to avoid breaking markup during animation
      if (html[i] === '<') {
        while (i < html.length && html[i] !== '>') {
          currentHTML += html[i];
          i++;
        }
        if (i < html.length) {
          currentHTML += '>'; // close tag
          i++;
        }
      }
      // Fast-forward HTML entities (e.g., &amp;)
      else if (html[i] === '&') {
        while (i < html.length && html[i] !== ';') {
          currentHTML += html[i];
          i++;
        }
        if (i < html.length) {
          currentHTML += ';';
          i++;
        }
      }
      // Normal character
      else {
        currentHTML += html[i];
        i++;
      }

      element.innerHTML = currentHTML;
      log.scrollTop = log.scrollHeight; // Keep scrolled to bottom during typing
      setTimeout(type, speedMs);
    } else {
      // Finished typing
      requestAnimationFrame(_updateScrollButtons);
    }
  }

  type();
}

/**
 * Appends an animated "thinking…" bubble and returns it so it can be removed later.
 * @returns {HTMLElement}
 */
function _appendLoadingBubble() {
  const log    = document.getElementById('chat-log');
  const bubble = document.createElement('div');
  bubble.classList.add('message', 'message-loading');

  const dots  = document.createElement('span');
  dots.classList.add('dots');

  bubble.appendChild(dots);
  log.appendChild(bubble);
  log.scrollBy({ top: log.scrollHeight, behavior: 'smooth' });
  requestAnimationFrame(_updateScrollButtons);
  return bubble;
}

/**
 * Updates the visibility of the scroll-up and scroll-down buttons
 * based on the current scroll position of the chat log.
 * The up-button is hidden when already at the top;
 * the down-button is hidden when already at the bottom.
 * @private
 * @returns {void}
 */
function _updateScrollButtons() {
  const log       = document.getElementById('chat-log');
  const upBtn     = document.getElementById('scroll-up-btn');
  const downBtn   = document.getElementById('scroll-down-btn');
  const atTop     = log.scrollTop <= 2;
  const atBottom  = log.scrollTop + log.clientHeight >= log.scrollHeight - 2;

  upBtn.classList.toggle('hidden', atTop);
  downBtn.classList.toggle('hidden', atBottom);
}

/**
 * Simple Markdown formatter for bold, italic, and line breaks.
 * Sanitizes input to prevent HTML injection.
 * @param {string} text
 * @returns {string} HTML string
 */
function _formatMarkdown(text) {
  if (!text) return '';

  // 1. Basic HTML escaping
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

  // 2. Bold (**text** or __text__)
  html = html.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
  html = html.replace(/__(.*?)__/g, '<b>$1</b>');

  // 3. Italic (*text* or _text_)
  html = html.replace(/\*(.*?)\*/g, '<i>$1</i>');
  html = html.replace(/_(.*?)_/g, '<i>$1</i>');

  // 4. Line breaks
  html = html.replace(/\n/g, '<br>');

  // 5. Unordered list items (- item)
  html = html.replace(/^\s*[-*+]\s+(.*)/gm, '• $1');

  return html;
}

/**
 * Enables or disables the loading state (disables input & button).
 * @param {boolean} loading
 */
function _setLoading(loading) {
  _isLoading = loading;
  const input = document.getElementById('command-input');
  const btn   = document.getElementById('send-btn');
  input.disabled = loading;
  btn.disabled   = loading || input.value.trim().length === 0;
}
/**
 * Restores the chat UI by fetching the current conversation history from
 * the server-side GeminiClient on widget load.
 * If history is empty or unavailable, the placeholder is shown.
 * @private
 * @returns {void}
 */
function _restoreHistory() {
  _Homey.api('GET', '/history', {})
    .then((result) => {
      if (!result.success || !result.messages || result.messages.length === 0) return;

      // Remove the placeholder since we have messages to show
      const placeholder = document.getElementById('chat-placeholder');
      if (placeholder) placeholder.remove();

      // Render each message without triggering an API call, and without typewriter animation
      for (const msg of result.messages) {
        _appendMessage(msg.text, msg.role === 'user' ? 'user' : 'gemini', false);
      }
    })
    .catch((err) => {
      console.warn('[gemini_chat widget] Could not restore history:', err.message);
    });
}

/**
 * Clears the entire chat UI and shows the placeholder again.
 * Called when the Homey 'widget_history_cleared' event is received.
 * @private
 * @returns {void}
 */
function _clearChat() {
  const log = document.getElementById('chat-log');
  // Remove all message bubbles
  while (log.firstChild) log.removeChild(log.firstChild);

  // Re-add the placeholder
  const placeholder = document.createElement('div');
  placeholder.id = 'chat-placeholder';
  placeholder.textContent = _Homey.__('widget.chat.placeholder') || 'Ask Gemini to control your home.';
  log.appendChild(placeholder);

  _updateScrollButtons();
}
