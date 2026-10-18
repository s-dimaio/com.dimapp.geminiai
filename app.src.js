'use strict';

const Homey = require('homey');
const { Readable } = require('stream');
const { GeminiClient } = require('./lib/GeminiClient');
const ModelConfig = require('./lib/ModelConfig');

module.exports = class GeminiApp extends Homey.App {

  /**
   * Exposes the ModelConfig module for Web API endpoints and UI configuration.
   *
   * @public
   * @type {typeof import('./lib/ModelConfig')}
   */
  get modelConfig() {
    return ModelConfig;
  }

  /**
   * Exposes the FlowManager instance for Web API endpoints and backup management.
   * Lazily instantiates a standalone HomeyMCPAdapter if GeminiClient is not yet initialized.
   *
   * @public
   * @type {import('./lib/managers/FlowManager')}
   */
  get flowManager() {
    if (this.geminiClient?.mcpAdapter?.flowManager) {
      return this.geminiClient.mcpAdapter.flowManager;
    }
    if (!this._standaloneFlowManager) {
      const { HomeyMCPAdapter } = require('./lib/HomeyMCPAdapter');
      this._standaloneMcpAdapter = new HomeyMCPAdapter(this.homey);
      this._standaloneFlowManager = this._standaloneMcpAdapter.flowManager;
    }
    return this._standaloneFlowManager;
  }

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('[onInit] GeminiApp has been initialized');

    // Automatically migrate any deprecated or preview models in settings
    ModelConfig.migrateSettings(this.homey);

    // Initialize the GeminiClient once at startup
    this.initializeGeminiClient();

    // Restore scheduled commands after restart
    if (this.geminiClient && this.geminiClient.mcpAdapter) {
      await this.geminiClient.mcpAdapter.restoreScheduledCommands();
    }

    // Listen for settings changes to re-initialize the client.
    // Store the reference so it can be removed in onUninit() to avoid
    // accessing a destroyed app instance after a ready_timeout crash.
    this._settingsListener = (key) => {
      if (key === 'gemini_api_key' || key === 'gemini_model' || key === 'gemini_model_chat' || key === 'gemini_model_sh_generic' || key === 'gemini_model_sh_flow' || key === 'gemini_custom_instructions' || key === 'gemini_enable_google_search' || key === 'gemini_include_hidden_grouped') {
        this.log(`[onInit] Setting ${key} changed, re-initializing GeminiClient`);
        this.initializeGeminiClient();
      }
    };
    this.homey.settings.on('set', this._settingsListener);

    // Register flow triggers
    this.registerGeminiTriggers();

    // Register flow cards
    this.registerSendPromptActionCard();
    await this.registerSendPromptWithImageActionCard();
    this.registerMCPCommandActionCard();
    this.registerSeedConversationContextCard();
    //this.registerScheduledCommandExecutedTriggerCard();

    // Register condition cards
    this.registerEvaluatePromptConditionCard();
    await this.registerEvaluatePromptWithImageConditionCard();
    this.registerEvaluateMcpCommandConditionCard();
  }

  /**
   * Registers the Gemini response trigger cards
   */
  registerGeminiTriggers() {
    this.geminiResponseReadyTrigger = this.homey.flow.getTriggerCard('gemini_response_ready');
    this.geminiImageResponseReadyTrigger = this.homey.flow.getTriggerCard('gemini_image_response_ready');
    this.log('[registerGeminiTriggers] Asynchronous response triggers registered');
  }

  /**
   * Initialize the GeminiClient with the API key from settings
   */
  initializeGeminiClient() {
    const apiKey = this.homey.settings.get('gemini_api_key');
    const oldSmartHomeModel = this.homey.settings.get('gemini_model');
    const storedShGeneric = this.homey.settings.get('gemini_model_sh_generic') || oldSmartHomeModel;
    const storedShFlow = this.homey.settings.get('gemini_model_sh_flow') || oldSmartHomeModel;
    const storedChat = this.homey.settings.get('gemini_model_chat');

    const shGenericModel = ModelConfig.resolveModel('shGeneric', storedShGeneric);
    const shFlowModel = ModelConfig.resolveModel('shFlow', storedShFlow);
    const chatModel = ModelConfig.resolveModel('chat', storedChat);
    const customInstructions = this.homey.settings.get('gemini_custom_instructions');
    const enableGoogleSearch = this.homey.settings.get('gemini_enable_google_search') !== false;

    if (!apiKey) {
      this.log('[initializeGeminiClient] API key not found in settings - app will function but Gemini flows will fail until API key is configured');
      return;
    }

    this.geminiClient = new GeminiClient(apiKey, {
      homey: this.homey,
      shGenericModel: shGenericModel,
      shFlowModel: shFlowModel,
      chatModel: chatModel,
      customInstructions: customInstructions,
      enableGoogleSearch: enableGoogleSearch
    });
    this.log(`[initializeGeminiClient] GeminiClient initialized successfully. Chat: ${chatModel}, Generic: ${shGenericModel}, Flow: ${shFlowModel}`);
  }

  /**
   * onUninit is called when the app is destroyed
   */
  async onUninit() {
    this.log('[onUninit] GeminiApp is being destroyed');

    // Remove the settings listener to prevent it from firing after the app
    // instance has been destroyed (which would cause a "Cannot access this.homey.app" error).
    if (this._settingsListener) {
      this.homey.settings.off('set', this._settingsListener);
      this._settingsListener = null;
    }

    // Cleanup scheduler interval if MCP adapter exists
    if (this.geminiClient && this.geminiClient.mcpAdapter) {
      await this.geminiClient.mcpAdapter.cleanup();
    }
  }

  /**
   * Register the "Send Prompt" action card (text only)
   */
  registerSendPromptActionCard() {
    this.sendPromptActionCard = this.homey.flow.getActionCard("send-prompt");
    this.sendPromptActionCard.registerRunListener(async (args) => {
      this.log(`[sendPromptActionCard] Args: ${JSON.stringify(args, null, 2)}`);

      try {
        // Check if GeminiClient is initialized
        if (!this.geminiClient) {
          throw new Error(this.homey.__("prompt.error.noapi") || 'Gemini API key not configured in app settings');
        }

        const prompt = args['prompt'];
        this.log(`[sendPromptActionCard] Prompt: ${prompt}`);

        const text = await this.geminiClient.generateText(prompt);
        this.log(`[sendPromptActionCard] Response: ${text}`);

        // Trigger the asynchronous event
        this.geminiResponseReadyTrigger.trigger({ response: text })
          .catch(err => this.error('[sendPromptActionCard] Error triggering gemini_response_ready:', err));

        return { answer: text };

      } catch (error) {
        return this.handleFlowError('[sendPromptActionCard]', error);
      }
    });
  }

  /**
   * Register the "Send Prompt with Image" action card (multimodal: text + image).
   *
   * To handle concurrent flow executions correctly, a fixed pool of Homey Image
   * objects is pre-allocated once at registration time. The size of the pool is
   * read from user settings (default 4). Each run selects a slot from the pool
   * using an atomic round-robin counter (safe in Node.js single-threaded
   * environment) and updates only that slot's stream. This guarantees:
   *
   * - **No race condition**: concurrent runs write to distinct slots and return distinct
   *   image objects, so each token always serves the correct, isolated buffer.
   * - **No memory leak**: the pool has a fixed size and is never grown at runtime.
   * - **Backwards compatibility**: a single (non-concurrent) run behaves identically to
   *   the previous single-image approach.
   */
  async registerSendPromptWithImageActionCard() {
    // Read the pool size from settings, fallback to 4 if invalid or undefined.
    const poolSizeSetting = this.homey.settings.get('gemini_image_pool_size');
    let poolSize = parseInt(poolSizeSetting, 10);
    if (isNaN(poolSize) || poolSize < 1) {
      poolSize = 4;
    }

    // Pre-allocate the image pool. Each slot is a long-lived Homey Image object
    // that is reused across all flow runs assigned to it.
    this._imagePool = await Promise.all(
      Array.from({ length: poolSize }, () => this.homey.images.createImage())
    );
    // Round-robin counter. Incremented synchronously before any await, so each
    // concurrent run is guaranteed to receive a different slot index.
    this._imagePoolIndex = 0;
    this.log(`[sendPromptWithImageActionCard] Image pool ready (${poolSize} slots)`);

    this.sendPromptWithImageActionCard = this.homey.flow.getActionCard("send-prompt-with-image");
    this.sendPromptWithImageActionCard.registerRunListener(async (args) => {
      this.log(`[sendPromptWithImageActionCard] Args: ${JSON.stringify(args, null, 2)}`);

      try {
        // Check if GeminiClient is initialized
        if (!this.geminiClient) {
          throw new Error(this.homey.__("prompt.error.noapi") || 'Gemini API key not configured in app settings');
        }

        const prompt = args['prompt'];
        const imageToken = args.droptoken;

        this.log(`[sendPromptWithImageActionCard] Prompt: ${prompt}`);

        // Validate image token
        this.validateImageToken(imageToken);

        // Atomically claim a slot from the pool before the first await.
        // Because this line is synchronous, no two concurrent runs can ever
        // receive the same slotIndex in the same tick.
        const slotIndex = this._imagePoolIndex % poolSize;
        this._imagePoolIndex++;
        const slotImage = this._imagePool[slotIndex];
        this.log(`[sendPromptWithImageActionCard] Using image pool slot ${slotIndex}`);

        // Get the image stream and convert to buffer.
        // The buffer is captured here, before the Gemini API call, to ensure the image
        // that is later returned in the token is the exact same frame sent to the API.
        // This prevents a race condition where cameras that overwrite snapshots at regular
        // intervals could cause the returned token to show a different frame than the one
        // Gemini analyzed.
        const imageStream = await imageToken.getStream();
        this.log(`[sendPromptWithImageActionCard] Image stream received - contentType: ${imageStream.contentType}, filename: ${imageStream.filename}`);

        const imageBuffer = await GeminiClient.streamToBuffer(imageStream);
        this.log(`[sendPromptWithImageActionCard] Image buffer created, size: ${imageBuffer.length} bytes`);

        const mimeType = imageStream.contentType || 'image/jpeg';

        // Update this run's dedicated slot with the captured buffer, then notify
        // Homey that the slot's content has changed. Only this slot's stream
        // callback is written — other concurrent runs' slots are untouched.
        slotImage.setStream(async (outStream) => {
          Readable.from(imageBuffer).pipe(outStream);
        });
        await slotImage.update();

        // Generate response
        const text = await this.geminiClient.generateTextWithImage(prompt, imageBuffer, mimeType);
        this.log(`[sendPromptWithImageActionCard] Response: ${text}`);

        // Trigger the asynchronous event with this run's dedicated slot image
        this.geminiImageResponseReadyTrigger.trigger({
          response: text,
          image: slotImage
        }).catch(err => this.error('[sendPromptWithImageActionCard] Error triggering gemini_image_response_ready:', err));

        return {
          answer: text,
          analyzed_image: slotImage
        };

      } catch (error) {
        return this.handleFlowError('[sendPromptWithImageActionCard]', error);
      }
    });
  }

  /**
   * Validate that a valid image token is provided
   * @param {*} imageToken - The image token to validate
   * @throws {Error} If imageToken is invalid or multiple images are provided
   */
  validateImageToken(imageToken) {
    if (!imageToken) {
      throw new Error(this.homey.__("prompt.error.noimage"));
    }

    if (Array.isArray(imageToken) && imageToken.length > 1) {
      throw new Error(this.homey.__("prompt.error.multipleimages"));
    }
  }

  /**
   * Centralized error handling for flow card errors.
   * Logs full technical details for debugging while returning clear,
   * conversational, localized error messages to Homey.
   *
   * @public
   * @param {string} context - The context where the error occurred
   * @param {Error} error - The error object
   * @throws {Error} A user-friendly, conversational error message
   */
  handleFlowError(context, error) {
    this.error(`${context} Error:`, error);

    const rawMessage = error.message || '';
    let cleanMessage = rawMessage;

    // Extract clean message if error.message contains an ApiError JSON dump
    try {
      const jsonStart = rawMessage.indexOf('{');
      if (jsonStart !== -1) {
        const parsed = JSON.parse(rawMessage.slice(jsonStart));
        if (parsed.error?.message) {
          cleanMessage = parsed.error.message;
        }
      }
    } catch (_) {
      // Keep raw message if JSON parsing fails
    }

    // Extract localized error message from Google API error details if available
    if (Array.isArray(error.errorDetails)) {
      const localized = error.errorDetails.find(
        d => d['@type'] === 'type.googleapis.com/google.rpc.LocalizedMessage' && d.message
      );
      if (localized) {
        cleanMessage = localized.message;
      }
    }

    this.error(`${context} Error details: ${cleanMessage}`);

    // Check for specific error types and provide conversational localized messages
    const errorStr = (rawMessage + ' ' + (error.stack || '')).toLowerCase();
    const errorDetails = JSON.stringify(error).toLowerCase();

    // 1. Model deprecated / no longer available / not found (404)
    if (errorStr.includes('404') ||
      errorStr.includes('not_found') ||
      errorStr.includes('no longer available') ||
      errorStr.includes('is not found') ||
      errorDetails.includes('not_found') ||
      errorDetails.includes('no longer available')) {
      throw new Error(this.homey.__("prompt.error.model_not_available"));
    }

    // 2. Rate limit / quota exceeded errors (429)
    if (errorStr.includes('429') ||
      errorStr.includes('quota') ||
      errorStr.includes('resource_exhausted') ||
      errorDetails.includes('429') ||
      errorDetails.includes('resource_exhausted')) {
      throw new Error(this.homey.__("prompt.error.rate_limit_exceeded"));
    }

    // 3. Service Unavailable / High Demand (503)
    if (errorStr.includes('503') ||
      errorStr.includes('service unavailable') ||
      errorStr.includes('high demand') ||
      errorDetails.includes('503') ||
      errorDetails.includes('service_unavailable')) {
      throw new Error(this.homey.__("prompt.error.service_unavailable"));
    }

    // 4. Content blocked by safety filters
    if (errorStr.includes('blocked') ||
      errorStr.includes('safety') ||
      errorDetails.includes('blocked_reason')) {
      throw new Error(this.homey.__("prompt.error.content_blocked"));
    }

    // 5. API key invalid / unauthenticated (400 / 401 / 403)
    if (errorStr.includes('api_key_invalid') ||
      errorStr.includes('invalid api key') ||
      errorStr.includes('api key not valid') ||
      errorStr.includes('unauthenticated') ||
      errorStr.includes('401') ||
      errorStr.includes('403') ||
      (errorStr.includes('400') && (errorStr.includes('key') || errorStr.includes('api_key')))) {
      throw new Error(this.homey.__("prompt.error.api_key_invalid"));
    }

    // 6. Request Timeout errors (504, DEADLINE_EXCEEDED, UND_ERR_HEADERS_TIMEOUT, HeadersTimeoutError, AbortError, connect timeout)
    if (errorStr.includes('504') ||
      errorStr.includes('deadline_exceeded') ||
      errorStr.includes('deadline expired') ||
      errorStr.includes('deadline') ||
      errorStr.includes('headerstimeouterror') ||
      errorStr.includes('headers timeout') ||
      errorStr.includes('und_err_headers_timeout') ||
      errorStr.includes('timed out') ||
      errorStr.includes('etimedout') ||
      errorStr.includes('timeout') ||
      errorStr.includes('aborterror') ||
      errorDetails.includes('504') ||
      errorDetails.includes('deadline_exceeded') ||
      error?.cause?.code === 'UND_ERR_HEADERS_TIMEOUT' ||
      error?.cause?.name === 'HeadersTimeoutError') {
      throw new Error(this.homey.__("prompt.error.timeout"));
    }

    // 7. Network / connection errors
    if (errorStr.includes('econnreset') ||
      errorStr.includes('enotfound') ||
      errorStr.includes('fetch failed')) {
      throw new Error(this.homey.__("prompt.error.network_error"));
    }

    // Generic error fallback with cleaned message
    throw new Error(this.homey.__("prompt.error.generic", { error: cleanMessage }));
  }

  /**
   * Register the "Seed Conversation Context" action card.
   * Injects a message into the conversation memory so that the next
   * MCP command already has conversational context.
   */
  registerSeedConversationContextCard() {
    this.seedContextCard = this.homey.flow.getActionCard('seed-conversation-context');
    this.seedContextCard.registerRunListener(async (args) => {
      this.log(`[seedContextCard] Context: ${args.context}`);

      try {
        if (!this.geminiClient) {
          throw new Error(this.homey.__('prompt.error.noapi') || 'Gemini API key not configured in app settings');
        }

        const context = args.context;
        this.geminiClient.seedConversationContext(context);
        this.log(`[seedContextCard] Context injected successfully`);

        return { success: true };
      } catch (error) {
        this.error('[seedContextCard] Error:', error);
        return { success: false };
      }
    });
  }

  /**
   * Registers and initialises the 'scheduled_command_executed' flow trigger card.
   *
   * In Homey SDK 3 trigger cards must be obtained via {@link Homey.FlowManager.getTriggerCard}
   * during app initialisation so that the Flow Engine can match and route the
   * card to any flows that use it as a trigger. Without this call the card is
   * unknown to the runtime and `.trigger()` calls from {@link Scheduler}
   * will silently fail to activate matching flows.
   *
   * The card exposes four tokens: `timer_id`, `command`, `success`, `response`.
   *
   * @public
   * @returns {void}
   */
  registerScheduledCommandExecutedTriggerCard() {
    this.scheduledCommandExecutedTrigger = this.homey.flow.getTriggerCard('scheduled_command_executed');
    this.log('[registerScheduledCommandExecutedTriggerCard] Trigger card "scheduled_command_executed" registered');
  }

  /**
   * Register the "Execute MCP Command" action card (function calling with MCP)
   */
  registerMCPCommandActionCard() {
    this.mcpCommandCard = this.homey.flow.getActionCard("send-mcp-command");
    this.mcpCommandCard.registerRunListener(async (args) => {
      this.log(`[mcpCommandCard] Command: ${args.command}`);

      try {
        // Check if GeminiClient is initialized
        if (!this.geminiClient) {
          throw new Error(this.homey.__("prompt.error.noapi") || 'Gemini API key not configured in app settings');
        }

        const command = args.command;
        this.log(`[mcpCommandCard] Executing MCP command: ${command}`);

        // Generate response with MCP function calling
        const result = await this.geminiClient.generateTextWithMCP(command);
        this.log(`[mcpCommandCard] Response: ${result.response}, Success: ${result.success}, TimerId: ${result.timerId || 'none'}`);

        return {
          response: result.response,
          success: result.success,
          timer_id: result.timerId || ''
        };

      } catch (error) {
        return this.handleFlowError('[mcpCommandCard]', error);
      }
    });
  }

  /**
   * Registers and initialises the 'evaluate-prompt' condition card.
   *
   * Evaluates a plain-text yes/no question using the Conversational AI model.
   * The condition is `true` when Gemini answers YES. If Gemini determines that
   * the question is ambiguous or unanswerable as a binary condition, the run
   * listener throws a localised error containing the dynamic explanation
   * provided by Gemini.
   *
   * @public
   * @returns {void}
   */
  registerEvaluatePromptConditionCard() {
    this.evaluatePromptConditionCard = this.homey.flow.getConditionCard('evaluate-prompt');
    this.evaluatePromptConditionCard.registerRunListener(async (args) => {
      this.log(`[evaluatePromptConditionCard] Prompt: ${args.prompt}`);

      try {
        if (!this.geminiClient) {
          throw new Error(this.homey.__('prompt.error.noapi'));
        }

        const result = await this.geminiClient.evaluateCondition(args.prompt);
        this.log(`[evaluatePromptConditionCard] isAnswerable=${result.isAnswerable}, result=${result.result}`);

        if (!result.isAnswerable) {
          throw new Error(
            this.homey.__('prompt.error.not_answerable', { explanation: result.explanation })
          );
        }

        return result.result;
      } catch (error) {
        return this.handleFlowError('[evaluatePromptConditionCard]', error);
      }
    });
  }

  /**
   * Registers and initialises the 'evaluate-prompt-with-image' condition card.
   *
   * Evaluates a yes/no question about an image using the Conversational AI model.
   * Image handling mirrors the 'send-prompt-with-image' action card: a fixed
   * pool of Homey Image objects is pre-allocated at registration time to support
   * concurrent flow executions without race conditions or memory leaks.
   *
   * @public
   * @returns {Promise<void>}
   */
  async registerEvaluatePromptWithImageConditionCard() {
    const poolSizeSetting = this.homey.settings.get('gemini_image_pool_size');
    let poolSize = parseInt(poolSizeSetting, 10);
    if (isNaN(poolSize) || poolSize < 1) {
      poolSize = 4;
    }

    this._conditionImagePool = await Promise.all(
      Array.from({ length: poolSize }, () => this.homey.images.createImage())
    );
    this._conditionImagePoolIndex = 0;
    this.log(`[evaluatePromptWithImageConditionCard] Image pool ready (${poolSize} slots)`);

    this.evaluatePromptWithImageConditionCard = this.homey.flow.getConditionCard('evaluate-prompt-with-image');
    this.evaluatePromptWithImageConditionCard.registerRunListener(async (args) => {
      this.log(`[evaluatePromptWithImageConditionCard] Prompt: ${args.prompt}`);

      try {
        if (!this.geminiClient) {
          throw new Error(this.homey.__('prompt.error.noapi'));
        }

        const imageToken = args.droptoken;
        this.validateImageToken(imageToken);

        const slotIndex = this._conditionImagePoolIndex % poolSize;
        this._conditionImagePoolIndex++;

        const imageStream = await imageToken.getStream();
        this.log(`[evaluatePromptWithImageConditionCard] Image received - contentType: ${imageStream.contentType}`);

        const imageBuffer = await GeminiClient.streamToBuffer(imageStream);
        const mimeType = imageStream.contentType || 'image/jpeg';

        this.log(`[evaluatePromptWithImageConditionCard] Image buffer: ${imageBuffer.length} bytes, slot: ${slotIndex}`);

        const result = await this.geminiClient.evaluateConditionWithImage(args.prompt, imageBuffer, mimeType);
        this.log(`[evaluatePromptWithImageConditionCard] isAnswerable=${result.isAnswerable}, result=${result.result}`);

        if (!result.isAnswerable) {
          throw new Error(
            this.homey.__('prompt.error.not_answerable', { explanation: result.explanation })
          );
        }

        return result.result;
      } catch (error) {
        return this.handleFlowError('[evaluatePromptWithImageConditionCard]', error);
      }
    });
  }

  /**
   * Registers and initialises the 'evaluate-mcp-command' condition card.
   *
   * Evaluates a yes/no question that may require querying smart home device
   * state via the MCP tool-calling loop (using the Smart Home model).
   * The condition question and Gemini's answer are persisted in the shared
   * conversation history so that subsequent MCP action cards can use them
   * as context, exactly as the 'send-mcp-command' action card does.
   *
   * @public
   * @returns {void}
   */
  registerEvaluateMcpCommandConditionCard() {
    this.evaluateMcpCommandConditionCard = this.homey.flow.getConditionCard('evaluate-mcp-command');
    this.evaluateMcpCommandConditionCard.registerRunListener(async (args) => {
      this.log(`[evaluateMcpCommandConditionCard] Prompt: ${args.prompt}`);

      try {
        if (!this.geminiClient) {
          throw new Error(this.homey.__('prompt.error.noapi'));
        }

        const result = await this.geminiClient.evaluateConditionWithMCP(args.prompt);
        this.log(`[evaluateMcpCommandConditionCard] isAnswerable=${result.isAnswerable}, result=${result.result}`);

        if (!result.isAnswerable) {
          throw new Error(
            this.homey.__('prompt.error.not_answerable', { explanation: result.explanation })
          );
        }

        return result.result;
      } catch (error) {
        return this.handleFlowError('[evaluateMcpCommandConditionCard]', error);
      }
    });
  }

};
