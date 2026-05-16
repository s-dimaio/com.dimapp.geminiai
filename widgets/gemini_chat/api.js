'use strict';

/**
 * Widget API for the Gemini Chat widget.
 * Acts as a bridge between the widget's frontend (index.html) and the
 * app's GeminiClient, executing MCP smart home commands on behalf of the user.
 */
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

      // Strip internal context prefix from user messages if present
      // Example: "[GENERAL CONTEXT: 2026-05-15T22:05:14 | TZ: Europe/Rome UTC+02:00 | Lang: it] Turn on the light"
      if (role === 'user') {
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
   * Receives a natural language command from the widget UI and forwards it
   * to the GeminiClient's MCP pipeline (same engine used by the send-mcp-command flow card).
   *
   * @public
   * @param {object} options
   * @param {object} options.homey - The Homey app instance.
   * @param {object} options.body - The request body: { command: string }.
   * @returns {Promise<{ success: boolean, response: string, error?: string }>}
   * @example
   * // Called from widget index.html via:
   * // Homey.api('POST', '/command', { command: 'Turn on the kitchen light' });
   */
  async sendCommand({ homey, body }) {
    const geminiClient = homey.app?.geminiClient;

    if (!geminiClient) {
      return {
        success: false,
        response: homey.__('widget.chat.error.no_api') || 'Gemini API key not configured.'
      };
    }

    const command = body?.command;

    if (!command || typeof command !== 'string' || command.trim().length === 0) {
      return {
        success: false,
        response: homey.__('widget.chat.error.empty_command') || 'Command cannot be empty.'
      };
    }

    console.log(`[gemini_chat widget] Received command: "${command}"`);

    try {
      const result = await geminiClient.generateTextWithMCP(command.trim());
      console.log(`[gemini_chat widget] MCP result: success=${result.success}, response length=${result.response?.length}`);

      return {
        success: result.success,
        response: result.response || homey.__('widget.chat.error.no_response') || 'No response received.'
      };
    } catch (error) {
      console.error('[gemini_chat widget] Error executing MCP command:', error.message);
      return {
        success: false,
        response: homey.__('widget.chat.error.generic') || `Error: ${error.message}`
      };
    }
  }
};
