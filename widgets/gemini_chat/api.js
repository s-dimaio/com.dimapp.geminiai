'use strict';

/**
 * Widget API for the Gemini Chat widget.
 * Acts as a bridge between the widget's frontend (index.html) and the
 * app's GeminiClient, executing MCP smart home commands on behalf of the user.
 *
 * In order to avoid the 10-second crossframe bridge timeout imposed by Homey's
 * crossframe.js, command execution is handled asynchronously:
 * - POST /command  → starts execution in the background, returns a taskId immediately.
 * - GET  /command-status → the frontend polls this endpoint to retrieve the result.
 */

/**
 * In-memory map of pending and completed background tasks.
 * Each entry has the shape:
 *   { status: 'pending'|'done'|'error', response: string|null, createdAt: number }
 *
 * @type {Map<string, {status: string, response: string|null, createdAt: number}>}
 */
const _activeTasks = new Map();

/** Maximum age (ms) of a completed task before it is cleaned up. @type {number} */
const TASK_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Generates a short unique ID for a background task.
 *
 * @private
 * @returns {string} A unique task ID string.
 */
function _generateTaskId() {
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Removes completed or failed tasks that are older than TASK_TTL_MS.
 * Should be called periodically to avoid unbounded memory growth.
 *
 * @private
 * @returns {void}
 */
function _cleanupStaleTasks() {
  const cutoff = Date.now() - TASK_TTL_MS;
  for (const [id, task] of _activeTasks.entries()) {
    if (task.status !== 'pending' && task.createdAt < cutoff) {
      _activeTasks.delete(id);
    }
  }
}

module.exports = {

  /**
   * GET /history
   * Returns the current conversation history as a flat array of
   * { role: 'user'|'model', text: string } objects, suitable for
   * reconstructing the chat UI after a page reload.
   * Only text-bearing parts are included; function call/response turns are skipped.
   *
   * @public
   * @param {object} options
   * @param {object} options.homey - The Homey app instance.
   * @returns {Promise<{ success: boolean, messages: Array<{ role: string, text: string }> }>}
   * @example
   * // Called from widget index.html via:
   * // Homey.api('GET', '/history', {});
   */
  async getHistory({ homey }) {
    const geminiClient = homey.app?.geminiClient;

    if (!geminiClient) {
      return { success: false, messages: [] };
    }

    // Ensure history is pruned (e.g., idle timeout checked) before serving it to the widget
    if (typeof geminiClient._pruneConversationHistory === 'function') {
      geminiClient._pruneConversationHistory();
    }

    const rawHistory = geminiClient.conversationHistory || [];

    // Extract only the readable text turns (role: user or model).
    // Each entry has { timestamp, content: { role, parts: [...] } }.
    // We skip turns that have no text part (e.g. function call/response pairs).
    const messages = [];
    for (const entry of rawHistory) {
      const { role, parts } = entry.content || {};
      if (role !== 'user' && role !== 'model') continue;

      const textPart = (parts || []).find(p => typeof p.text === 'string' && p.text.trim().length > 0);
      if (!textPart) continue;

      let text = textPart.text.trim();

      // Strip internal context prefixes from user messages if present.
      // Example: "[GENERAL CONTEXT: 2026-05-15T22:05:14 | TZ: Europe/Rome UTC+02:00 | Lang: it] Turn on the light"
      if (role === 'user') {
        // Skip scheduled commands executed in background (they contain [COMMAND CONTEXT:])
        if (text.includes('[COMMAND CONTEXT:')) continue;

        text = text.replace(/^\[GENERAL CONTEXT:.*?\]\s*/i, '');

        // Skip dummy context injection messages used by flow cards
        if (text.toLowerCase() === '[context]') continue;
      }

      // If text is completely empty after stripping, skip it
      if (text.length === 0) continue;

      messages.push({ role, text });
    }

    return { success: true, messages };
  },

  /**
   * POST /command
   * Receives a natural language command from the widget UI and starts the
   * Gemini MCP pipeline execution in the background.
   *
   * To avoid the 10-second crossframe bridge timeout imposed by Homey's
   * crossframe.js, execution is non-blocking: the method returns a taskId
   * immediately and the actual Gemini response is retrieved via GET /command-status.
   *
   * @public
   * @param {object} options
   * @param {object} options.homey - The Homey app instance.
   * @param {object} options.body - The request body: { command: string }.
   * @returns {Promise<{ success: boolean, pending: boolean, taskId: string }
   *                  |{ success: false, response: string }>}
   * @example
   * // Called from widget index.html via:
   * // const { pending, taskId } = await Homey.api('POST', '/command', { command: 'Turn on the light' });
   */
  async sendCommand({ homey, body }) {
    const geminiClient = homey.app?.geminiClient;

    if (!geminiClient) {
      return {
        success: false,
        pending: false,
        response: homey.__('widget.chat.error.no_api') || 'Gemini API key not configured.'
      };
    }

    const command = body?.command;

    if (!command || typeof command !== 'string' || command.trim().length === 0) {
      return {
        success: false,
        pending: false,
        response: homey.__('widget.chat.error.empty_command') || 'Command cannot be empty.'
      };
    }

    // Clean up stale tasks to avoid memory leaks
    _cleanupStaleTasks();

    const taskId = _generateTaskId();
    console.log(`[gemini_chat widget] Starting background task ${taskId} for command: "${command}"`);

    // Store the task as pending before starting background work
    _activeTasks.set(taskId, { status: 'pending', response: null, createdAt: Date.now() });

    // Start Gemini execution asynchronously — do NOT await it here
    geminiClient.generateTextWithMCP(command.trim())
      .then((result) => {
        const response = result.response || homey.__('widget.chat.error.no_response') || 'No response received.';
        _activeTasks.set(taskId, { status: 'done', response, createdAt: Date.now() });
        console.log(`[gemini_chat widget] Task ${taskId} completed. Response length: ${response.length}`);
      })
      .catch((error) => {
        const errorStr = (error.message || '').toLowerCase();
        const errorDetails = JSON.stringify(error).toLowerCase();

        let response;
        if (
          errorStr.includes('429') ||
          errorStr.includes('quota') ||
          errorStr.includes('resource_exhausted') ||
          errorDetails.includes('429') ||
          errorDetails.includes('resource_exhausted')
        ) {
          response = homey.__('prompt.error.rate_limit_exceeded') || 'Rate limit or daily quota exceeded. Please try again later.';
        } else if (
          errorStr.includes('400') &&
          (errorStr.includes('key') ||
            errorDetails.includes('key') ||
            errorStr.includes('api_key') ||
            errorDetails.includes('api_key'))
        ) {
          response = homey.__('prompt.error.api_key_invalid') || 'Invalid API Key. Please verify in app settings.';
        } else if (
          errorStr.includes('503') ||
          errorStr.includes('service unavailable') ||
          errorStr.includes('high demand')
        ) {
          response = homey.__('prompt.error.service_unavailable') || 'Gemini servers are busy. Please try again.';
        } else {
          const genericMsg = homey.__('widget.chat.error.generic') || 'An error occurred.';
          response = `${genericMsg} Details: ${error.message}`;
        }

        _activeTasks.set(taskId, { status: 'error', response, createdAt: Date.now() });
        console.error(`[gemini_chat widget] Task ${taskId} failed: ${error.message}`);
      });

    // Return immediately — the widget will poll for the result
    return { success: true, pending: true, taskId };
  },

  /**
   * POST /command-status
   * Returns the current status of a background Gemini command task.
   * Called repeatedly by the widget frontend until the task is resolved.
   *
   * NOTE: This endpoint intentionally uses POST (not GET) because Homey's
   * crossframe.js bridge does not reliably forward the third argument of
   * Homey.api('GET', ...) as query parameters. Using POST guarantees that
   * the taskId is delivered in the request body.
   *
   * @public
   * @param {object} options - The option parameters.
   * @param {object} options.homey - The Homey app instance.
   * @param {object} options.body - The request body: { taskId: string }.
   * @param {string} options.body.taskId - The unique identifier of the background task to check.
   * @returns {Promise<{ success: boolean, status: 'pending'|'done'|'error', response?: string }>} The task resolution status and eventual response.
   * @example
   * // Called from widget index.html via:
   * // const result = await Homey.api('POST', '/command-status', { taskId: 'task-...' });
   * // if (result.status === 'done') { /* show result * / }
   */
  async getCommandStatus({ homey, body }) {
    const taskId = body?.taskId;

    if (!taskId) {
      return { success: false, status: 'error', response: 'Missing taskId parameter.' };
    }

    const task = _activeTasks.get(taskId);

    if (!task) {
      return { success: false, status: 'error', response: `Task "${taskId}" not found or already expired.` };
    }

    if (task.status === 'pending') {
      return { success: true, status: 'pending' };
    }

    // Task completed (done or error): remove from map and return response
    _activeTasks.delete(taskId);
    return { success: true, status: task.status, response: task.response };
  },

  /**
   * POST /log-error
   * Receives error logs from the widget frontend (client-side) and prints them to
   * the terminal where the app is running. This is extremely useful for debugging
   * widget behaviors on mobile devices where the browser developer console is inaccessible.
   *
   * @public
   * @param {object} options - Request options container.
   * @param {object} options.homey - The Homey app instance.
   * @param {object} options.body - The request body containing error details.
   * @param {string} options.body.message - The error message.
   * @param {string} [options.body.stack] - The error stack trace (optional).
   * @param {number|string} [options.body.statusCode] - The HTTP status code of the error (optional).
   * @param {number|string} [options.body.status] - Alternate status identifier of the error (optional).
   * @returns {Promise<{ success: boolean }>} Resolution status.
   * @example
   * // Called from widget index.html via:
   * // Homey.api('POST', '/log-error', { message: 'Timeout after 10000ms', statusCode: 'N/A' });
   */
  async logClientError({ homey, body }) {
    const errorDetails = body || {};
    const message = errorDetails.message || 'Unknown error';
    const stack = errorDetails.stack || 'No stack trace available';
    const statusCode = errorDetails.statusCode !== undefined ? errorDetails.statusCode : 'N/A';
    const status = errorDetails.status !== undefined ? errorDetails.status : 'N/A';

    console.error('[gemini_chat widget] Client-side error reported from mobile/browser:');
    console.error(`  Message:    ${message}`);
    console.error(`  Status:     ${status}`);
    console.error(`  StatusCode: ${statusCode}`);
    console.error(`  Stack:      ${stack}`);

    return { success: true };
  }
};
