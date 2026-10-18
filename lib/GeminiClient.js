'use strict';

const { GoogleGenAI } = require('@google/genai');
const { Readable } = require('stream');
const { HomeyMCPAdapter } = require('./HomeyMCPAdapter');
const { SystemInstruction } = require('./SystemInstruction');
const { DEFAULT_MODELS, resolveModel, getThinkingConfig, isThinkingModel } = require('./ModelConfig');
const { getInteractionTools } = require('./ToolSchema');

// Gemini model configuration
const DEFAULT_SMART_HOME_MODEL = DEFAULT_MODELS.shGeneric;  // Default model for Smart Home / MCP functions
const DEFAULT_CHAT_MODEL = DEFAULT_MODELS.chat;             // Default model for simple text/multimodal chat
const GEMINI_IMAGE_MODEL = DEFAULT_MODELS.image;            // Model for image generation

// Conversation history configuration
const CONVERSATION_HISTORY_MAX_MESSAGES = 30;        // Max messages before oldest are dropped
const CONVERSATION_HISTORY_MAX_UNCACHED_TOKENS = 30000; // Max estimated uncached tokens; excess functionCall+functionResponse pairs are pruned first
const CONVERSATION_HISTORY_IDLE_TIMEOUT_DEFAULT_MIN = 30; // Default idle timeout in minutes before history is auto-cleared
const CONVERSATION_HISTORY_IDLE_TIMEOUT_MIN_MIN = 10;     // Minimum configurable idle timeout (minutes)
const CONVERSATION_HISTORY_IDLE_TIMEOUT_MAX_MIN = 240;    // Maximum configurable idle timeout (minutes)

// MCP function-calling loop configuration
const MAX_TURNS = 15; // Maximum number of tool-call turns before forcing a give-up response

// Tools that read real-time device state and must never run in parallel with
// tools that mutate state (control_device, trigger_flow, run_action_card).
// If any call in a batch belongs to this set AND other calls mutate state,
// the entire batch is executed sequentially to avoid stale-state race conditions.
const SEQUENTIAL_REQUIRED_TOOLS = new Set([
  'get_home_summary',
  'get_device_state',
]);

// Tools that mutate device state. Used together with SEQUENTIAL_REQUIRED_TOOLS
// to detect mixed (mutation + query) batches that require sequential execution.
const STATE_MUTATING_TOOLS = new Set([
  'control_device',
  'trigger_flow',
  'run_action_card',
]);

// Schema for yes/no condition evaluation structured outputs
const CONDITION_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    isAnswerable: {
      type: 'boolean',
      description: 'MANDATORY: Set to true ONLY if the prompt is a polar/binary question or factual statement that strictly resolves to YES or NO. Set to false if the prompt is an open-ended question (e.g. asking who, what, when, where, why, what time, how, which), subjective query, command, or unanswerable condition.'
    },
    result: {
      type: 'boolean',
      description: 'The boolean truth value of the condition (true for YES, false for NO). If isAnswerable is false, this must be set to false.'
    },
    explanation: {
      type: 'string',
      description: 'Brief explanation of the answer, or the reason why the prompt cannot be answered with a binary yes or no. Always in the language of the prompt.'
    }
  },
  required: ['isAnswerable', 'result', 'explanation']
};

// Network & HTTP timeout configuration
const DEFAULT_REQUEST_TIMEOUT_MS = 90000; // Default HTTP timeout per remote API request (90 seconds)

class GeminiClient {
  /**
   * Initializes a new instance of the GeminiClient.
   *
   * @public
   * @constructor
   * @param {string} apiKey - The Google Gemini API key (mandatory).
   * @param {Object} [options={}] - Configuration options for the client.
   * @param {import('homey')} [options.homey] - The Homey application instance.
   * @param {string} [options.chatModel] - The model identifier for Conversational AI.
   * @param {string} [options.shGenericModel] - The model identifier for generic Smart Home commands.
   * @param {string} [options.shFlowModel] - The model identifier for flow automation commands.
   * @param {string} [options.smartHomeModel] - Deprecated alias for shGenericModel.
   * @param {string} [options.modelName] - Deprecated alias for smartHomeModel.
   * @param {string} [options.customInstructions] - Custom system instruction overrides.
   * @param {boolean} [options.enableGoogleSearch=true] - Whether to enable Google Search grounding.
   * @param {number} [options.requestTimeoutMs=90000] - Remote HTTP request timeout in milliseconds.
   * @throws {Error} If the apiKey is missing or invalid.
   * @example
   * const client = new GeminiClient('AIzaSy...', {
   *   homey: this.homey,
   *   chatModel: 'gemini-3.1-flash-lite',
   *   shGenericModel: 'gemini-3.8-flash',
   *   shFlowModel: 'gemini-3.8-flash',
   *   requestTimeoutMs: 90000
   * });
   */
  constructor(apiKey, options = {}) {
    if (!apiKey) {
      throw new Error("API key is required");
    }
    this.options = options;
    this.homey = options.homey;

    const requestTimeoutMs = typeof options.requestTimeoutMs === 'number' && options.requestTimeoutMs > 0
      ? options.requestTimeoutMs
      : DEFAULT_REQUEST_TIMEOUT_MS;

    this.genAI = new GoogleGenAI({
      apiKey: apiKey,
      httpOptions: {
        timeout: requestTimeoutMs
      }
    });

    // Model configuration (resolved and sanitized against ModelConfig)
    // chatModel: used for simple text/multimodal prompts (faster/cheaper / Conversational AI)
    // shGenericModel: used for generic smart home commands (basic MCP tools)
    // shFlowModel: used for flow/automation commands (manage_flow/manage_advanced_flow)
    this.chatModel = resolveModel('chat', options.chatModel);
    this.shGenericModel = resolveModel('shGeneric', options.shGenericModel || options.smartHomeModel || options.modelName);
    this.shFlowModel = resolveModel('shFlow', options.shFlowModel || options.smartHomeModel || options.modelName);
    // Keep smartHomeModel for backwards compatibility / log output fallback
    this.smartHomeModel = this.shGenericModel;
    
    this.customInstructions = options.customInstructions || '';
    this.enableGoogleSearch = options.enableGoogleSearch !== false;

    this.mcpAdapter = this.homey ? new HomeyMCPAdapter(this.homey) : null;

    // Conversation history for multi-call memory and widget exposition
    // Each entry: { timestamp: number, content: object, isCondition?: boolean }
    this.conversationHistory = [];

    // Tracks the last server-side interaction ID for chaining multi-turn conversation
    this._lastInteractionId = null;

    // Buffer for context seeded externally (e.g. from seedConversationContext flow card)
    this._seededContext = null;

    // Active model for the current ongoing conversation session.
    // Starts as shGenericModel and upgrades dynamically. Resets when history is cleared.
    this.activeConversationModel = this.shGenericModel;

    console.log(`[GeminiClient] Initialized with Chat Model: ${this.chatModel}, Generic Smart Home Model: ${this.shGenericModel}, Flow Smart Home Model: ${this.shFlowModel}`);
  }

  // ── Private Methods ──────────────────────────────────────────────────────────

  /**
   * Builds the generation_config object for interactions.create.
   *
   * @private
   * @param {string} modelName - The model identifier.
   * @param {Object} [options={}] - Configuration options.
   * @param {number} [options.temperature] - Sampling temperature override.
   * @param {string} [options.toolChoice] - Tool choice mode ('auto' | 'none' | 'any' | 'validated').
   * @param {string} [options.thinkingLevel] - Explicit thinking level override ('minimal' | 'low' | 'medium' | 'high').
   * @returns {object} The generation_config object conforming to GenerationConfig_2.
   * @example
   * const config = this._buildGenerationConfig('gemini-3.8-flash', { temperature: 1.0 });
   */
  _buildGenerationConfig(modelName, options = {}) {
    const isGemini3OrHigher = modelName.includes('gemini-3') || modelName.includes('gemini-4');
    const config = {};

    if (typeof options.temperature === 'number') {
      config.temperature = options.temperature;
    } else if (!isGemini3OrHigher) {
      config.temperature = 0.0;
    }

    if (options.toolChoice) {
      config.tool_choice = options.toolChoice;
    }

    if (isThinkingModel(modelName)) {
      config.thinking_level = options.thinkingLevel || 'low';
    }

    return config;
  }

  /**
   * Extracts output text from an interaction response.
   * Uses interaction.output_text if provided by the SDK, or falls back to
   * extracting text blocks from the latest model_output step.
   *
   * @private
   * @param {import('@google/genai').Interactions.Interaction} interaction - The interaction response.
   * @returns {string} The concatenated output text.
   * @example
   * const text = this._extractOutputText(interaction);
   */
  _extractOutputText(interaction) {
    if (typeof interaction?.output_text === 'string' && interaction.output_text.length > 0) {
      return interaction.output_text;
    }

    if (Array.isArray(interaction?.steps)) {
      const modelOutputs = interaction.steps.filter(s => s.type === 'model_output');
      if (modelOutputs.length > 0) {
        const lastOutput = modelOutputs[modelOutputs.length - 1];
        if (Array.isArray(lastOutput.content)) {
          const textParts = lastOutput.content
            .filter(c => c.type === 'text' && typeof c.text === 'string')
            .map(c => c.text);
          if (textParts.length > 0) {
            return textParts.join('');
          }
        }
      }
    }

    return '';
  }

  /**
   * Extracts function call steps from an interaction response.
   *
   * @private
   * @param {import('@google/genai').Interactions.Interaction} interaction - The interaction response.
   * @returns {Array<{ id: string, name: string, args: object }>} Array of extracted function calls.
   * @example
   * const functionCalls = this._extractFunctionCalls(interaction);
   */
  _extractFunctionCalls(interaction) {
    if (!Array.isArray(interaction?.steps)) {
      return [];
    }

    return interaction.steps
      .filter(step => step.type === 'function_call')
      .map(step => ({
        id: step.id,
        name: step.name,
        args: step.arguments || {}
      }));
  }

  /**
   * Logs token usage statistics for an interaction.
   *
   * @private
   * @param {string} operation - The operation name.
   * @param {import('@google/genai').Interactions.Usage} [usage] - The usage metrics object from the interaction.
   * @returns {void}
   * @example
   * this._logTokenUsage('generateText', interaction.usage);
   */
  _logTokenUsage(operation, usage) {
    if (!usage) return;
    const input = usage.total_input_tokens ?? 0;
    const cached = usage.total_cached_tokens ?? 0;
    const output = usage.total_output_tokens ?? 0;
    const thought = usage.total_thought_tokens ?? 0;
    const total = usage.total_tokens ?? (input + output);
    const cachedStr = cached > 0 ? `, cached: ${cached}` : '';
    const thoughtStr = thought > 0 ? `, thought: ${thought}` : '';
    const logMsg = `[GeminiClient:${operation}] Token usage - input: ${input}${cachedStr}, output: ${output}${thoughtStr}, total: ${total}`;
    if (this.homey && typeof this.homey.log === 'function') {
      this.homey.log(logMsg);
    } else {
      console.log(logMsg);
    }
  }

  /**
   * Returns whether the given model belongs to the Gemini 2.5 family.
   *
   * Gemini 2.5 models do not support combining Function Calling (MCP tools)
   * and Google Search Grounding (Built-in Tools) in the same request.
   * Attempting to do so results in a 400 INVALID_ARGUMENT error:
   * "Built-in tools ({google_search}) and Function Calling cannot be combined in the same request."
   *
   * This method is used to gate Google Search Grounding exclusively for MCP
   * Smart Home sessions that use a 2.5 model, while leaving the Conversational
   * AI (chatModel) paths unaffected.
   *
   * @private
   * @param {string} modelName - The Gemini model name to inspect.
   * @returns {boolean} `true` if the model belongs to the 2.5 family, `false` otherwise.
   * @example
   * this._isGemini25Model('gemini-2.5-flash-lite'); // true
   * this._isGemini25Model('gemini-3.1-flash-lite'); // false
   */
  _isGemini25Model(modelName) {
    return typeof modelName === 'string' && modelName.includes('gemini-2.5');
  }

  /**
   * Retries a request on 429 (Resource Exhausted) errors using exponential backoff.
   * Aborts early if the suggested wait time exceeds per-retry or total limits,
   * since extremely long waits typically indicate quota exhaustion rather than transient limits.
   *
   * @private
   * @param {Function} apiCallFn - The async function to execute.
   * @param {string} [operationName='API Request'] - Name of the operation for logging.
   * @returns {Promise<any>} Result of the API call.
   * @throws {Error} Re-throws the original error if not retryable or if limits are exceeded.
   * @example
   * const result = await this._retryableRequest(
   *   () => this.genAI.models.generateContent({ model: 'gemini-2.5-flash-lite', contents: 'Hello' }),
   *   'generateText'
   * );
   */
  async _retryableRequest(apiCallFn, operationName = 'API Request') {
    const MAX_RETRIES = 2;
    const MAX_SINGLE_WAIT_MS = 5000; // Max 5s wait per retry (suitable for home automation)
    const MAX_TOTAL_WAIT_MS = 10000; // Max 10s total wait (Homey flows timeout at 30s)
    let retries = 0;
    let totalWaitTime = 0;

    while (true) {
      try {
        return await apiCallFn();
      } catch (error) {
        const errorStr = (error.message || '').toLowerCase();
        const errorDetails = JSON.stringify(error).toLowerCase();

        // Check if error is 429 (Quota) or 503 (Service Unavailable / High Demand)
        const is503 = errorStr.includes('503') ||
          errorStr.includes('service unavailable') ||
          errorStr.includes('high demand') ||
          errorDetails.includes('503') ||
          errorDetails.includes('service_unavailable');

        const is429 = errorStr.includes('429') ||
          errorStr.includes('quota') ||
          errorStr.includes('resource_exhausted') ||
          errorDetails.includes('429') ||
          errorDetails.includes('resource_exhausted');

        const isRetryableError = is503 || is429;
 
        if (!isRetryableError || retries >= MAX_RETRIES) {
          throw error;
        }

        // Determine wait time
        let waitTimeMs = 2000 * Math.pow(2, retries); // Default exponential backoff: 2s, 4s

        // Try to parse "retry in X s" from error message
        // Example: "Please retry in 36.223707311s."
        const retryMatch = errorStr.match(/retry in ([0-9.]+)\s?s/);
        if (retryMatch?.[1]) {
          const parsedSeconds = parseFloat(retryMatch[1]);
          if (!isNaN(parsedSeconds)) {
            waitTimeMs = Math.ceil(parsedSeconds * 1000);
          }
        }

        // Check if single wait exceeds max per-retry limit (likely quota exhaustion, not transient rate limit)
        if (waitTimeMs > MAX_SINGLE_WAIT_MS) {
          console.warn(`[GeminiClient] [${operationName}] Retry suggested in ${waitTimeMs}ms exceeds max single wait of ${MAX_SINGLE_WAIT_MS}ms. This is likely a quota exhaustion, not a transient rate limit. Giving up.`);
          throw error;
        }

        // Check if waiting would exceed total allowable time
        if (totalWaitTime + waitTimeMs > MAX_TOTAL_WAIT_MS) {
          console.warn(`[GeminiClient] [${operationName}] Retry would exceed max total wait of ${MAX_TOTAL_WAIT_MS}ms. Giving up.`);
          throw error;
        }

        const errorLabel = is503 ? '503 Service Unavailable' : '429 Rate limit';
        console.log(`[GeminiClient] [${operationName}] ${errorLabel}. Retrying in ${waitTimeMs}ms (Attempt ${retries + 1}/${MAX_RETRIES})...`);

        await new Promise(resolve => setTimeout(resolve, waitTimeMs));

        totalWaitTime += waitTimeMs;
        retries++;
      }
    }
  }

  /**
   * Estimates the token count of a Gemini Content object without an API call.
   *
   * Uses the standard heuristic of 1 token ≈ 4 characters, which works well
   * for mixed Italian/English/JSON payloads. Serialises the full content object
   * so that functionCall and functionResponse payloads are included in the count.
   *
   * @private
   * @param {import('@google/genai').Content} content - The content object to estimate.
   * @returns {number} Estimated token count (rounded up).
   * @example
   * const tokens = this._estimateTokens({ role: 'user', parts: [{ text: 'Hello' }] });
   * // 3 (approx)
   */
  _estimateTokens(content) {
    return Math.ceil(JSON.stringify(content).length / 4);
  }

  /**
   * Trims the conversation history in four phases:
   * 0. Time-based idle reset: if the last message timestamp exceeds the configured
   *    idle timeout (read from Homey setting `conversation_history_timeout`, default
   *    {@link CONVERSATION_HISTORY_IDLE_TIMEOUT_DEFAULT_MIN} minutes), the entire history
   *    is cleared and the method returns early.
   * 1. Cap by message count (slice to {@link CONVERSATION_HISTORY_MAX_MESSAGES}).
   * 2. Cap by estimated uncached token count: iteratively removes the oldest
   *    `functionCall+functionResponse` pair until estimated tokens fall within
   *    {@link CONVERSATION_HISTORY_MAX_UNCACHED_TOKENS}. Text-only turns are never
   *    removed here — they carry the conversational context.
   * 3. Ensure the history starts with a clean 'user' text turn to prevent
   *    INVALID_ARGUMENT errors caused by orphaned functionResponse entries at
   *    the beginning of the history array.
   *
   * Called automatically before each {@link GeminiClient#generateTextWithMCP} call.
   *
   * @private
   * @returns {void}
   * @example
   * // Called internally before every MCP session:
   * this._pruneConversationHistory();
   */
  _pruneConversationHistory() {
    if (this.conversationHistory.length === 0) {
      return;
    }

    const beforeCount = this.conversationHistory.length;

    // ── Phase 0: time-based idle reset ───────────────────────────────────────
    // Read configurable timeout from Homey settings (minutes), with validation.
    if (this.homey && this.conversationHistory.length > 0) {
      const rawTimeout = this.homey.settings.get('conversation_history_timeout');
      const timeoutMin = Math.min(
        CONVERSATION_HISTORY_IDLE_TIMEOUT_MAX_MIN,
        Math.max(
          CONVERSATION_HISTORY_IDLE_TIMEOUT_MIN_MIN,
          Number.isFinite(Number(rawTimeout)) && Number(rawTimeout) > 0
            ? Number(rawTimeout)
            : CONVERSATION_HISTORY_IDLE_TIMEOUT_DEFAULT_MIN
        )
      );
      const timeoutMs = timeoutMin * 60 * 1000;
      const lastTimestamp = this.conversationHistory[this.conversationHistory.length - 1].timestamp;
      const idleMs = Date.now() - lastTimestamp;

      if (idleMs > timeoutMs) {
        const idleMin = Math.round(idleMs / 60000);
        console.log(`[GeminiClient] Conversation history expired: idle for ${idleMin} min (timeout: ${timeoutMin} min). Clearing history.`);
        this.conversationHistory = [];
        this._lastInteractionId = null;
        this.activeConversationModel = this.shGenericModel;
        this._emitHistoryCleared();
        return;
      }
    }

    // ── Phase 1: cap by message count ────────────────────────────────────────
    if (this.conversationHistory.length > CONVERSATION_HISTORY_MAX_MESSAGES) {
      this.conversationHistory = this.conversationHistory.slice(-CONVERSATION_HISTORY_MAX_MESSAGES);
    }

    // ── Phase 2: cap by estimated token count ────────────────────────────────
    // functionCall+functionResponse pairs are the primary token hogs (large JSON payloads).
    // Remove the oldest such pair iteratively until estimated tokens are within budget.
    // Text-only turns are never removed here — they carry the conversational context.
    let estimatedTokens = this.conversationHistory.reduce(
      (sum, entry) => sum + this._estimateTokens(entry.content), 0
    );

    if (estimatedTokens > CONVERSATION_HISTORY_MAX_UNCACHED_TOKENS) {
      console.log(`[GeminiClient] Token-aware prune triggered: estimated ${estimatedTokens} tokens > ${CONVERSATION_HISTORY_MAX_UNCACHED_TOKENS} limit`);

      let pruned = 0;
      let safety = 0; // guard against infinite loop
      const MAX_PRUNE_ITERATIONS = 20;

      while (estimatedTokens > CONVERSATION_HISTORY_MAX_UNCACHED_TOKENS && safety < MAX_PRUNE_ITERATIONS) {
        safety++;

        // Find the first functionCall+functionResponse pair (always consecutive):
        //   entry[i]   = { content: { role: 'model', parts: [{ functionCall: ... }] } }
        //   entry[i+1] = { content: { role: 'user',  parts: [{ functionResponse: ... }] } }
        const pairIdx = this.conversationHistory.findIndex((entry, i) => {
          const next = this.conversationHistory[i + 1];
          if (!next) return false;
          const hasFunctionCall = entry.content?.role === 'model' &&
            Array.isArray(entry.content?.parts) &&
            entry.content.parts.some(p => p.functionCall);
          const hasFunctionResponse = next.content?.role === 'user' &&
            Array.isArray(next.content?.parts) &&
            next.content.parts.some(p => p.functionResponse);
          return hasFunctionCall && hasFunctionResponse;
        });

        if (pairIdx === -1) {
          // No more pairs to remove — cannot reduce further without losing text context
          console.log('[GeminiClient] Token-aware prune: no more functionCall+functionResponse pairs to remove');
          break;
        }

        const removedTokens =
          this._estimateTokens(this.conversationHistory[pairIdx].content) +
          this._estimateTokens(this.conversationHistory[pairIdx + 1].content);

        this.conversationHistory.splice(pairIdx, 2);
        estimatedTokens -= removedTokens;
        pruned += 2;
      }

      if (pruned > 0) {
        console.log(`[GeminiClient] Token-aware prune: removed ${pruned} entries, estimated tokens now ~${estimatedTokens}`);
      }
    }

    // ── Phase 3: ensure history starts with a clean user text turn ────────────
    // After slicing or pair-removal, the first entry could be a functionResponse
    // (role=user, functionResponse part) — which causes a 400 error:
    // "function response turn comes immediately after a function call turn".
    const firstCleanUserIdx = this.conversationHistory.findIndex(entry => {
      if (entry.content?.role !== 'user') return false;
      const parts = entry.content?.parts;
      if (!Array.isArray(parts) || parts.length === 0) return false;
      return parts.some(p => typeof p.text === 'string');
    });
    if (firstCleanUserIdx > 0) {
      this.conversationHistory = this.conversationHistory.slice(firstCleanUserIdx);
      console.log(`[GeminiClient] Pruned ${firstCleanUserIdx} leading non-text entries to ensure valid history start`);
    } else if (firstCleanUserIdx === -1) {
      // No clean user entry at all — the entire history is invalid, clear it
      this.conversationHistory = [];
      this.activeConversationModel = this.shGenericModel;
      console.log('[GeminiClient] Cleared entire history: no clean user entry found after pruning');
    }

    if (beforeCount !== this.conversationHistory.length) {
      console.log(`[GeminiClient] Pruned conversation history: ${beforeCount} → ${this.conversationHistory.length} entries`);
    }
  }

  /**
   * Adds a message to the conversation history with the current timestamp.
   *
   * @private
   * @param {import('@google/genai').Content} content - The message content object (role + parts).
   * @returns {void}
   * @example
   * this._addToConversationHistory({ role: 'user', parts: [{ text: 'Hello' }] });
   */
  _addToConversationHistory(content) {
    this.conversationHistory.push({
      timestamp: Date.now(),
      content: content
    });
  }

  /**
   * Returns the current conversation history as an array of content objects,
   * stripping the internal timestamp wrapper.
   *
   * @private
   * @returns {import('@google/genai').Content[]} Array of content objects for the Gemini API.
   * @example
   * const history = this._getConversationHistoryContents();
   * // [{ role: 'user', parts: [...] }, { role: 'model', parts: [...] }]
   */
  _getConversationHistoryContents() {
    return this.conversationHistory.map(entry => entry.content);
  }

  /**
   * Robustly parses a JSON object from a text response.
   * Handles markdown code blocks (```json ... ```) and leading/trailing whitespace.
   *
   * @private
   * @param {string} text - The raw text response from the model.
   * @returns {object} The parsed JSON object.
   * @throws {Error} If no valid JSON structure is found or parsing fails.
   */
  _parseJsonFromText(text) {
    if (!text) {
      throw new Error("Empty text response");
    }

    let cleaned = text.trim();

    // Strip markdown code block wrappers if present
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, '');
      cleaned = cleaned.replace(/\s*```$/, '');
    }

    cleaned = cleaned.trim();

    // Find first '{' and last '}' to isolate the JSON object if there is surrounding text
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      cleaned = cleaned.substring(firstBrace, lastBrace + 1);
    }

    try {
      return JSON.parse(cleaned);
    } catch (e) {
      // Natural language boolean fallback for direct conversational answers across all
      // Homey Pro supported languages (en, it, nl, de, fr, es, sv, da, no, pl).
      const firstWord = cleaned.toLowerCase().trim().replace(/[.,!?;:]+$/, '').split(/\s+/)[0];
      const positiveWords = new Set([
        'si', 'sì', 'yes', 'true', 'vero',      // it, en
        'ja', 'waar', 'wahr',                   // nl, de, sv, da, no
        'oui', 'vrai',                          // fr
        'sí', 'verdadero',                      // es
        'sant', 'sandt',                        // sv, da, no
        'tak', 'prawda'                         // pl
      ]);
      const negativeWords = new Set([
        'no', 'false', 'falso',                 // it, en, es
        'nee', 'niet',                          // nl
        'nein', 'falsch',                       // de
        'non', 'faux',                          // fr
        'nei', 'falsk',                         // sv, da, no
        'nie', 'fałsz'                          // pl
      ]);

      if (positiveWords.has(firstWord)) {
        console.log(`[GeminiClient:_parseJsonFromText] Resolved plain text positive answer "${text}" to boolean true`);
        return { isAnswerable: true, result: true, explanation: cleaned };
      }
      if (negativeWords.has(firstWord)) {
        console.log(`[GeminiClient:_parseJsonFromText] Resolved plain text negative answer "${text}" to boolean false`);
        return { isAnswerable: true, result: false, explanation: cleaned };
      }

      console.error(`[GeminiClient:_parseJsonFromText] Failed to parse JSON from: "${text}"`);
      throw new Error(`Invalid JSON response: ${e.message}`);
    }
  }

  // ── Public Methods ───────────────────────────────────────────────────────────

  /**
   * Clears the entire conversation history and resets server-side interaction tracking.
   * Can be called externally to reset the conversation context.
   *
   * @public
   * @returns {void}
   * @example
   * geminiClient.clearConversationHistory();
   */
  clearConversationHistory() {
    const count = this.conversationHistory.length;
    this.conversationHistory = [];
    this._lastInteractionId = null;
    this._seededContext = null;
    this.activeConversationModel = this.shGenericModel;
    this._emitHistoryCleared();
    console.log(`[GeminiClient:clearConversationHistory] Conversation history cleared (${count} entries removed)`);
  }

  /**
   * Emits the 'widget_history_cleared' event on the Homey app so that
   * any active widget instances can react and clear their UI.
   *
   * @private
   * @returns {void}
   */
  _emitHistoryCleared() {
    try {
      if (this.homey && typeof this.homey.app?.emit === 'function') {
        this.homey.app.emit('widget_history_cleared');
      }
    } catch (err) {
      console.warn('[GeminiClient:_emitHistoryCleared] Could not emit widget_history_cleared:', err.message);
    }
  }

  /**
   * Seeds the conversation history with a context message injected as a 'model' turn,
   * and buffers it so that the next command receives it directly in its prompt.
   *
   * @public
   * @param {string} contextMessage - The context message to inject.
   * @returns {void}
   * @example
   * geminiClient.seedConversationContext('The front door sensor just triggered.');
   */
  seedConversationContext(contextMessage) {
    if (!contextMessage || typeof contextMessage !== 'string') {
      console.warn('[GeminiClient:seedConversationContext] Called with invalid message');
      return;
    }

    const trimmed = contextMessage.trim();
    if (!trimmed) {
      return;
    }

    const lastEntry = this.conversationHistory[this.conversationHistory.length - 1];
    const lastRole = lastEntry?.content?.role;

    if (lastRole === 'user') {
      this._addToConversationHistory({
        role: 'model',
        parts: [{ text: trimmed }]
      });
    } else {
      this._addToConversationHistory({
        role: 'user',
        parts: [{ text: '[context]' }]
      });
      this._addToConversationHistory({
        role: 'model',
        parts: [{ text: trimmed }]
      });
    }

    // Buffer seeded context so it is prepended into the very next interaction turn
    this._seededContext = this._seededContext
      ? `${this._seededContext}\n${trimmed}`
      : trimmed;

    console.log(`[GeminiClient:seedConversationContext] Conversation context seeded (${this.conversationHistory.length} total messages)`);
  }

  /**
   * Generates a text response from a simple text prompt using the Interactions API.
   *
   * @public
   * @param {string} prompt - The text prompt to send to the model.
   * @returns {Promise<string>} The generated text response.
   * @throws {Error} If the API call fails after the configured retries.
   * @example
   * const text = await geminiClient.generateText('What is the capital of France?');
   * // 'Paris is the capital of France.'
   */
  async generateText(prompt) {
    console.log('[GeminiClient:generateText] prompt:', prompt);

    return this._retryableRequest(async () => {
      const tools = this.enableGoogleSearch ? [{ type: 'google_search' }] : undefined;
      const generationConfig = this._buildGenerationConfig(this.chatModel);

      let inputPrompt = prompt;
      if (this._seededContext) {
        inputPrompt = `[Context Information: ${this._seededContext}]\n\n${inputPrompt}`;
        this._seededContext = null;
      }

      const interaction = await this.genAI.interactions.create({
        model: this.chatModel,
        input: inputPrompt,
        system_instruction: this.customInstructions || undefined,
        tools: tools,
        generation_config: generationConfig
      });

      this._logTokenUsage('generateText', interaction.usage);
      return this._extractOutputText(interaction);
    }, 'generateText');
  }

  /**
   * Generates a text response from a multimodal prompt (text + image) using the Interactions API.
   * The image is converted to Base64 and sent inline.
   *
   * @public
   * @param {string} textPrompt - The text prompt to send alongside the image.
   * @param {Buffer} imageBuffer - The image data as a Node.js Buffer.
   * @param {string} [mimeType='image/jpeg'] - The MIME type of the image.
   * @returns {Promise<string>} The generated text response.
   * @throws {Error} If the API call fails after the configured retries.
   * @example
   * const fs = require('fs');
   * const imgBuffer = fs.readFileSync('./photo.jpg');
   * const description = await geminiClient.generateTextWithImage('What is in this photo?', imgBuffer);
   */
  async generateTextWithImage(textPrompt, imageBuffer, mimeType = 'image/jpeg') {
    console.log('[GeminiClient:generateTextWithImage] prompt:', textPrompt);
    console.log(`[GeminiClient:generateTextWithImage] Image buffer size: ${imageBuffer.length} bytes, mimeType: ${mimeType}`);

    const base64Image = imageBuffer.toString('base64');

    return this._retryableRequest(async () => {
      const tools = this.enableGoogleSearch ? [{ type: 'google_search' }] : undefined;
      const generationConfig = this._buildGenerationConfig(this.chatModel);

      let inputPrompt = textPrompt;
      if (this._seededContext) {
        inputPrompt = `[Context Information: ${this._seededContext}]\n\n${inputPrompt}`;
        this._seededContext = null;
      }

      const input = [
        {
          type: 'image',
          data: base64Image,
          mime_type: mimeType
        },
        {
          type: 'text',
          text: inputPrompt
        }
      ];

      const interaction = await this.genAI.interactions.create({
        model: this.chatModel,
        input: input,
        system_instruction: this.customInstructions || undefined,
        tools: tools,
        generation_config: generationConfig
      });

      this._logTokenUsage('generateTextWithImage', interaction.usage);
      return this._extractOutputText(interaction);
    }, 'generateTextWithImage');
  }


  /**
   * Converts a Readable stream to a Buffer by collecting all emitted chunks.
   *
   * @public
   * @static
   * @param {import('stream').Readable} stream - The readable stream to consume.
   * @returns {Promise<Buffer>} A Buffer containing all data from the stream.
   * @throws {Error} If the stream emits an error event.
   * @example
   * const buffer = await GeminiClient.streamToBuffer(readableStream);
   */
  static async streamToBuffer(stream) {
    const chunks = [];
    return new Promise((resolve, reject) => {
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', (err) => reject(err));
    });
  }

  /**
   * Generates an image from a text prompt using the Gemini image generation model.
   * Requires a paid API tier.
   *
   * @public
   * @param {string} prompt - A detailed description of the image to generate.
   * @returns {Promise<string>} The Base64-encoded string of the generated image data.
   * @throws {Error} If the API returns no candidates, no image part, or no image data.
   * @example
   * const base64 = await geminiClient.generateImage('A sunset over the Dolomites, oil painting style');
   */
  async generateImage(prompt) {
    console.log('[GeminiClient:generateImage] prompt:', prompt);

    try {
      // Use the dedicated image generation model (requires paid tier)
      const response = await this._retryableRequest(async () => {
        return await this.genAI.models.generateContent({
          model: GEMINI_IMAGE_MODEL,
          contents: prompt,
        });
      }, 'generateImage');

      // Extract the image from the response.
      // Parts can be text or inlineData (images).
      if (!response.candidates || response.candidates.length === 0) {
        throw new Error("No candidates in Gemini response");
      }

      const parts = response.candidates[0].content.parts;

      // Find the image part (inlineData)
      const imagePart = parts.find(part => part.inlineData);

      if (!imagePart) {
        throw new Error("No image generated by Gemini");
      }

      const base64ImageBytes = imagePart.inlineData.data;

      if (!base64ImageBytes) {
        throw new Error("No image data in response");
      }

      console.log('[GeminiClient:generateImage] Image generated successfully, bytes length:', base64ImageBytes.length);

      // Return the Base64 string
      return base64ImageBytes;
    } catch (error) {
      console.error('[GeminiClient:generateImage] Error generating image:', error);
      throw error;
    }
  }

  /**
   * Generates an image from a text prompt and returns it as a Readable stream.
   * Internally calls {@link GeminiClient#generateImage} and wraps the result in a stream.
   *
   * @public
   * @param {string} prompt - A detailed description of the image to generate.
   * @returns {Promise<import('stream').Readable>} A Readable stream of the generated image bytes.
   * @throws {Error} If image generation fails (propagated from {@link GeminiClient#generateImage}).
   * @example
   * const stream = await geminiClient.generateImageStream('A futuristic smart home interior');
   * stream.pipe(res); // pipe to HTTP response
   */
  async generateImageStream(prompt) {
    console.log('[GeminiClient:generateImageStream] prompt:', prompt);
    const base64Image = await this.generateImage(prompt);
    return Readable.from(Buffer.from(base64Image, 'base64'));
  }

  /**
   * Determines whether a batch of function calls must be executed sequentially.
   *
   * A batch requires sequential execution when it contains a mix of state-mutating
   * tools ({@link STATE_MUTATING_TOOLS}) and state-reading tools
   * ({@link SEQUENTIAL_REQUIRED_TOOLS}). In such cases, running them in parallel
   * would cause the reading tool to observe stale state (race condition).
   *
   * Batches containing only mutations (e.g., two `control_device`) or only reads
   * are safe to run in parallel, as no state dependency exists between them.
   *
   * @private
   * @param {import('@google/genai').FunctionCall[]} functionCalls - Array of function calls from Gemini.
   * @returns {boolean} `true` if the batch must run sequentially, `false` if parallel is safe.
   * @example
   * // Mixed batch → sequential
   * this._shouldExecuteSequentially([
   *   { name: 'control_device', args: {} },
   *   { name: 'get_home_summary', args: {} }
   * ]); // → true
   *
   * // Homogeneous batch → parallel
   * this._shouldExecuteSequentially([
   *   { name: 'control_device', args: {} },
   *   { name: 'control_device', args: {} }
   * ]); // → false
   */
  _shouldExecuteSequentially(functionCalls) {
    const hasMutation = functionCalls.some(c => STATE_MUTATING_TOOLS.has(c.name));
    const hasStateRead = functionCalls.some(c => SEQUENTIAL_REQUIRED_TOOLS.has(c.name));
    return hasMutation && hasStateRead;
  }

  /**
   * Executes a single MCP function call and returns a normalised result object.
   *
   * Handles timer ID capture for `schedule_command`, multimodal image responses,
   * and exception wrapping so callers always receive a consistent structure.
   *
   * @private
   * @param {import('@google/genai').FunctionCall} call - The function call descriptor from Gemini.
   * @returns {Promise<{call: import('@google/genai').FunctionCall, result: object, success: boolean}>}
   *   Resolved promise with the raw result and a success flag.
   * @example
   * const { call, result, success } = await this._executeSingleFunctionCall(
   *   { name: 'control_device', args: { deviceName: 'Luce Studio', capability: 'onoff', value: false } }
   * );
   */
  async _executeSingleFunctionCall(call) {
    console.log(`[GeminiClient:_executeSingleFunctionCall] Calling ${call.name}(${JSON.stringify(call.args)})`);

    try {
      // Create a copy of args and strip gemini_model to avoid leaking it to the Homey API
      const toolArgs = { ...call.args };
      delete toolArgs.gemini_model;

      const result = await this.mcpAdapter.callTool(call.name, toolArgs);

      // Create a safe version for logging (exclude large image data)
      const logResult = { ...result };
      if (logResult._imageData) {
        delete logResult._imageData;
        logResult._hasImage = true;
      }
      console.log(`[GeminiClient:_executeSingleFunctionCall] ${result.success ? 'OK' : 'FAIL'} ${call.name}: ${JSON.stringify(logResult)}`);

      return { call, result, success: result.success === true };
    } catch (error) {
      // Best practice: Return informative error messages to the model
      console.error(`[GeminiClient:_executeSingleFunctionCall] Exception in ${call.name}: ${error.message}`);
      return {
        call,
        result: {
          success: false,
          error: `Function execution failed: ${error.message}`,
          stack: error.stack
        },
        success: false
      };
    }
  }

  /**
   * Generates a response with MCP (Model Context Protocol) function calling support,
   * running a multi-turn loop until Gemini produces a final conversational answer.
   *
   * In AUTO mode, Gemini decides whether to call tools or respond conversationally.
   * If Gemini exceeds {@link MAX_TURNS} tool-call turns, a give-up message is sent
   * with tools disabled (NONE mode) to force a natural-language conclusion.
   * Conversation history is persisted across calls for multi-turn context.
   *
   * @public
   * @param {string} prompt - The user command or natural-language request.
   * @param {Object} [options={}] - Additional options for the request.
   * @param {boolean} [options.isScheduled=false] - Whether this command is being executed from a schedule.
   * @param {string} [options.createdAt] - ISO timestamp string of when the scheduled command was created.
   * @returns {Promise<{response: string, success: boolean, timerId: string|null}>}
   *   Object containing the final text response, a success flag (`false` on errors or give-up),
   *   and an optional `timerId` if `schedule_command` was called during the session.
   * @throws {Error} If the MCP adapter is not available (Homey instance not provided in constructor).
   * @example
   * const { response, success } = await geminiClient.generateTextWithMCP('Turn on the kitchen lights');
   */
  async generateTextWithMCP(prompt, options = {}) {
    if (!this.mcpAdapter) {
      throw new Error('MCP Adapter not available. Homey instance is required.');
    }

    console.log(`[GeminiClient:generateTextWithMCP] User command: "${prompt}"`);

    // Build dynamic context prefix (date/time, timezone, language).
    const ctx = SystemInstruction._buildDateTimeContext(this.homey);
    const dynamicPrefix = SystemInstruction.buildDynamicPrefix(ctx, options);

    console.log('[GeminiClient:generateTextWithMCP] System Instruction Date/Time Context:');
    console.log(`[GeminiClient:generateTextWithMCP]   Local: ${ctx.localDateTime} (${ctx.userTimezone})`);
    console.log(`[GeminiClient:generateTextWithMCP]   Offset: UTC${ctx.timezoneOffset}`);
    console.log(`[GeminiClient:generateTextWithMCP]   Language: ${ctx.homeyLanguage}`);

    // Prune old messages from conversation history (idle timeout / max messages / token limits)
    this._pruneConversationHistory();

    // Start with the active conversation model (defaults to shGenericModel)
    let currentModel = this.activeConversationModel || this.shGenericModel;
    let flowToolUsedInSession = false;
    let turnCount = 0;
    let capturedTimerId = null;

    let promptWithContext = `${dynamicPrefix}\n${prompt}`;
    if (this._seededContext) {
      promptWithContext = `[Context Information: ${this._seededContext}]\n\n${promptWithContext}`;
      this._seededContext = null;
    }
    const initialTools = getInteractionTools({
      modelName: currentModel,
      enableGoogleSearch: this.enableGoogleSearch
    });
    const staticInstruction = SystemInstruction.buildStatic(this.customInstructions, this.shGenericModel, this.shFlowModel);

    // Initial interaction turn
    console.log(`[GeminiClient:generateTextWithMCP] Turn 1: Sending user message using model ${currentModel}`);
    let interaction = await this._retryableRequest(async () => {
      return await this.genAI.interactions.create({
        model: currentModel,
        input: promptWithContext,
        previous_interaction_id: this._lastInteractionId || undefined,
        system_instruction: staticInstruction,
        tools: initialTools,
        generation_config: this._buildGenerationConfig(currentModel),
        store: true
      });
    }, 'generateTextWithMCP (turn 1)');

    this._logTokenUsage('generateTextWithMCP (turn 1)', interaction.usage);

    // Multi-turn function calling loop
    while (turnCount < MAX_TURNS) {
      turnCount++;

      const functionCalls = this._extractFunctionCalls(interaction);

      if (functionCalls.length > 0) {
        // Check if any tool requires flow model escalation
        const usesFlowTools = functionCalls.some(call =>
          call.args?.gemini_model === this.shFlowModel ||
          call.name === 'manage_flow' ||
          call.name === 'manage_advanced_flow'
        );

        if (usesFlowTools && currentModel !== this.shFlowModel) {
          console.log(`[GeminiClient:generateTextWithMCP] Escalating model from ${currentModel} to ${this.shFlowModel} for flow automation tools`);
          currentModel = this.shFlowModel;
          flowToolUsedInSession = true;
        }

        // Execute function calls using smart parallel/sequential dispatch
        console.log(`[GeminiClient:generateTextWithMCP] Executing ${functionCalls.length} function call(s) for turn ${turnCount}`);

        let executedFunctions;
        if (functionCalls.length > 1 && this._shouldExecuteSequentially(functionCalls)) {
          console.log(`[GeminiClient:generateTextWithMCP] Sequential execution: ${functionCalls.length} functions (mixed mutation+query batch)`);
          executedFunctions = [];
          for (const call of functionCalls) {
            executedFunctions.push(await this._executeSingleFunctionCall(call));
          }
        } else {
          if (functionCalls.length > 1) {
            console.log(`[GeminiClient:generateTextWithMCP] Parallel execution: ${functionCalls.length} functions`);
          }
          executedFunctions = await Promise.all(
            functionCalls.map(call => this._executeSingleFunctionCall(call))
          );
        }

        // Process results and construct function_result steps for the next turn
        const functionResultSteps = [];
        for (const { call, result, success } of executedFunctions) {
          if (success && (call.name === 'manage_schedule' || call.name === 'schedule_command') && result.scheduleId) {
            capturedTimerId = result.scheduleId;
            console.log(`[GeminiClient:generateTextWithMCP] Captured timer ID: ${capturedTimerId}`);
          }

          if (success && result._hasImage && result._imageData && result._imageMimeType) {
            console.log('[GeminiClient:generateTextWithMCP] Multimodal function response with image attached');
            const cleanResult = { ...result };
            const imageBase64 = cleanResult._imageData;
            const mimeType = cleanResult._imageMimeType;
            delete cleanResult._imageData;
            delete cleanResult._imageMimeType;
            delete cleanResult._hasImage;
            cleanResult.image_info = 'Image attached for visual analysis';

            functionResultSteps.push({
              type: 'function_result',
              name: call.name,
              call_id: call.id,
              result: [
                { type: 'text', text: JSON.stringify(cleanResult) },
                { type: 'image', mime_type: mimeType, data: imageBase64 }
              ]
            });
          } else {
            functionResultSteps.push({
              type: 'function_result',
              name: call.name,
              call_id: call.id,
              result: JSON.stringify(result)
            });
          }
        }

        // Max turns safeguard: force conclusion if threshold reached
        if (turnCount >= MAX_TURNS) {
          console.log(`[GeminiClient:generateTextWithMCP] Maximum tool turns (${MAX_TURNS}) reached. Sending give-up turn to model.`);
          const giveUpTools = getInteractionTools({ modelName: currentModel, enableGoogleSearch: this.enableGoogleSearch });

          try {
            const giveUpInteraction = await this._retryableRequest(async () => {
              return await this.genAI.interactions.create({
                model: currentModel,
                previous_interaction_id: interaction.id,
                input: functionResultSteps,
                tools: giveUpTools,
                generation_config: this._buildGenerationConfig(currentModel, { toolChoice: 'none' }),
                store: true
              });
            }, 'generateTextWithMCP (give-up turn)');

            this._logTokenUsage('generateTextWithMCP (give-up turn)', giveUpInteraction.usage);
            const finalText = this._extractOutputText(giveUpInteraction) || this.homey.__('prompt.error.max_turns_reached');

            // Sync user and model turns to persistent history for widget and multi-turn exposition
            this._addToConversationHistory({ role: 'user', parts: [{ text: promptWithContext }] });
            this._addToConversationHistory({ role: 'model', parts: [{ text: finalText }] });
            this._lastInteractionId = giveUpInteraction.id;

            return {
              response: finalText,
              success: false,
              timerId: capturedTimerId
            };
          } catch (giveUpErr) {
            console.error('[GeminiClient:generateTextWithMCP] Give-up turn failed:', giveUpErr.message);
            this.clearConversationHistory();
            return {
              response: this.homey.__('prompt.error.max_turns_reached'),
              success: false,
              timerId: capturedTimerId
            };
          }
        }

        // Send function results to the model to receive the next step
        const nextTools = getInteractionTools({
          modelName: currentModel,
          enableGoogleSearch: this.enableGoogleSearch
        });

        console.log(`[GeminiClient:generateTextWithMCP] Sending ${functionResultSteps.length} function result(s) for turn ${turnCount + 1}`);
        interaction = await this._retryableRequest(async () => {
          return await this.genAI.interactions.create({
            model: currentModel,
            previous_interaction_id: interaction.id,
            input: functionResultSteps,
            tools: nextTools,
            generation_config: this._buildGenerationConfig(currentModel),
            store: true
          });
        }, `generateTextWithMCP (turn ${turnCount + 1})`);

        this._logTokenUsage(`generateTextWithMCP (turn ${turnCount + 1})`, interaction.usage);
        continue;
      }

      // No function calls — conversational response produced
      console.log(`[GeminiClient:generateTextWithMCP] Conversational response generated after ${turnCount} turn(s)`);
      const finalResponse = this._extractOutputText(interaction) || 'Operation completed successfully.';

      // Model downgrade check for subsequent sessions if no flow tools were used
      if (!flowToolUsedInSession && currentModel === this.shFlowModel && this.shFlowModel !== this.shGenericModel) {
        console.log(`[GeminiClient:generateTextWithMCP] Downgrading active conversation model to ${this.shGenericModel}`);
        this.activeConversationModel = this.shGenericModel;
      } else {
        this.activeConversationModel = currentModel;
      }

      // Record final turns in conversation history for widget and local context tracking
      this._addToConversationHistory({ role: 'user', parts: [{ text: promptWithContext }] });
      this._addToConversationHistory({ role: 'model', parts: [{ text: finalResponse }] });
      this._lastInteractionId = interaction.id;

      return {
        response: finalResponse,
        success: Boolean(finalResponse && finalResponse.length > 0),
        timerId: capturedTimerId
      };
    }

    // Safety fallback
    console.warn(`[GeminiClient:generateTextWithMCP] Exited loop unexpectedly at turn ${turnCount}`);
    this.clearConversationHistory();
    return {
      response: this.homey.__('prompt.error.max_turns_reached'),
      success: false,
      timerId: capturedTimerId
    };
  }


  // ── Condition Card Methods ──────────────────────────────────────────────────

  /**
   * Evaluates a plain-text yes/no question using the Conversational AI model via Interactions API.
   *
   * Uses structured output with JSON schema to enforce binary evaluation:
   * `{ isAnswerable: boolean, result: boolean, explanation: string }`.
   *
   * If the question cannot be answered with a definitive yes or no (e.g. it is
   * subjective, open-ended or ambiguous), Gemini will set `isAnswerable` to
   * `false` and populate `explanation` with a human-readable reason.
   *
   * **This method does NOT interact with the persistent conversation history.**
   *
   * @public
   * @param {string} prompt - The yes/no question to evaluate.
   * @returns {Promise<{ isAnswerable: boolean, result: boolean, explanation: string }>}
   *   The structured evaluation result from Gemini.
   * @throws {Error} If the API call fails or the response cannot be parsed.
   * @example
   * const result = await geminiClient.evaluateCondition('Is today a weekend?');
   * // { isAnswerable: true, result: true, explanation: 'Today is Saturday.' }
   */
  async evaluateCondition(prompt) {
    console.log('[GeminiClient:evaluateCondition] prompt:', prompt);

    const systemInstruction =
      'You are a strict binary condition evaluator for home automation flow logic.\n' +
      'Your ONLY objective is to determine if a condition or question resolves strictly to YES (true) or NO (false).\n\n' +
      'CRITICAL EVALUATION RULES:\n' +
      '1. POLAR CONDITIONS ONLY: A prompt is answerable (isAnswerable: true) ONLY if it is a binary yes/no question or a factual true/false statement (e.g. "Is it raining?", "Paris is the capital of France", "Is the door closed?").\n' +
      '2. REJECT OPEN-ENDED & INFORMATIONAL QUESTIONS: Any question asking for information, values, or explanations (such as questions asking "What", "What time", "Where", "When", "Who", "Why", "How", "Which", "Che ore", "Cosa", "Chi", "Dove", "Quando", "Perché", "Come", "Quanto", "Quale") CANNOT be answered with YES or NO. For these questions, you MUST set isAnswerable to false and result to false.\n' +
      '3. REJECT AMBIGUOUS, SUBJECTIVE, OR IMPERATIVE PROMPTS: If the prompt is subjective ("Is pizza good?"), ambiguous, or an action command ("Turn off lights"), set isAnswerable to false and result to false.\n' +
      '4. If isAnswerable is false, explain briefly in the "explanation" field (in the prompt\'s language) why the prompt cannot be answered with yes/no (e.g. "La domanda richiede un orario e non può essere valutata con un sì o un no").\n' +
      '5. If isAnswerable is true, set result to true (for YES) or false (for NO) and explain briefly in the "explanation" field.\n\n' +
      'You MUST return ONLY a JSON object conforming to the schema: {"isAnswerable": boolean, "result": boolean, "explanation": string}.';

    return this._retryableRequest(async () => {
      const tools = this.enableGoogleSearch ? [{ type: 'google_search' }] : undefined;
      const generationConfig = this._buildGenerationConfig(this.chatModel);

      let inputPrompt = prompt;
      if (this._seededContext) {
        inputPrompt = `[Context Information: ${this._seededContext}]\n\n${inputPrompt}`;
        this._seededContext = null;
      }

      const interaction = await this.genAI.interactions.create({
        model: this.chatModel,
        input: inputPrompt,
        system_instruction: systemInstruction,
        tools: tools,
        response_format: {
          type: 'text',
          mime_type: 'application/json',
          schema: CONDITION_RESPONSE_SCHEMA
        },
        generation_config: generationConfig
      });

      this._logTokenUsage('evaluateCondition', interaction.usage);

      const text = this._extractOutputText(interaction);
      const parsed = this._parseJsonFromText(text);
      console.log(`[GeminiClient:evaluateCondition] result: isAnswerable=${parsed.isAnswerable}, result=${parsed.result}`);
      return parsed;
    }, 'evaluateCondition');
  }

  /**
   * Evaluates a yes/no question about an image using the Conversational AI model via Interactions API.
   *
   * Sends both the image (as inline Base64 data) and the text prompt to the model,
   * enforcing a structured output conforming to the condition schema:
   * `{ isAnswerable: boolean, result: boolean, explanation: string }`.
   *
   * **This method does NOT interact with the persistent conversation history.**
   *
   * @public
   * @param {string} prompt - The yes/no question about the image.
   * @param {Buffer} imageBuffer - The image data as a Node.js Buffer.
   * @param {string} [mimeType='image/jpeg'] - The MIME type of the image.
   * @returns {Promise<{ isAnswerable: boolean, result: boolean, explanation: string }>}
   *   The structured evaluation result from Gemini.
   * @throws {Error} If the API call fails or the response cannot be parsed.
   * @example
   * const result = await geminiClient.evaluateConditionWithImage(
   *   'Is there a person in this image?', imgBuffer, 'image/jpeg'
   * );
   * // { isAnswerable: true, result: false, explanation: 'No person is visible in the image.' }
   */
  async evaluateConditionWithImage(prompt, imageBuffer, mimeType = 'image/jpeg') {
    console.log('[GeminiClient:evaluateConditionWithImage] prompt:', prompt);
    console.log(`[GeminiClient:evaluateConditionWithImage] image size: ${imageBuffer.length} bytes, mimeType: ${mimeType}`);

    const base64Image = imageBuffer.toString('base64');

    const systemInstruction =
      'You are a strict binary condition evaluator for image-based home automation flow logic.\n' +
      'Your ONLY objective is to determine if a condition or question about the provided image resolves strictly to YES (true) or NO (false).\n\n' +
      'CRITICAL EVALUATION RULES:\n' +
      '1. POLAR CONDITIONS ONLY: A prompt is answerable (isAnswerable: true) ONLY if it is a binary yes/no question or a factual true/false statement about the image (e.g. "Is there a person in the room?", "Is the car red?").\n' +
      '2. REJECT OPEN-ENDED & INFORMATIONAL QUESTIONS: Any question asking for descriptions, counts, or open information (such as questions asking "What", "What color", "Where", "Who", "How many", "Which", "Cosa", "Che colore", "Chi", "Dove", "Quanti", "Quale") CANNOT be answered with YES or NO. For these questions, you MUST set isAnswerable to false and result to false.\n' +
      '3. REJECT AMBIGUOUS OR SUBJECTIVE PROMPTS: If the prompt is subjective, ambiguous, or cannot be determined from the image, set isAnswerable to false and result to false.\n' +
      '4. If isAnswerable is false, explain briefly in the "explanation" field (in the prompt\'s language) why the prompt cannot be answered with yes/no from the image.\n' +
      '5. If isAnswerable is true, set result to true (for YES) or false (for NO) and explain briefly in the "explanation" field.\n\n' +
      'You MUST return ONLY a JSON object conforming to the schema: {"isAnswerable": boolean, "result": boolean, "explanation": string}.';

    return this._retryableRequest(async () => {
      const tools = this.enableGoogleSearch ? [{ type: 'google_search' }] : undefined;
      const generationConfig = this._buildGenerationConfig(this.chatModel);

      let inputPrompt = prompt;
      if (this._seededContext) {
        inputPrompt = `[Context Information: ${this._seededContext}]\n\n${inputPrompt}`;
        this._seededContext = null;
      }

      const input = [
        {
          type: 'image',
          data: base64Image,
          mime_type: mimeType
        },
        {
          type: 'text',
          text: inputPrompt
        }
      ];

      const interaction = await this.genAI.interactions.create({
        model: this.chatModel,
        input: input,
        system_instruction: systemInstruction,
        tools: tools,
        response_format: {
          type: 'text',
          mime_type: 'application/json',
          schema: CONDITION_RESPONSE_SCHEMA
        },
        generation_config: generationConfig
      });

      this._logTokenUsage('evaluateConditionWithImage', interaction.usage);

      const text = this._extractOutputText(interaction);
      const parsed = this._parseJsonFromText(text);
      console.log(`[GeminiClient:evaluateConditionWithImage] result: isAnswerable=${parsed.isAnswerable}, result=${parsed.result}`);
      return parsed;
    }, 'evaluateConditionWithImage');
  }

  /**
   * Evaluates a yes/no question that may require inspecting the smart home state
   * via the MCP tool-calling loop using the Smart Home model (`shGenericModel`).
   *
   * The method executes the MCP tool-calling loop using the Interactions API,
   * then performs a final closing turn with structured JSON schema output to
   * produce the binary condition result:
   * `{ isAnswerable: boolean, result: boolean, explanation: string }`.
   *
   * @public
   * @param {string} prompt - The yes/no question to evaluate using smart home data.
   * @returns {Promise<{ isAnswerable: boolean, result: boolean, explanation: string }>}
   *   The structured evaluation result from Gemini.
   * @throws {Error} If the MCP adapter is not available or the API call fails.
   * @example
   * const result = await geminiClient.evaluateConditionWithMCP('Is any light on in the bedroom?');
   * // { isAnswerable: true, result: true, explanation: 'The bedside lamp is on.' }
   */
  async evaluateConditionWithMCP(prompt) {
    if (!this.mcpAdapter) {
      throw new Error('MCP Adapter not available. Homey instance is required.');
    }

    console.log(`[GeminiClient:evaluateConditionWithMCP] Evaluating condition: "${prompt}"`);

    const ctx = SystemInstruction._buildDateTimeContext(this.homey);
    const dynamicPrefix = SystemInstruction.buildDynamicPrefix(ctx);

    this._pruneConversationHistory();

    const currentModel = this.shGenericModel;
    const conditionHint =
      '[CONDITION EVALUATION: The user is evaluating a binary condition for a Homey Flow. ' +
      'If the prompt is an open-ended question (e.g. asking what, who, where, when, what time, how), a command, or not answerable with a binary YES or NO, ' +
      'state that the condition cannot be evaluated with a yes/no. ' +
      'Use your tools if needed to gather device or room status, then answer. ' +
      'You will formalise your final answer into a JSON condition object in the next turn.]';
    let promptWithContext = `${dynamicPrefix}\n${conditionHint}\n${prompt}`;
    if (this._seededContext) {
      promptWithContext = `[Context Information: ${this._seededContext}]\n\n${promptWithContext}`;
      this._seededContext = null;
    }

    const tools = getInteractionTools({
      modelName: currentModel,
      enableGoogleSearch: this.enableGoogleSearch
    });
    const staticInstruction = SystemInstruction.buildStatic(this.customInstructions, this.shGenericModel, this.shFlowModel);

    let turnCount = 0;

    console.log(`[GeminiClient:evaluateConditionWithMCP] Turn 1: Sending condition prompt to ${currentModel}`);
    let interaction = await this._retryableRequest(async () => {
      return await this.genAI.interactions.create({
        model: currentModel,
        input: promptWithContext,
        previous_interaction_id: this._lastInteractionId || undefined,
        system_instruction: staticInstruction,
        tools: tools,
        generation_config: this._buildGenerationConfig(currentModel),
        store: true
      });
    }, 'evaluateConditionWithMCP (turn 1)');

    this._logTokenUsage('evaluateConditionWithMCP (turn 1)', interaction.usage);

    // MCP tool-calling loop (capped at MAX_TURNS)
    while (turnCount < MAX_TURNS) {
      turnCount++;

      const functionCalls = this._extractFunctionCalls(interaction);
      if (functionCalls.length === 0) {
        console.log(`[GeminiClient:evaluateConditionWithMCP] Natural-language conclusion reached after ${turnCount} turn(s)`);
        break;
      }

      console.log(`[GeminiClient:evaluateConditionWithMCP] Executing ${functionCalls.length} function(s) for turn ${turnCount}`);

      let executedFunctions;
      if (functionCalls.length > 1 && this._shouldExecuteSequentially(functionCalls)) {
        executedFunctions = [];
        for (const call of functionCalls) {
          executedFunctions.push(await this._executeSingleFunctionCall(call));
        }
      } else {
        executedFunctions = await Promise.all(
          functionCalls.map(call => this._executeSingleFunctionCall(call))
        );
      }

      const functionResultSteps = executedFunctions.map(({ call, result }) => ({
        type: 'function_result',
        name: call.name,
        call_id: call.id,
        result: JSON.stringify(result)
      }));

      if (turnCount >= MAX_TURNS) {
        console.log('[GeminiClient:evaluateConditionWithMCP] Max turns reached, proceeding to JSON evaluation turn');
        interaction = await this._retryableRequest(async () => {
          return await this.genAI.interactions.create({
            model: currentModel,
            previous_interaction_id: interaction.id,
            input: functionResultSteps,
            generation_config: this._buildGenerationConfig(currentModel, { toolChoice: 'none' }),
            store: true
          });
        }, 'evaluateConditionWithMCP (final tool response)');
        this._logTokenUsage('evaluateConditionWithMCP (final tool response)', interaction.usage);
        break;
      }

      interaction = await this._retryableRequest(async () => {
        return await this.genAI.interactions.create({
          model: currentModel,
          previous_interaction_id: interaction.id,
          input: functionResultSteps,
          tools: tools,
          generation_config: this._buildGenerationConfig(currentModel),
          store: true
        });
      }, `evaluateConditionWithMCP (turn ${turnCount + 1})`);

      this._logTokenUsage(`evaluateConditionWithMCP (turn ${turnCount + 1})`, interaction.usage);
    }

    // Closing turn: ask model to formalise conclusion into structured JSON schema
    const formaliseMessage =
      '[SYSTEM: Based on your analysis above, provide your final answer as a JSON object.\n' +
      'EVALUATION CRITERIA:\n' +
      '- Set isAnswerable to true ONLY if the question is a polar yes/no question or factual condition that evaluates to a definitive YES (result: true) or NO (result: false).\n' +
      '- Set isAnswerable to false if the prompt was an open-ended question (e.g. asking what, who, where, when, what time, how, which), subjective, a command, or unanswerable with a binary yes/no. In this case set result to false.\n' +
      '- Always fill the explanation field with a brief reason in the same language as the original question.\n' +
      '- Do NOT call any tool. Respond ONLY with the JSON object conforming to the schema.]';

    const jsonInteraction = await this._retryableRequest(async () => {
      return await this.genAI.interactions.create({
        model: currentModel,
        previous_interaction_id: interaction.id,
        input: formaliseMessage,
        response_format: {
          type: 'text',
          mime_type: 'application/json',
          schema: CONDITION_RESPONSE_SCHEMA
        },
        generation_config: this._buildGenerationConfig(currentModel, { toolChoice: 'none' }),
        store: true
      });
    }, 'evaluateConditionWithMCP (json turn)');

    this._logTokenUsage('evaluateConditionWithMCP (json turn)', jsonInteraction.usage);

    // Save turns in conversation history marked as condition
    this._addToConversationHistory({ role: 'user', parts: [{ text: promptWithContext }] });
    const rawJsonText = this._extractOutputText(jsonInteraction);
    this._addToConversationHistory({ role: 'model', parts: [{ text: rawJsonText }] });
    if (this.conversationHistory.length >= 2) {
      this.conversationHistory[this.conversationHistory.length - 1].isCondition = true;
      this.conversationHistory[this.conversationHistory.length - 2].isCondition = true;
    }
    this._lastInteractionId = jsonInteraction.id;

    const parsed = this._parseJsonFromText(rawJsonText);
    console.log(`[GeminiClient:evaluateConditionWithMCP] Result: isAnswerable=${parsed.isAnswerable}, result=${parsed.result}`);
    return parsed;
  }

}

/* ============================================================================
 * NOTE: Gemini Interactions API Architecture
 * ============================================================================
 * The @google/genai SDK Interactions API (`interactions.create`) is used for all
 * text, multimodal, function calling, and structured output operations:
 * 1. Unified interface with server-side interaction continuity (`previous_interaction_id`).
 * 2. Step-based lifecycle (`steps` array with `function_call`, `function_result`, `model_output`).
 * 3. Native structured outputs via top-level `response_format` JSON schema.
 * 4. Transparent token usage observability (`interaction.usage`) on every remote request.
 *
 * References:
 * - Interactions API: https://ai.google.dev/gemini-api/docs/interactions
 * - Function Calling: https://ai.google.dev/gemini-api/docs/interactions/function-calling
 * ============================================================================
 */

module.exports = { GeminiClient };

