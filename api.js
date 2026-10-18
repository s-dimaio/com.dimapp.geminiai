'use strict';

/**
 * Web API for Gemini AI App
 * Exposes endpoints for settings page to manage scheduled commands and model configuration
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
You must **ALWAYS** extract ONLY the rule or behavior that the user describes. You must **❌ NEVER** add preambles, **❌ NEVER** greet, and **❌ NEVER** provide explanations. You must **ALWAYS** return EXCLUSIVELY the final ready-to-use Markdown content.

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
  },

  /**
   * GET /api/app/com.dimapp.geminiai/models-config
   * Get supported models and default configuration for UI settings
   *
   * @public
   * @param {object} context
   * @param {import('homey')} context.homey
   * @returns {Promise<{ success: boolean, defaultModels?: object, supportedModels?: string[], modelI18nKeys?: object, error?: string }>}
   */
  async getModelsConfig({ homey }) {
    const modelConfig = homey.app?.modelConfig;

    if (!modelConfig) {
      return {
        success: false,
        error: 'GeminiApp not initialized yet.'
      };
    }

    return {
      success: true,
      defaultModels: modelConfig.DEFAULT_MODELS,
      supportedModels: modelConfig.supportedModels || modelConfig.SUPPORTED_MODELS,
      modelI18nKeys: modelConfig.modelI18nKeys || modelConfig.MODEL_I18N_KEYS
    };
  },

  /**
   * GET /api/app/com.dimapp.geminiai/flow-backups
   * Get all flow backups stored on the device
   *
   * @public
   * @param {object} context
   * @param {import('homey')} context.homey
   * @returns {Promise<{ success: boolean, backups?: Array<object>, error?: string }>}
   */
  async getFlowBackups({ homey }) {
    try {
      const flowManager = homey.app?.flowManager;
      if (!flowManager) {
        return {
          success: false,
          error: 'FlowManager not available'
        };
      }

      const result = await flowManager.listBackups();
      if (!result.success) {
        return result;
      }

      const userTimezone = homey?.clock?.getTimezone?.() || 'UTC';
      const userLanguage = homey?.i18n?.getLanguage?.() || 'en';

      const backupsWithLocal = (result.backups || []).map(b => {
        let backedUpAtLocal = b.backedUpAt;
        try {
          backedUpAtLocal = new Date(b.backedUpAt).toLocaleString(userLanguage, {
            timeZone: userTimezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
          });
        } catch (e) {
          // Keep raw string if formatting fails
        }
        return {
          ...b,
          backedUpAtLocal
        };
      });

      return {
        success: true,
        backups: backupsWithLocal,
        count: backupsWithLocal.length
      };
    } catch (error) {
      if (homey?.error) {
        homey.error('[API:getFlowBackups] Error:', error.message || error);
      }
      return {
        success: false,
        error: error.message || 'Error loading flow backups'
      };
    }
  },

  /**
   * POST /api/app/com.dimapp.geminiai/flow-backups/:id/restore
   * Restore a flow from its backup
   *
   * @public
   * @param {object} context
   * @param {import('homey')} context.homey
   * @param {object} context.params
   * @param {string} context.params.id - The flow ID to restore.
   * @returns {Promise<{ success: boolean, flow?: object, message?: string, error?: string }>}
   */
  async restoreFlowBackup({ homey, params }) {
    try {
      const flowId = params?.id;
      if (!flowId) {
        return { success: false, error: 'Flow ID is required' };
      }

      const flowManager = homey.app?.flowManager;
      if (!flowManager) {
        return { success: false, error: 'FlowManager not available' };
      }

      return await flowManager.restoreBackup(flowId);
    } catch (error) {
      if (homey?.error) {
        homey.error('[API:restoreFlowBackup] Error:', error.message || error);
      }
      return {
        success: false,
        error: error.message || 'Error restoring flow'
      };
    }
  },

  /**
   * DELETE /api/app/com.dimapp.geminiai/flow-backups/:id
   * Delete a flow backup
   *
   * @public
   * @param {object} context
   * @param {import('homey')} context.homey
   * @param {object} context.params
   * @param {string} context.params.id - The flow ID of the backup to delete.
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  async deleteFlowBackup({ homey, params }) {
    try {
      const flowId = params?.id;
      if (!flowId) {
        return { success: false, error: 'Flow ID is required' };
      }

      const flowManager = homey.app?.flowManager;
      if (!flowManager) {
        return { success: false, error: 'FlowManager not available' };
      }

      return await flowManager.deleteBackup(flowId);
    } catch (error) {
      if (homey?.error) {
        homey.error('[API:deleteFlowBackup] Error:', error.message || error);
      }
      return {
        success: false,
        error: error.message || 'Error deleting backup'
      };
    }
  }
};

