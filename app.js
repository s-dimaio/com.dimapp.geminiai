'use strict';

const Homey = require('homey');
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

    // Listen for settings changes to re-initialize the client
    this.homey.settings.on('set', (key) => {
      if (key === 'gemini_api_key' || key === 'gemini_model') {
        this.log(`[onInit] Setting ${key} changed, re-initializing GeminiClient`);
        this.initializeGeminiClient();
      }
    });

    // Register flow cards
    this.registerSendPromptActionCard();
    this.registerSendPromptWithImageActionCard();
    this.registerMCPCommandActionCard();
    this.registerSeedConversationContextCard();
  }

  /**
   * Initialize the GeminiClient with the API key from settings
   */
  initializeGeminiClient() {
    const apiKey = this.homey.settings.get('gemini_api_key');
    const modelName = this.homey.settings.get('gemini_model') || 'gemini-2.5-flash';

    if (!apiKey) {
      this.log('[initializeGeminiClient] API key not found in settings - app will function but Gemini flows will fail until API key is configured');
      return;
    }

    this.geminiClient = new GeminiClient(apiKey, {
      homey: this.homey,
      modelName: modelName
    });
    this.log(`[initializeGeminiClient] GeminiClient initialized successfully with model: ${modelName}`);
  }

  /**
   * onUninit is called when the app is destroyed
   */
  async onUninit() {
    this.log('[onUninit] GeminiApp is being destroyed');

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

        return { answer: text };

      } catch (error) {
        return this.handleFlowError('[sendPromptActionCard]', error);
      }
    });
  }

  /**
   * Register the "Send Prompt with Image" action card (multimodal: text + image)
   */
  registerSendPromptWithImageActionCard() {
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

        // Get the image stream and convert to buffer
        const imageStream = await imageToken.getStream();
        this.log(`[sendPromptWithImageActionCard] Image stream received - contentType: ${imageStream.contentType}, filename: ${imageStream.filename}`);

        const imageBuffer = await GeminiClient.streamToBuffer(imageStream);
        this.log(`[sendPromptWithImageActionCard] Image buffer created, size: ${imageBuffer.length} bytes`);

        const mimeType = imageStream.contentType || 'image/jpeg';

        // Generate response
        const text = await this.geminiClient.generateTextWithImage(prompt, imageBuffer, mimeType);
        this.log(`[sendPromptWithImageActionCard] Response: ${text}`);

        return { answer: text };

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

