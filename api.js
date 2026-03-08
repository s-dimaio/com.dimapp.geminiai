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

    // Get MCP adapter from app, then derive the scheduler from it
    const mcpAdapter = homey.app?.geminiClient?.mcpAdapter;

    if (!mcpAdapter) {
      console.log('[cancelScheduledCommand] MCP Adapter not available - geminiClient:', !!homey.app?.geminiClient);
      return {
        success: false,
        error: 'MCP Adapter not available. Please ensure Gemini API key is configured.'
      };
    }

    // Get scheduler from MCP adapter
    const scheduler = mcpAdapter.scheduler;

    if (!scheduler) {
      return {
        success: false,
        error: 'Scheduler not available on MCP Adapter.'
      };
    }

    console.log('[cancelScheduledCommand] Scheduler found, calling cancelScheduledCommand');

    // Cancel via scheduler (clears timeout + removes from settings)
    const result = await scheduler.cancelScheduledCommand(scheduleId);

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
  },

  /**
   * POST /api/app/com.dimapp.geminiai/generate-custom-prompt
   * Generate formatted Markdown system prompt from user natural language
   */
  async generateCustomPrompt({ homey, body }) {
    const geminiClient = homey.app?.geminiClient;

    if (!geminiClient) {
      return {
        success: false,
        error: homey.__("settings.error.api") || "GeminiClient not initialized. Please configure API key."
      };
    }

    if (!body || !body.text) {
      return {
        success: false,
        error: "Missing text input."
      };
    }

    console.log('[generateCustomPrompt] Received input text of length:', body.text.length);

    try {
      const metaPrompt = `Translate and format the following user instruction into one or more concise directive rules in ENGLISH, **formatted natively in Markdown** (use \`-\`, \`**\`, etc. where necessary for maximum clarity).
These rules will be injected into the System Prompt of a Smart Home assistant for the Homey app.
You must extract ONLY the rule or behavior that the user describes. Do not add preambles, do not greet, do not provide explanations. Return EXCLUSIVELY the final ready-to-use Markdown content.

USER TEXT:
${body.text}`;

      const generatedMarkdown = await geminiClient.generateText(metaPrompt);
      console.log('[generateCustomPrompt] Generated prompt of length:', generatedMarkdown.length);

      return {
        success: true,
        generatedPrompt: generatedMarkdown
      };
    } catch (error) {
      console.error('[generateCustomPrompt] Error generating prompt:', error);
      return {
        success: false,
        error: error.message || 'Error communicating with Gemini'
      };
    }
  }
};
