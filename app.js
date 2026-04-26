'use strict';

const Homey = require('homey');
const { Readable } = require('stream');
const { GeminiClient } = require('./lib/GeminiClient');

module.exports = class GeminiApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('[onInit] GeminiApp has been initialized');

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
      if (key === 'gemini_api_key' || key === 'gemini_model' || key === 'gemini_model_chat' || key === 'gemini_custom_instructions') {
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
    const modelName = this.homey.settings.get('gemini_model') || 'gemini-2.5-flash';
    const chatModelName = this.homey.settings.get('gemini_model_chat');
    const customInstructions = this.homey.settings.get('gemini_custom_instructions');

    if (!apiKey) {
      this.log('[initializeGeminiClient] API key not found in settings - app will function but Gemini flows will fail until API key is configured');
      return;
    }

    this.geminiClient = new GeminiClient(apiKey, {
      homey: this.homey,
      smartHomeModel: modelName,
      chatModel: chatModelName,
      customInstructions: customInstructions
    });
    this.log(`[initializeGeminiClient] GeminiClient initialized successfully. Smart Home: ${modelName}, Chat: ${chatModelName || 'Default (' + modelName + ')'}`);
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
   * Centralized error handling for flow card errors
   * @param {string} context - The context where the error occurred
   * @param {Error} error - The error object
   * @throws {Error} A user-friendly error message
   */
  handleFlowError(context, error) {
    this.error(`${context} Error:`, error);

    let errorMessage = error.message;

    // Extract localized error message from Google API errors
    if (Array.isArray(error.errorDetails)) {
      const localized = error.errorDetails.find(
        d => d['@type'] === 'type.googleapis.com/google.rpc.LocalizedMessage' && d.message
      );
      if (localized) {
        errorMessage = localized.message;
      }
    }

    this.error(`${context} Error message: ${errorMessage}`);

    // Check for specific error types and provide localized messages
    const errorStr = (error.message || '').toLowerCase();
    const errorDetails = JSON.stringify(error).toLowerCase();

    // Rate limit / quota exceeded errors (429)
    if (errorStr.includes('429') ||
      errorStr.includes('quota') ||
      errorStr.includes('resource_exhausted') ||
      errorDetails.includes('429') ||
      errorDetails.includes('resource_exhausted')) {
      throw new Error(this.homey.__("prompt.error.rate_limit_exceeded"));
    }

    // Service Unavailable / High Demand (503)
    if (errorStr.includes('503') ||
      errorStr.includes('service unavailable') ||
      errorStr.includes('high demand') ||
      errorDetails.includes('503') ||
      errorDetails.includes('service_unavailable')) {
      throw new Error(this.homey.__("prompt.error.service_unavailable"));
    }

    // Content blocked by safety filters
    if (errorStr.includes('blocked') ||
      errorStr.includes('safety') ||
      errorDetails.includes('blocked_reason')) {
      throw new Error(this.homey.__("prompt.error.content_blocked"));
    }

    // API key invalid
    if (errorStr.includes('api_key_invalid') ||
      errorStr.includes('invalid api key') ||
      errorStr.includes('api key not valid')) {
      throw new Error(this.homey.__("prompt.error.api_key_invalid"));
    }

    // Generic error fallback
    throw new Error(this.homey.__("prompt.error.generic", { error: errorMessage }));
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

};

