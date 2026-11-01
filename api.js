'use strict';

const fs = require('fs');

const MAX_LOG_BACKUPS = 2;

/**
 * Returns the expected filename for a diagnostic log file by rotation index.
 *
 * @private
 * @param {number} index - The rotation index (0 for active, 1+ for backups).
 * @returns {string} The log filename.
 * @example
 * const name = _getLogFileName(0); // 'app_debug.log'
 */
function _getLogFileName(index) {
  return index === 0 ? 'app_debug.log' : `app_debug.${index}.log`;
}

/**
 * Formats a raw byte count into human-readable binary unit format (B, KB, MB, GB).
 *
 * @private
 * @param {number} bytes - The number of bytes.
 * @returns {string} Formatted size string.
 * @example
 * const formatted = _formatLogBytes(2048); // '2 KB'
 */
function _formatLogBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * System instruction for the Gemini prompt engineering assistant.
 * Adheres strictly to the established formatting structure and emphasis design system.
 * @constant {string}
 */
const PROMPT_ENGINEER_INSTRUCTION = `# Smart Home Prompt Engineer

## Role and Objectives
You are an expert Home Automation and Prompt Engineering assistant for Athom Homey Pro.
Your task is to transform the user's natural language intent into a robust, structured, and multi-step prompt written natively in Markdown.
This prompt will be saved into the user's Prompt Library and later executed by Gemini inside Homey Flow cards (Actions or Conditions).

## Execution Workflow and Resource Discovery

### ⚠️ CRITICAL ⚠️ Two-Phase Workflow
To produce prompts that execute with zero wasted turns at runtime, you must **ALWAYS** follow this two-phase sequence:
- **Phase 1 (Live Resource Discovery)**: If the user's intent refers to or implies any rooms, people, devices, sensors, capabilities, or past events (e.g., 'Camilla', 'TV', 'luci', 'temperatura', 'accensione'), you must **ALWAYS** call discovery tools (\`discover_resources\`, \`get_device_logs\`, or \`get_home_summary\`) before writing any prompt text. You must **❌ NEVER** generate the final JSON response in Turn 1 without executing discovery first when devices or rooms are mentioned.
- **Phase 2 (Prompt Compilation)**: Once tool results provide the exact device names, zone names, and capability log keys, synthesize the final Markdown prompt embedding those exact identifiers. You must **❌ NEVER** invent, hallucinate, or approximate device names (e.g., do **❌ NEVER** write 'TV Camera di Camilla' when the actual device discovered is 'TV Camera Cami').

### ⚠️ CRITICAL ⚠️ Tool Invocation Boundaries
- **⚠️ CRITICAL**: You must **ALWAYS** use discovery tools (\`discover_resources\`, \`get_device_logs\`, \`get_device_state\`, \`get_home_summary\`) to inspect the real Homey environment.
- You must **❌ NEVER** call state-mutating tools (\`control_device\`, \`trigger_flow\`) or schedule commands on behalf of the user.
- You must **❌ NEVER** answer the user's question directly (e.g., do **❌ NEVER** evaluate whether Camilla can watch TV right now). Your entire output must strictly be the prompt instructions that guide a future agent at runtime.

## Assistant Boundaries and Constraints

### MANDATORY: Target Card Specialization
You must specialize the prompt according to the requested \`TARGET PROMPT TYPE\`:
- **Condition Prompts (\`TARGET PROMPT TYPE: condition\`)**: Formulate instructions for binary evaluation cards. The generated prompt must clearly instruct the runtime agent to verify device states, time of day, day of week, or activity logs, and explicitly mandate the exact criteria for evaluating to TRUE versus FALSE. Embed exact device names and log IDs directly into the verification steps.
- **Action/Command Prompts (\`TARGET PROMPT TYPE: command\`)**: Formulate instructions for multi-step execution cards, specifying exact devices, capability targets, fallback strategies, and confirmation messages.
- **Generic Text Prompts (\`TARGET PROMPT TYPE: text\`)**: Formulate instructions for conversational or descriptive synthesis cards.

### ⚠️ CRITICAL ⚠️ Markdown Structure Enforcement
Regardless of how brief or informal the user's input is, you must **ALWAYS** generate a comprehensive prompt formatted in clean Markdown.
The generated prompt must contain:
- A clear initial statement defining the primary task.
- Structured sections prefixed with \x60###\x60 (e.g. verification criteria, log inspection, evaluation rules, expected action).
- Bullet points (\x60-\x60) and bold highlights (\x60**\x60) for constraints, decision branches, and truth criteria.
- If the prompt is for a condition (evaluation card), explicitly define what conditions result in TRUE and what conditions result in FALSE.
- Explicit references to exact discovered device names and capability log keys (e.g., \`TV Camera Cami\`, \`homey:device:...:onoff\`).

### MANDATORY: Response Schema
You must **ALWAYS** format your final response as a JSON object with this exact structure:
\x60\x60\x60json
{
  "title": "Concise descriptive title in 3 to 6 words",
  "description": "Brief one-sentence description summarizing what this prompt evaluates or performs",
  "prompt": "The complete generated prompt in Markdown format"
}
\x60\x60\x60
You must **❌ NEVER** add preambles, introductory greetings, or commentary outside the JSON object.`;

/**
 * Safely parses the JSON output from the Gemini prompt engineer interaction.
 *
 * @private
 * @param {string} text - The raw text response from Gemini.
 * @param {string} fallbackTitle - A fallback title if title extraction fails.
 * @returns {{ title: string, description: string, prompt: string }} Parsed title, description, and prompt.
 */
function _parseGeneratedPrompt(text, fallbackTitle = 'Custom Prompt') {
  if (!text || typeof text !== 'string') {
    return { title: fallbackTitle, description: '', prompt: '' };
  }

  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '');
    cleaned = cleaned.replace(/\s*```$/, '').trim();
  }

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    try {
      const parsed = JSON.parse(cleaned.substring(firstBrace, lastBrace + 1));
      if (parsed && typeof parsed.prompt === 'string' && parsed.prompt.trim().length > 0) {
        return {
          title: (typeof parsed.title === 'string' && parsed.title.trim().length > 0) ? parsed.title.trim() : fallbackTitle,
          description: (typeof parsed.description === 'string' && parsed.description.trim().length > 0) ? parsed.description.trim() : '',
          prompt: parsed.prompt.trim()
        };
      }
    } catch (e) {
      // JSON parse failed; fall through to markdown fallback
    }
  }

  // Fallback: If Gemini returned Markdown directly without JSON wrapper
  const lines = cleaned.split('\n').map(l => l.trim()).filter(Boolean);
  let title = fallbackTitle;
  if (lines.length > 0 && lines[0].startsWith('#')) {
    title = lines[0].replace(/^#+\s*/, '').trim();
  }

  return {
    title: title || fallbackTitle,
    description: '',
    prompt: cleaned
  };
}

/**
 * Web API for Gemini AI App
 * Exposes endpoints for settings page to manage scheduled commands, model configuration,
 * flow backups, and saved prompts library.
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
  },

  /**
   * GET /api/app/com.dimapp.geminiai/saved-prompts
   * Retrieves all saved prompts, optionally filtered by title search substring.
   *
   * @public
   * @param {object} context
   * @param {import('homey')} context.homey
   * @param {object} [context.query]
   * @param {string} [context.query.search] - Optional search query for prompt title.
   * @returns {Promise<{ success: boolean, prompts?: Array<object>, count?: number, error?: string }>}
   */
  async getSavedPrompts({ homey, query }) {
    try {
      const promptManager = homey.app?.promptManager;
      if (!promptManager) {
        return { success: false, error: 'PromptManager not available' };
      }
      const prompts = promptManager.getAllPrompts({ search: query?.search });
      return {
        success: true,
        prompts,
        count: prompts.length
      };
    } catch (error) {
      if (homey?.error) {
        homey.error('[API:getSavedPrompts] Error:', error.message || error);
      }
      return { success: false, error: error.message || 'Error fetching saved prompts' };
    }
  },

  /**
   * POST /api/app/com.dimapp.geminiai/saved-prompts
   * Creates a new saved prompt in the library.
   *
   * @public
   * @param {object} context
   * @param {import('homey')} context.homey
   * @param {object} context.body
   * @param {string} context.body.title - Mandatory prompt title.
   * @param {string} [context.body.description] - Optional short description.
   * @param {string} context.body.content - Mandatory prompt content in Markdown.
   * @returns {Promise<{ success: boolean, prompt?: object, error?: string }>}
   */
  async saveSavedPrompt({ homey, body }) {
    try {
      const promptManager = homey.app?.promptManager;
      if (!promptManager) {
        return { success: false, error: 'PromptManager not available' };
      }
      const savedPrompt = promptManager.savePrompt(body);
      return { success: true, prompt: savedPrompt };
    } catch (error) {
      if (homey?.error) {
        homey.error('[API:saveSavedPrompt] Error:', error.message || error);
      }
      return { success: false, error: error.message || 'Error saving prompt' };
    }
  },

  /**
   * PUT /api/app/com.dimapp.geminiai/saved-prompts/:id
   * Updates an existing saved prompt.
   *
   * @public
   * @param {object} context
   * @param {import('homey')} context.homey
   * @param {object} context.params
   * @param {string} context.params.id - The prompt unique identifier.
   * @param {object} context.body
   * @param {string} context.body.title - Updated prompt title.
   * @param {string} [context.body.description] - Updated short description.
   * @param {string} context.body.content - Updated prompt content in Markdown.
   * @returns {Promise<{ success: boolean, prompt?: object, error?: string }>}
   */
  async updateSavedPrompt({ homey, params, body }) {
    try {
      const promptManager = homey.app?.promptManager;
      if (!promptManager) {
        return { success: false, error: 'PromptManager not available' };
      }
      const id = params?.id;
      if (!id) {
        return { success: false, error: 'Prompt ID is required' };
      }
      const updatedPrompt = promptManager.savePrompt({ ...body, id });
      return { success: true, prompt: updatedPrompt };
    } catch (error) {
      if (homey?.error) {
        homey.error('[API:updateSavedPrompt] Error:', error.message || error);
      }
      return { success: false, error: error.message || 'Error updating prompt' };
    }
  },

  /**
   * DELETE /api/app/com.dimapp.geminiai/saved-prompts/:id
   * Deletes a saved prompt from the library.
   *
   * @public
   * @param {object} context
   * @param {import('homey')} context.homey
   * @param {object} context.params
   * @param {string} context.params.id - The prompt unique identifier.
   * @returns {Promise<{ success: boolean, deleted?: boolean, error?: string }>}
   */
  async deleteSavedPrompt({ homey, params }) {
    try {
      const promptManager = homey.app?.promptManager;
      if (!promptManager) {
        return { success: false, error: 'PromptManager not available' };
      }
      const id = params?.id;
      if (!id) {
        return { success: false, error: 'Prompt ID is required' };
      }
      const deleted = promptManager.deletePrompt(id);
      return { success: true, deleted };
    } catch (error) {
      if (homey?.error) {
        homey.error('[API:deleteSavedPrompt] Error:', error.message || error);
      }
      return { success: false, error: error.message || 'Error deleting prompt' };
    }
  },

  /**
   * POST /api/app/com.dimapp.geminiai/saved-prompts/:id/duplicate
   * Duplicates an existing prompt and appends a copy suffix.
   *
   * @public
   * @param {object} context
   * @param {import('homey')} context.homey
   * @param {object} context.params
   * @param {string} context.params.id - The prompt unique identifier to duplicate.
   * @returns {Promise<{ success: boolean, prompt?: object, error?: string }>}
   */
  async duplicateSavedPrompt({ homey, params }) {
    try {
      const promptManager = homey.app?.promptManager;
      if (!promptManager) {
        return { success: false, error: 'PromptManager not available' };
      }
      const id = params?.id;
      if (!id) {
        return { success: false, error: 'Prompt ID is required' };
      }
      const duplicated = promptManager.duplicatePrompt(id);
      return { success: true, prompt: duplicated };
    } catch (error) {
      if (homey?.error) {
        homey.error('[API:duplicateSavedPrompt] Error:', error.message || error);
      }
      return { success: false, error: error.message || 'Error duplicating prompt' };
    }
  },

  /**
   * POST /api/app/com.dimapp.geminiai/saved-prompts/generate
   * Generates a structured Markdown prompt and title using Gemini with MCP device discovery.
   *
   * @public
   * @param {object} context
   * @param {import('homey')} context.homey
   * @param {object} context.body
   * @param {string} context.body.text - User description/intent.
   * @param {string} [context.body.type='command'] - Prompt type ('command', 'condition', or 'text').
   * @returns {Promise<{ success: boolean, generatedTitle?: string, generatedPrompt?: string, error?: string }>}
   */
  async generateSavedPrompt({ homey, body }) {
    try {
      const geminiClient = homey.app?.geminiClient;
      if (!geminiClient) {
        return {
          success: false,
          error: homey.__('settings.error.api') || 'GeminiClient not initialized. Please configure API key.'
        };
      }

      const userText = typeof body?.text === 'string' ? body.text.trim() : '';
      if (!userText) {
        return { success: false, error: 'Missing text input.' };
      }

      const promptType = typeof body?.type === 'string' ? body.type.trim() : 'command';
      const promptInput = `USER INTENT:\n${userText}\n\nTARGET PROMPT TYPE: ${promptType}\n\n⚠️ MANDATORY WORKFLOW:\n1. If this intent refers to or implies any rooms, devices, sensors, or people, you MUST call discover_resources first to find the EXACT Homey device names (and get_device_logs for log keys) before writing the prompt.\n2. Do NOT guess or approximate device names. Use the exact discovered names in the generated prompt.\n3. Return the final JSON only after discovery is complete.`;

      const model = geminiClient.shFlowModel || geminiClient.shGenericModel;
      const result = await geminiClient.generateTextWithMCP(promptInput, {
        model: model,
        allowedTools: ['discover_resources', 'get_home_summary', 'get_device_logs', 'get_device_state', 'discover_flow_cards'],
        isolatedSession: true,
        systemInstruction: PROMPT_ENGINEER_INSTRUCTION
      });

      if (homey?.log) {
        homey.log(`[API:generateSavedPrompt] Gemini response: ${result?.response}`);
      }

      if (!result || !result.response) {
        return {
          success: false,
          error: 'No response received from Gemini.'
        };
      }

      const parsed = _parseGeneratedPrompt(result.response, userText.slice(0, 30));

      return {
        success: true,
        generatedTitle: parsed.title,
        generatedDescription: parsed.description,
        generatedPrompt: parsed.prompt
      };
    } catch (error) {
      if (homey?.error) {
        homey.error('[API:generateSavedPrompt] Error:', error.message || error);
      }
      return {
        success: false,
        error: error.message || 'Error communicating with Gemini'
      };
    }
  },

  /**
   * GET /api/app/com.dimapp.geminiai/log/status
   * Retrieves the current diagnostic logging status, active files, and total disk usage.
   *
   * @public
   * @param {object} context
   * @param {import('homey')} context.homey
   * @returns {Promise<{ exists: boolean, files: Array<object>, totalSize: number, totalSizeFormatted: string, debugEnabled: boolean, error?: string }>}
   */
  async getLogStatus({ homey }) {
    try {
      if (homey.app && typeof homey.app.log === 'function') {
        homey.app.log('[API:getLogStatus] Checking diagnostic log files status...');
      }

      const logManager = homey.app?.getLogManager ? homey.app.getLogManager() : homey.app?._logManager;
      if (!logManager) {
        return { exists: false, error: 'LogManager not initialized' };
      }

      const files = [];
      let totalSize = 0;

      for (let i = 0; i <= MAX_LOG_BACKUPS; i++) {
        const filePath = logManager.getLogFilePath(i);
        if (fs.existsSync(filePath)) {
          const stats = fs.statSync(filePath);
          files.push({
            index: i,
            name: _getLogFileName(i),
            path: filePath,
            size: stats.size,
            sizeFormatted: _formatLogBytes(stats.size),
            modified: stats.mtime.toISOString(),
            isCurrent: i === 0
          });
          totalSize += stats.size;
        }
      }

      return {
        exists: files.length > 0,
        files: files,
        totalSize: totalSize,
        totalSizeFormatted: _formatLogBytes(totalSize),
        debugEnabled: logManager.isDebugEnabled()
      };
    } catch (error) {
      if (homey.app && typeof homey.app.error === 'function') {
        homey.app.error('[API:getLogStatus] Error:', error.message || error);
      }
      return { exists: false, error: error.message || error };
    }
  },

  /**
   * GET /api/app/com.dimapp.geminiai/log/download/:index
   * Constructs and returns the direct local HTTP download URL for a diagnostic log file.
   *
   * @public
   * @param {object} context
   * @param {import('homey')} context.homey
   * @param {object} context.params
   * @param {string} context.params.index - The rotation index (0, 1, or 2).
   * @returns {Promise<string>} The local download URL.
   */
  async getLogDownloadFile({ homey, params }) {
    try {
      const index = parseInt(params.index, 10);
      if (isNaN(index) || index < 0 || index > MAX_LOG_BACKUPS) {
        throw new Error('Invalid file index');
      }

      const logManager = homey.app?.getLogManager ? homey.app.getLogManager() : homey.app?._logManager;
      if (!logManager) {
        throw new Error('LogManager not initialized');
      }

      const filePath = logManager.getLogFilePath(index);
      const fileName = _getLogFileName(index);

      if (!fs.existsSync(filePath)) {
        throw new Error(`Log file not found: ${fileName}`);
      }

      const appId = homey.manifest ? homey.manifest.id : homey.app.id;
      const localAddress = await homey.cloud.getLocalAddress();
      const downloadUrl = `http://${localAddress}/app/${appId}/userdata/${fileName}`;

      if (homey.app && typeof homey.app.log === 'function') {
        homey.app.log(`[API:getLogDownloadFile] Generated download URL for ${fileName}: ${downloadUrl}`);
      }
      return downloadUrl;
    } catch (error) {
      if (homey.app && typeof homey.app.error === 'function') {
        homey.app.error('[API:getLogDownloadFile] Error:', error.message || error);
      }
      throw error;
    }
  },

  /**
   * DELETE /api/app/com.dimapp.geminiai/log/all
   * Deletes all stored diagnostic log files and resets the write queue.
   *
   * @public
   * @param {object} context
   * @param {import('homey')} context.homey
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  async deleteAllLogs({ homey }) {
    try {
      if (homey.app && typeof homey.app.log === 'function') {
        homey.app.log('[API:deleteAllLogs] Deleting all diagnostic log files...');
      }

      const logManager = homey.app?.getLogManager ? homey.app.getLogManager() : homey.app?._logManager;
      if (!logManager) {
        throw new Error('LogManager not initialized');
      }

      await logManager.clearLogs();
      return { success: true };
    } catch (error) {
      if (homey.app && typeof homey.app.error === 'function') {
        homey.app.error('[API:deleteAllLogs] Error:', error.message || error);
      }
      return { success: false, error: error.message || error };
    }
  },

  /**
   * DELETE /api/app/com.dimapp.geminiai/log/:index
   * Deletes a specific diagnostic log file by its rotation index.
   *
   * @public
   * @param {object} context
   * @param {import('homey')} context.homey
   * @param {object} context.params
   * @param {string} context.params.index - The rotation index to delete ('all' or '0'..'2').
   * @returns {Promise<{ success: boolean, deletedFile?: string, error?: string }>}
   */
  async deleteLogFile({ homey, params }) {
    try {
      if (params && params.index === 'all') {
        return this.deleteAllLogs({ homey });
      }

      const index = parseInt(params.index, 10);
      if (isNaN(index) || index < 0 || index > MAX_LOG_BACKUPS) {
        throw new Error('Invalid file index');
      }

      const logManager = homey.app?.getLogManager ? homey.app.getLogManager() : homey.app?._logManager;
      if (!logManager) {
        throw new Error('LogManager not initialized');
      }

      const filePath = logManager.getLogFilePath(index);
      const fileName = _getLogFileName(index);

      if (index === 0) {
        logManager.clearWriteQueue();
      }
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

      if (homey.app && typeof homey.app.log === 'function') {
        homey.app.log(`[API:deleteLogFile] Deleted file: ${fileName}`);
      }
      return { success: true, deletedFile: fileName };
    } catch (error) {
      if (homey.app && typeof homey.app.error === 'function') {
        homey.app.error('[API:deleteLogFile] Error:', error.message || error);
      }
      return { success: false, error: error.message || error };
    }
  }
};

