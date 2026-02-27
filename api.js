'use strict';

/**
 * Web API for Gemini AI App
 * Exposes endpoints for settings page to manage scheduled commands
 */
module.exports = {
  /**
   * GET /api/app/com.dimapp.geminiai/scheduled-commands
   * Get all scheduled commands
   */
  async getScheduledCommands({ homey }) {
    const scheduledCommands = homey.settings.get('scheduled_commands') || {};

    // Convert to array with formatted data for UI
    const commandsList = Object.entries(scheduledCommands).map(([scheduleId, schedule]) => {
      const executeAt = new Date(schedule.executeAt);
      const now = new Date();
      const delayMs = executeAt.getTime() - now.getTime();

      // Get user's timezone and language for display
      const userTimezone = homey?.clock?.getTimezone?.() || 'UTC';
      const userLanguage = homey?.i18n?.getLanguage?.() || 'en';

      return {
        scheduleId,
        command: schedule.command,
        description: schedule.description,
        executeAt: schedule.executeAt,
        executeAtLocal: executeAt.toLocaleString(userLanguage, {
          timeZone: userTimezone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false
        }),
        createdAt: schedule.createdAt,
        status: schedule.status,
        isPast: delayMs < 0,
        delayMinutes: Math.round(delayMs / 60000)
      };
    })
      // Sort by execution time (earliest first)
      .sort((a, b) => new Date(a.executeAt) - new Date(b.executeAt));

    return {
      success: true,
      commands: commandsList,
      count: commandsList.length
    };
  },

  /**
   * DELETE /api/app/com.dimapp.geminiai/scheduled-commands/:id
   * Cancel a scheduled command
   */
  async cancelScheduledCommand({ homey, params }) {
    // Log params for debugging
    console.log('[cancelScheduledCommand] Received params:', JSON.stringify(params));

    const scheduleId = params.id;

    console.log('[cancelScheduledCommand] Schedule ID:', scheduleId);

    if (!scheduleId) {
      return {
        success: false,
        error: 'Schedule ID is required',
        receivedParams: params
      };
    }

    // Get MCP adapter from app
    const mcpAdapter = homey.app?.geminiClient?.mcpAdapter;

    if (!mcpAdapter) {
      console.log('[cancelScheduledCommand] MCP Adapter not available - geminiClient:', !!homey.app?.geminiClient);
      return {
        success: false,
        error: 'MCP Adapter not available. Please ensure Gemini API key is configured.'
      };
    }

    console.log('[cancelScheduledCommand] MCP Adapter found, calling cancelScheduledCommand');

    // Cancel the scheduled command (clears timeout + removes from settings)
    const result = await mcpAdapter.cancelScheduledCommand(scheduleId);

    console.log('[cancelScheduledCommand] Result:', JSON.stringify(result));

    return result;
  },

  /**
   * DELETE /api/app/com.dimapp.geminiai/conversation-history
   * Clear the entire Gemini conversation history
   */
  async clearConversationHistory({ homey }) {
    const geminiClient = homey.app?.geminiClient;

    if (!geminiClient) {
      return {
        success: false,
        error: 'GeminiClient not initialized. Please configure the Gemini API key in settings.'
      };
    }

    geminiClient.clearConversationHistory();

    return { success: true };
  }
};
