'use strict';

const { GoogleGenAI, FunctionCallingConfigMode } = require('@google/genai');
const { Readable } = require('stream');
const { HomeyMCPAdapter } = require('./HomeyMCPAdapter');
const { SystemInstruction } = require('./SystemInstruction');

// ── Constants ──────────────────────────────────────────────────────────────────
// Gemini model configuration
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash-lite';     // Default main model for text/multimodal
const GEMINI_IMAGE_MODEL = 'gemini-2.5-flash-image';    // Model for image generation

// Conversation history configuration
const CONVERSATION_HISTORY_MAX_MESSAGES = 30;        // Max messages before oldest are dropped
const CONVERSATION_HISTORY_MAX_UNCACHED_TOKENS = 2000; // Max estimated uncached tokens; excess functionCall+functionResponse pairs are pruned first
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

class GeminiClient {
  constructor(apiKey, options = {}) {
    if (!apiKey) {
      throw new Error("API key is required");
    }
    this.genAI = new GoogleGenAI({ apiKey: apiKey });
    this.options = options;
    this.homey = options.homey;

    // Model configuration
    // smartHomeModel: used for MCP/Smart Home commands (complex reasoning)
    // chatModel: used for simple text/multimodal prompts (faster/cheaper)
    this.smartHomeModel = options.smartHomeModel || options.modelName || DEFAULT_GEMINI_MODEL;
    this.chatModel = options.chatModel || this.smartHomeModel;
    this.customInstructions = options.customInstructions || '';

    this.mcpAdapter = this.homey ? new HomeyMCPAdapter(this.homey) : null;
    this.mcpModel = null;

    // Conversation history for multi-call memory
    // Each entry: { timestamp: number, content: object }
    this.conversationHistory = [];

    // Context cache for MCP smart home sessions.
    // Caches the static systemInstruction + tool definitions to avoid re-sending
    // ~6,500 tokens of tool descriptions on every request.
    // { name: string, model: string, expiresAt: number } | null
    this._mcpCache = null;

    console.log(`[GeminiClient] Initialized with Smart Home Model: ${this.smartHomeModel}, Chat Model: ${this.chatModel}`);
  }

  // ── Private Methods ──────────────────────────────────────────────────────────

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
        const isRetryableError = errorStr.includes('429') ||
          errorStr.includes('503') ||
          errorStr.includes('quota') ||
          errorStr.includes('service unavailable') ||
          errorStr.includes('high demand') ||
          errorStr.includes('resource_exhausted') ||
          errorDetails.includes('429') ||
          errorDetails.includes('503') ||
          errorDetails.includes('resource_exhausted');
 
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

        console.log(`[GeminiClient] [${operationName}] 429 Rate limit. Retrying in ${waitTimeMs}ms (Attempt ${retries + 1}/${MAX_RETRIES})...`);

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
   * Synchronises the completed Chat session history to the persistent
   * conversation history, replacing any existing entries. This ensures that
   * thought signatures and all context from the latest session are preserved
   * for subsequent calls.
   *
   * @private
   * @param {import('@google/genai').Chat} chat - The completed Chat instance.
   * @returns {Promise<void>}
   * @example
   * await this._syncChatToPersistentHistory(chat);
   */
  async _syncChatToPersistentHistory(chat) {
    try {
      const chatHistory = await chat.getHistory();

      // Strip thought parts (part.thought === true) before persisting.
      // Gemini 2.5+ includes internal reasoning in getHistory(), which inflates
      // token count by thousands and causes empty responses in subsequent sessions.
      // Only visible content parts should be preserved across sessions.
      this.conversationHistory = chatHistory.map(content => {
        const cleanContent = { ...content };
        if (Array.isArray(cleanContent.parts)) {
          cleanContent.parts = cleanContent.parts.filter(part => !part.thought);
        }
        return {
          timestamp: Date.now(),
          content: cleanContent
        };
      });

      console.log(`[MCP] Synced ${chatHistory.length} messages to persistent history`);
    } catch (error) {
      console.error('[MCP] ERROR: Failed to sync chat history:', error.message);
    }
  }

  // ── Public Methods ───────────────────────────────────────────────────────────

  /**
   * Clears the entire conversation history.
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
    console.log(`[GeminiClient] Conversation history cleared (${count} entries removed)`);
  }

  /**
   * Seeds the conversation history with a context message injected as a 'model' turn,
   * so that the next MCP command has immediate conversational context.
   *
   * The history must always end with a 'model' turn so that the next `sendMessage`
   * does not produce two consecutive 'user' turns (which causes a 400 error).
   * Injection strategy based on the current last entry:
   * - Last entry is 'user'  → inject `model(contextMessage)` only (closes the pair).
   * - History empty or last entry is 'model' → inject `user('[context]') + model(contextMessage)` (new pair).
   *
   * @public
   * @param {string} contextMessage - The context message to inject as a 'model' turn.
   * @returns {void}
   * @example
   * // Inject context before the next MCP command:
   * geminiClient.seedConversationContext('The front door sensor just triggered.');
   */
  seedConversationContext(contextMessage) {
    if (!contextMessage || typeof contextMessage !== 'string') {
      console.warn('[GeminiClient] seedConversationContext called with invalid message');
      return;
    }

    const lastEntry = this.conversationHistory[this.conversationHistory.length - 1];
    const lastRole = lastEntry?.content?.role;

    if (lastRole === 'user') {
      // History ends with 'user': inject only the model turn to close the pair
      this._addToConversationHistory({
        role: 'model',
        parts: [{ text: contextMessage }]
      });
    } else {
      // History is empty or ends with 'model': inject a full user+model pair
      this._addToConversationHistory({
        role: 'user',
        parts: [{ text: '[context]' }]
      });
      this._addToConversationHistory({
        role: 'model',
        parts: [{ text: contextMessage }]
      });
    }

    console.log(`[GeminiClient] Conversation context seeded (${this.conversationHistory.length} total messages, last role: model)`);
  }

  /**
   * Generates a text response from a simple text prompt.
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
    console.log('[GeminiClient] generateText prompt:', prompt);

    return this._retryableRequest(async () => {
      const response = await this.genAI.models.generateContent({
        model: this.chatModel,
        contents: prompt
      });
      return response.text;
    }, 'generateText');
  }

  /**
   * Generates a text response from a multimodal prompt (text + image).
   * The image is converted to Base64 and sent inline.
   * Per Gemini documentation, placing the text prompt after the image yields
   * best results for single-image inputs.
   *
   * @public
   * @param {string} textPrompt - The text prompt to send alongside the image.
   * @param {Buffer} imageBuffer - The image data as a Node.js Buffer.
   * @param {string} [mimeType='image/jpeg'] - The MIME type of the image (e.g., `'image/png'`).
   * @returns {Promise<string>} The generated text response.
   * @throws {Error} If the API call fails after the configured retries.
   * @example
   * const fs = require('fs');
   * const imgBuffer = fs.readFileSync('./photo.jpg');
   * const description = await geminiClient.generateTextWithImage('What is in this photo?', imgBuffer);
   */
  async generateTextWithImage(textPrompt, imageBuffer, mimeType = 'image/jpeg') {
    console.log('[GeminiClient] generateTextWithImage prompt:', textPrompt);
    console.log('[GeminiClient] Image buffer size:', imageBuffer.length, 'bytes, mimeType:', mimeType);

    // Convert Buffer to Base64
    const base64Image = imageBuffer.toString('base64');

    // Build multimodal content array.
    // Tip from Gemini docs: place text prompt after the image for best results with single image.
    const contents = [
      {
        inlineData: {
          mimeType: mimeType,
          data: base64Image,
        },
      },
      textPrompt,
    ];

    return this._retryableRequest(async () => {
      const response = await this.genAI.models.generateContent({
        model: this.chatModel,
        contents: contents,
      });

      return response.text;
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
    console.log('[GeminiClient] generateImage prompt:', prompt);

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

      console.log('[GeminiClient] Image generated successfully, bytes length:', base64ImageBytes.length);

      // Return the Base64 string
      return base64ImageBytes;
    } catch (error) {
      console.error('[GeminiClient] Error generating image:', error);
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
    console.log('[GeminiClient] generateImageStream prompt:', prompt);
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
    console.log(`[MCP]   calling ${call.name}(${JSON.stringify(call.args)})`);

    try {
      const result = await this.mcpAdapter.callTool(call.name, call.args);

      // Create a safe version for logging (exclude large image data)
      const logResult = { ...result };
      if (logResult._imageData) {
        delete logResult._imageData;
        logResult._hasImage = true;
      }
      console.log(`[MCP]   ${result.success ? 'OK' : 'FAIL'} ${call.name}: ${JSON.stringify(logResult)}`);

      return { call, result, success: result.success === true };
    } catch (error) {
      // Best practice: Return informative error messages to the model
      console.error(`[MCP]   EXCEPTION ${call.name}: ${error.message}`);
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
   * console.log(response); // 'OK, I turned on the kitchen lights.'
   */

  /**
   * Ensures a valid Gemini context cache exists for the current smart home model.
   *
   * The cache bundles the static system instruction and all 19 tool definitions
   * (~6,500 tokens). It is created on first use and automatically refreshed when
   * it is about to expire or when the active model changes.
   *
   * Dynamic context (date/time, timezone, language) is intentionally excluded
   * from the cache — it is injected as a one-line prefix in the user message via
   * {@link SystemInstruction.buildDynamicPrefix} on every call.
   *
   * @private
   * @returns {Promise<string>} Gemini cache resource name (e.g. `'cachedContents/xxxx'`).
   * @throws {Error} If cache creation fails (e.g. the configured model does not support caching).
   */
  async _ensureCache() {
    const CACHE_TTL_SECONDS = 600; // 10 minutes
    const SAFETY_MARGIN_MS = 30_000; // Recreate 30 s before expiry to avoid mid-session expiry
    const now = Date.now();

    // Return existing cache if still valid for the current model
    if (
      this._mcpCache &&
      this._mcpCache.model === this.smartHomeModel &&
      this._mcpCache.expiresAt > now + SAFETY_MARGIN_MS
    ) {
      return this._mcpCache.name;
    }

    // Build tool declarations (static — do not change at runtime)
    const toolsList = await this.mcpAdapter.listTools();
    const functionDeclarations = toolsList.tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema
    }));

    const action = this._mcpCache ? 'Refreshing' : 'Creating';
    console.log(`[MCP] ${action} context cache for model: ${this.smartHomeModel}`);

    // Gemini 3 models support VALIDATED mode — include toolConfig in the cache
    // so it cannot be passed again in the generateContent request (API restriction).
    // Non-Gemini-3 models use AUTO implicitly; passing toolConfig causes errors.
    const isGemini3Model = this.smartHomeModel.includes('gemini-3');
    const cacheConfig = {
      systemInstruction: SystemInstruction.buildStatic(this.customInstructions),
      tools: [{ functionDeclarations }],
      ttl: `${CACHE_TTL_SECONDS}s`,
      ...(isGemini3Model && {
        toolConfig: {
          functionCallingConfig: {
            mode: FunctionCallingConfigMode.VALIDATED
          }
        }
      })
    };

    const cache = await this.genAI.caches.create({
      model: this.smartHomeModel,
      config: cacheConfig
    });

    this._mcpCache = {
      name: cache.name,
      model: this.smartHomeModel,
      expiresAt: now + CACHE_TTL_SECONDS * 1000
    };

    console.log(`[MCP] Context cache ready: ${cache.name} (TTL: ${CACHE_TTL_SECONDS}s, toolConfig: ${isGemini3Model ? 'VALIDATED' : 'AUTO (implicit)'})`);
    return this._mcpCache.name;
  }

  async generateTextWithMCP(prompt, options = {}) {
    if (!this.mcpAdapter) {
      throw new Error("MCP Adapter not available. Homey instance is required.");
    }

    console.log(`[MCP] User command: "${prompt}"`);

    // Build dynamic context prefix (date/time, timezone, language).
    // This changes every call and is therefore injected into the user message
    // rather than the system instruction, keeping the cache valid.
    const ctx = SystemInstruction._buildDateTimeContext(this.homey);
    const dynamicPrefix = SystemInstruction.buildDynamicPrefix(ctx, options);

    // Log date/time context for debugging schedule commands
    console.log('[MCP] System Instruction Date/Time Context:');
    console.log(`[MCP]   Local: ${ctx.localDateTime} (${ctx.userTimezone})`);
    console.log(`[MCP]   Offset: UTC${ctx.timezoneOffset}`);
    console.log(`[MCP]   Language: ${ctx.homeyLanguage}`);

    // Ensure context cache is valid (creates or refreshes cached systemInstruction + tools)
    const cachedContentName = await this._ensureCache();

    // Prune old messages from conversation history (max size + valid-start guarantee)
    this._pruneConversationHistory();

    // Get existing conversation history for chat initialization
    const existingHistory = this._getConversationHistoryContents();
    console.log(`[MCP] Persistent conversation history: ${existingHistory.length} messages`);

    // Detect model family once for use in config below.
    const isGemini3Model = this.smartHomeModel.includes('gemini-3');

    // Create chat session — systemInstruction, tools and toolConfig are all baked
    // into cachedContent (see _ensureCache). The API rejects any of those fields
    // when cachedContent is present in the request.
    // Only temperature goes here (it is not cacheable).
    const chatConfig = {
      cachedContent: cachedContentName,
      // Best practice: Use low temperature (0) for most models for deterministic function calling,
      // but keep default (1.0) for Gemini 3 models to avoid looping/degradation.
      temperature: isGemini3Model ? 1.0 : 0
    };

    const chat = this.genAI.chats.create({
      model: this.smartHomeModel,
      config: chatConfig,
      history: existingHistory  // Initialize with persistent history
    });

    console.log(`[MCP] Chat session created with cached context: ${cachedContentName} | toolConfig: VALIDATED (in cache)`);

    let turnCount = 0;
    let capturedTimerId = null;  // Track timer ID if schedule_command is called

    // Prepend dynamic context prefix to the user message so Gemini always has
    // accurate date/time and language even though the system instruction is cached.
    const promptWithContext = `${dynamicPrefix}\n${prompt}`;

    // Send initial user message
    console.log(`[MCP] Turn 1: Sending user message`);
    let response = await this._retryableRequest(async () => {
      return await chat.sendMessage({ message: promptWithContext });
    }, `generateTextWithMCP (turn 1)`);

    // Multi-turn function calling loop
    while (turnCount < MAX_TURNS) {
      turnCount++;

      const candidate = response.candidates?.[0];
      if (!candidate?.content?.parts) {
        console.log("[MCP] WARN: Empty response from API (no parts in content)");
        // Log the response for debugging
        console.log("[MCP] Response object:", JSON.stringify(response, null, 2));

        // Empty response in AUTO mode - this can happen if Gemini decides not to respond
        // Return a generic error message
        return {
          response: this.homey.__('prompt.empty_response'),
          success: false,
          timerId: capturedTimerId
        };
      }

      // Validate finishReason (following Google's best practices)
      // Reference: https://ai.google.dev/gemini-api/docs/function-calling#best-practices
      const finishReason = candidate.finishReason;
      console.log(`[MCP] finishReason: ${finishReason}`);

      if (finishReason === "SAFETY") {
        console.error("[MCP] ERROR: Response blocked by safety filters");
        return {
          response: "I cannot process this request due to safety guidelines.",
          success: false,
          timerId: capturedTimerId
        };
      }

      if (finishReason === "MAX_TOKENS") {
        console.error("[MCP] ERROR: Response truncated due to token limit");
        return {
          response: "The response was too long. Please try a simpler query.",
          success: false,
          timerId: capturedTimerId
        };
      }

      if (finishReason === "RECITATION") {
        console.error("[MCP] ERROR: Response blocked due to recitation");
        return {
          response: "Unable to complete this request. Please try rephrasing.",
          success: false,
          timerId: capturedTimerId
        };
      }

      // Handle MALFORMED_FUNCTION_CALL: Gemini 3 Pro sometimes produces malformed function calls
      // In this case, content is empty so we skip this response and give the model another chance
      if (finishReason === "MALFORMED_FUNCTION_CALL") {
        console.warn(`[MCP] WARN: Model produced malformed function call at turn ${turnCount}, retrying...`);
        // Don't add empty content to history, just continue to next turn
        // This gives the model another chance to produce a valid response
        if (turnCount < MAX_TURNS) {
          continue;
        }
        console.error("[MCP] ERROR: Max retries reached for malformed function calls");
        return {
          response: "Unable to complete this request. The model had trouble processing it.",
          success: false,
          timerId: capturedTimerId
        };
      }

      if (finishReason !== "STOP" && finishReason !== undefined) {
        console.warn(`[MCP] WARN: Unexpected finishReason: ${finishReason}`);
        // Continue anyway, as it might still have usable content
      }

      // Note: Gemini 3 requires thoughtSignature to be preserved in multi-turn function calling.
      // The SDK 1.38.0+ Chat API handles this automatically.

      // Check for function calls
      const functionCalls = response.functionCalls || [];

      if (functionCalls.length === 0) {
        // No function calls - Gemini chose to respond conversationally
        // This is normal in AUTO mode for non-home-automation queries
        console.log(`[MCP] Conversational response generated after ${turnCount} turn(s)`);

        // Log token usage for monitoring purposes
        const usage = response.usageMetadata;
        if (usage) {
          const cached = usage.cachedContentTokenCount ?? 0;
          const uncached = (usage.promptTokenCount ?? 0) - cached;
          const thoughts = usage.thoughtsTokenCount ?? 0;
          const cacheInfo = cached > 0 ? `, cached: ${cached}, uncached: ${uncached}` : '';
          const thinkInfo = thoughts > 0 ? `, thoughts: ${thoughts}` : '';
          console.log(`[MCP] Token usage — prompt: ${usage.promptTokenCount}${cacheInfo}${thinkInfo}, candidates: ${usage.candidatesTokenCount ?? 0}, total: ${usage.totalTokenCount}`);
        }

        const finalResponse = response.text || "Operation completed successfully.";

        // Save the final conversation to persistent history
        await this._syncChatToPersistentHistory(chat);

        return {
          response: finalResponse,
          // Success if we got a meaningful response (not empty/default)
          success: response.text && response.text.length > 0,
          timerId: capturedTimerId
        };
      }

      // Execute function calls using smart parallel/sequential dispatch.
      // - If the batch mixes state-mutating tools with state-reading tools, execute
      //   sequentially to prevent stale-state race conditions.
      // - Otherwise (all mutations or all reads), execute in parallel for performance.
      // Reference: https://ai.google.dev/gemini-api/docs/function-calling#parallel-function-calling
      console.log(`[MCP] Executing ${functionCalls.length} function(s):`);

      let executedFunctions;

      if (functionCalls.length > 1 && this._shouldExecuteSequentially(functionCalls)) {
        // Sequential execution: mixed batch detected (mutation + state-read)
        console.log(`[MCP] Sequential execution: ${functionCalls.length} functions (mixed mutation+query batch — prevents stale state)`);
        executedFunctions = [];
        for (const call of functionCalls) {
          const result = await this._executeSingleFunctionCall(call);
          executedFunctions.push(result);
        }
      } else {
        // Parallel execution: homogeneous batch (all mutations or all reads)
        if (functionCalls.length > 1) {
          console.log(`[MCP] Parallel execution: ${functionCalls.length} functions (homogeneous batch — safe)`);
        }
        executedFunctions = await Promise.all(
          functionCalls.map(call => this._executeSingleFunctionCall(call))
        );
      }

      // Process results and build response array
      const functionResponses = [];
      for (const { call, result, success } of executedFunctions) {
        // Capture timer ID if schedule_command was called
        if (success && call.name === 'schedule_command' && result.scheduleId) {
          capturedTimerId = result.scheduleId;
          console.log(`[MCP]   Captured timer ID: ${capturedTimerId}`);
        }

        // Check if result contains image data (multimodal function response).
        // The Gemini API requires the functionResponse and the inlineData image
        // to be sent as SEPARATE Parts in the same message array — nesting
        // inlineData inside the functionResponse object is not supported and
        // causes a 400 INVALID_ARGUMENT error.
        if (success && result._hasImage && result._imageData && result._imageMimeType) {
          console.log(`[MCP]   Function returned image, building multimodal response`);

          // Create clean result without internal _ fields
          const cleanResult = { ...result };
          const imageBase64 = cleanResult._imageData;
          const mimeType = cleanResult._imageMimeType;
          delete cleanResult._imageData;
          delete cleanResult._imageMimeType;
          delete cleanResult._hasImage;

          // Add image reference to the JSON response so the model knows an image is attached
          cleanResult.image_info = 'Image attached for visual analysis';

          // Part 1: standard functionResponse (JSON only)
          functionResponses.push({
            functionResponse: {
              name: call.name,
              response: cleanResult
            }
          });

          // Part 2: image as a separate inlineData Part in the same message array
          functionResponses.push({
            inlineData: {
              data: imageBase64,
              mimeType: mimeType
            }
          });
        } else {
          // Standard function response (no image)
          functionResponses.push({
            functionResponse: {
              name: call.name,
              response: result
            }
          });
        }
      }

      // Check if we're about to exceed max turns.
      // Instead of returning a hardcoded error message, ask Gemini to close
      // the session itself with a natural-language explanation. This produces
      // a valid 'model' text turn that correctly closes the history so that
      // _syncChatToPersistentHistory can save it without corruption.
      if (turnCount >= MAX_TURNS) {
        console.log(`[MCP] ERROR: Max turns (${MAX_TURNS}) reached. Sending give-up turn to model.`);
        try {
          const giveUpMessage =
            '[System: maximum tool call attempts reached] ' +
            '**Stop calling tools immediately.** ' +
            'In one or two sentences, apologize to the user, explain ' +
            'that you were unable to complete the request despite multiple attempts, ' +
            'and kindly ask them to repeat the request trying to be more precise. ' +
            '**Do NOT call any function or tool.**';

          const giveUpResponse = await this._retryableRequest(async () => {
            return await chat.sendMessage({
              message: giveUpMessage,
              config: {
                toolConfig: {
                  functionCallingConfig: {
                    mode: FunctionCallingConfigMode.NONE  // Force text-only response
                  }
                }
              }
            });
          }, 'generateTextWithMCP (give-up turn)');

          // History is now properly closed with a model text turn — sync it
          await this._syncChatToPersistentHistory(chat);

          return {
            response: giveUpResponse.text || this.homey.__('prompt.error.max_turns_reached'),
            success: false,
            timerId: capturedTimerId
          };
        } catch (giveUpError) {
          // Fallback: if even the give-up message fails, clear history to avoid corruption
          console.error('[MCP] ERROR: Give-up turn also failed:', giveUpError.message);
          this.clearConversationHistory();
          return {
            response: this.homey.__('prompt.error.max_turns_reached'),
            success: false,
            timerId: capturedTimerId
          };
        }
      }

      // Send function responses back to model using Chat API and get next response
      console.log(`[MCP] Sending ${functionResponses.length} function result(s) to model for turn ${turnCount + 1}`);

      response = await this._retryableRequest(async () => {
        return await chat.sendMessage({
          message: functionResponses  // Array<Part> with functionResponse objects
        });
      }, `generateTextWithMCP (turn ${turnCount + 1})`);

      // Loop continues with the new response
    }

    // This should never be reached due to the check above, but just in case
    console.log(`[MCP] ERROR: Exited loop unexpectedly at turn ${turnCount}`);
    this.clearConversationHistory();
    return {
      response: this.homey.__('prompt.error.max_turns_reached'),
      success: false,
      timerId: capturedTimerId
    };
  }


}

/* ============================================================================
 * NOTE: Automatic Function Calling (AFC) and CallableTool
 * ============================================================================
 * The @google/genai SDK (v1.34.0+) supports AFC in JavaScript via CallableTool
 * interface, which automatically handles the function calling loop.
 *
 * However, this implementation uses manual loop + Chat API for the following reasons:
 * 1. CallableTool/AFC is not yet fully documented in official guides
 * 2. Provides more control over error handling (finishReason, MALFORMED_FUNCTION_CALL)
 * 3. Allows custom logic (capturedTimerId tracking, retry strategies)
 * 4. Chat API already simplifies history management significantly
 *
 * Future consideration: Migrate to CallableTool when it becomes officially documented.
 *
 * References:
 * - Manual function calling: https://ai.google.dev/gemini-api/docs/function-calling
 * - SDK samples: sdk-samples/generate_content_afc_streaming.ts
 * ============================================================================
 */

module.exports = { GeminiClient };
