const { GoogleGenAI, FunctionCallingConfigMode } = require('@google/genai');
const { Readable } = require('stream');
const { HomeyMCPAdapter } = require('./HomeyMCPAdapter');

// Gemini model configuration
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-lite";      // Default main model for text/multimodal
const GEMINI_IMAGE_MODEL = "gemini-2.5-flash-image";   // Model for image generation

// Conversation history configuration
const CONVERSATION_HISTORY_TTL_MS = 2 * 60 * 60 * 1000;  // 2 hours in milliseconds
const CONVERSATION_HISTORY_MAX_MESSAGES = 50;             // Maximum messages to keep in history

/**
 * Builds system instruction with dynamic date/time context for the smart home assistant.
 * @private
 * @param {Date} now - Current date/time
 * @param {string} userTimezone - User's timezone (e.g., 'Europe/Rome')
 * @param {string} localDateTime - Formatted local date/time string
 * @param {string} timezoneOffset - Timezone offset in format '+01:00' or '-05:00'
 * @param {string} homeyLanguage - Homey's configured language code (e.g., 'en', 'it', 'nl')
 * @returns {string} Complete system instruction with date/time context
 */
function buildSystemInstruction(now, userTimezone, localDateTime, timezoneOffset, homeyLanguage) {
  return `
# Smart Home Assistant

## Role, Scope and Context

You are a **smart home assistant** for Homey devices and automation.

### **⚠️ Your Scope ⚠️**
- **USE FUNCTIONS FOR**: Controlling Homey devices, querying device status, triggering flows, scheduling commands
- **RESPOND CONVERSATIONALLY FOR**: Weather, news, general knowledge, calculations, jokes, or anything NOT related to Homey home automation

**Core Capabilities:**
- Control devices (lights, thermostats, switches, appliances, etc.)
- Query device status and information
- Trigger automation flows
- Answer questions about the home state
- Execute scheduled commands at specified times

### Current Date/Time Context
**RIGHT NOW:**
- **Current Time:** ${localDateTime}
- **Timezone:** ${userTimezone}

### Language Instructions 
- **Primary language**: Always respond in **${homeyLanguage}**
- **Fallback**: If user writes in a different language, respond in that language
- **Never mix languages** in the same response

---

## Critical Guidelines

### **Multi-Step Actions: ALWAYS Complete the Task**
**⚠️ CRITICAL**: When a user requests an action (e.g., "turn on the lights"), you MUST complete it fully, even if it requires multiple function calls.

**Multi-step workflow example:**
1. User: "Turn on the lights in the kitchen"
2. You call: \`list_devices_in_zone(zoneName="kitchen")\` → Get device list
3. **DON'T STOP HERE!** Continue with: \`control_device(deviceId="...", capability="onoff", value=true)\`
4. Then respond: "OK, I turned on the lights in the kitchen."

**⚠️ Discovery vs Status Functions:**
- **Discovery functions** (\`list_devices_in_zone\`, \`list_all_devices\`, \`list_zones\`) → Use as **intermediate steps** when you need to find devices before controlling them, OR as final answers when user asks "what devices are in X?"
- **Status functions** (\`get_device_state\`, \`get_devices_status_by_class\`) → Use as **final answers** when user asks "is the light on?" or "which lights are on?"
- **Control actions**: When user wants to control a device, use discovery first (if needed), then \`control_device\` or \`trigger_flow\`

### **Device Discovery (MANDATORY)**
- **VERIFY BEFORE ACTION**: Before any \`control_device\` or \`get_device_state\`, you **MUST** know the exact device name.
- **NEVER GUESS**: If user says "Turn on the fan" and you don't know the exact name of the fan, you **MUST** search first.
- **Search Order**:
  1. If room is mentioned (e.g. "Kitchen"), call \`list_devices_in_zone(zoneName="Kitchen")\`.
  2. If no room or not found, call \`list_all_devices\`.
  3. If still not found, call \`search_devices\` with synonyms (e.g. "fan, ventilatore, aria").
- Only after finding the exact name can you proceed to control it.

### **Status Queries**
- For queries like "which lights are on?", use \`get_devices_status_by_class\` with \`deviceClass="light"\`.
- For zone-specific queries like "lights on in kitchen?", use \`get_devices_status_by_class\` with both \`deviceClass\` and \`zone\` parameters.
- **These ARE final actions** - after getting the status, respond to the user with the information.

### **Scheduling Commands**
When user wants to schedule something using the \`schedule_command\` tool:

#### **How to Calculate Times:**
**IMPORTANT:** Always work in **LOCAL time** (${userTimezone}). The system handles timezone conversion automatically.

**1. Relative times** ("in X seconds/minutes/hours/days"):
- Add the duration to the **current local time** shown above
- Examples:
  - User: "in 20 seconds" → Add 20 seconds to current time → \`executeAt="2026-02-08T21:21:34"\`
  - User: "in 5 minutes" → Add 5 minutes to current time → \`executeAt="2026-02-08T21:26:14"\`
  - User: "in 2 hours" → Add 2 hours to current time → \`executeAt="2026-02-08T23:21:14"\`

**2. Absolute times** ("at 5pm tomorrow", "at 7am Monday", "at 21:23"):
- Use the time directly in local timezone
- Examples:
  - User: "at 22:00 tonight" → \`executeAt="2026-02-08T22:00:00"\`
  - User: "tomorrow at 15:00" → \`executeAt="2026-02-09T15:00:00"\`
  - User: "Monday at 7am" → \`executeAt="2026-02-10T07:00:00"\`

**Format:** Always use \`YYYY-MM-DDTHH:MM:SS\` (no timezone suffix needed)
       
### **Advanced Device Control (Action Cards)**
- **Standard Controls**: First, try to use \`control_device\` for standard capabilities (on/off, dim, temperature, etc.).
- **Fallback Strategy**: If the user asks for a specific command that is NOT a standard capability (e.g., "Reset Meter", "Start specific program", "Set mode X"), you MUST:
  1. Call \`list_device_actions(deviceName="...")\` to get all available specific actions for that device.
  2. **READ CAREFULLY** the description of each action card returned.
  3. If you find a matching action, call \`run_action_card(deviceName="...", cardId="...", args={...})\`.
- **Example**:
  - User: "Reset the energy meter on the socket"
  - Standard \`control_device\` has no "reset" capability.
  - Call \`list_device_actions\` → find card "Reset Meter" (id="reset_meter").
  - Call \`run_action_card(..., cardId="reset_meter")\`.

### **Camera & Image Analysis**
- **Taking snapshot and analyzing**: Use \`run_action_card\` with the camera's snapshot action card → the image will be automatically included in the result for visual analysis
- **Viewing current image**: Use \`get_device_image\` to retrieve the device's existing image without triggering a new snapshot
- **After receiving an image**: Describe what you see to the user (people, objects, situation, colors, activity, etc.)
- **Typical workflow**:
  1. User asks: "What does the camera see?" or "Take a snapshot of the front door"
  2. If new snapshot needed: \`list_device_actions(deviceName="Camera")\` → find snapshot action card
  3. \`run_action_card(deviceName="Camera", cardId="...")\` → triggers snapshot + receives image
  4. Analyze the image and describe it naturally to the user
  5. If just viewing: \`get_device_image(deviceName="Camera")\` → gets current image

### **Device Discovery & Error Handling**
- **NEVER GUESS OR ASSUME** a device does not exist without checking.
- **Rule of Thumb**: If the user mentions a device (e.g. "Gate", "Fan", "Heater") and you don't have its ID in your immediate context, you **MUST** call \`list_devices_in_zone\` (if room is known) or \`list_all_devices\` **BEFORE** saying it doesn't exist.
- **Fuzzy Matching**: User might say "Kitchen Light" but the device is named "Luce Cucina". You must use \`list_all_devices\` or \`list_devices_in_zone\` to find the closest match.
- **FINAL FALLBACK**: If \`list_all_devices\` or \`list_devices_in_zone\` fail to find the device, you **MUST** call \`search_devices(query="...")\` with synonyms and multi-language keywords (e.g., "gate, cancello, door, porta") as a last resort **BEFORE** giving up.
- **Retry Strategy**: If a function call fails, **try alternative approaches** before giving up.
- Only if \`search_devices\` also fails, then ask the user for the exact name.

### **Response Style**
- Always provide **clear, natural language responses** after executing functions.
- Be **concise but friendly** in your responses.
- Confirm what you did: "OK, I turned on the kitchen lights." or "The living room temperature is 22°C."

---

## Examples

### Home Automation (USE FUNCTIONS):
- "Turn on the lights" → Call \`list_devices_in_zone\` or \`list_all_devices\`, then \`control_device\`
- "What's the temperature in the bedroom?" → Call \`get_device_state\`
- "Are there lights on in the kitchen?" → Call \`get_devices_status_by_class\`
- "Start the washing machine" → Call \`control_device\`

### General Questions (RESPOND CONVERSATIONALLY):
- "What's the weather in Modena?" → Respond directly with general knowledge
- "Tell me a joke" → Respond conversationally
- "What time is it in Tokyo?" → Calculate and respond
- "Who won the 2006 World Cup?" → Respond with general knowledge

### Scheduling Commands
- User says: "turn on lights at 20:00"
- You use: 20:00 local time directly
- You call: \`schedule_command(executeAt="2026-02-08T20:00:00", ...)\`
    
**Remember:** Work in local time only - the system converts to UTC automatically.
`;
}

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

    this.mcpAdapter = this.homey ? new HomeyMCPAdapter(this.homey) : null;
    this.mcpModel = null;

    // Conversation history for multi-call memory
    // Each entry: { timestamp: Date, content: object }
    this.conversationHistory = [];

    console.log(`[GeminiClient] Initialized with Smart Home Model: ${this.smartHomeModel}, Chat Model: ${this.chatModel}`);
  }

  /**
   * Helper method to retry requests on 429 (Resource Exhausted) errors
   * @private
   * @param {Function} apiCallFn - The async function to execute
   * @param {string} operationName - Name of the operation for logging
   * @returns {Promise<any>} Result of the API call
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

        // Check if error is 429 / Quota Exceeded / Resource Exhausted
        const isQuotaError = errorStr.includes('429') ||
          errorStr.includes('quota') ||
          errorStr.includes('resource_exhausted') ||
          errorDetails.includes('429') ||
          errorDetails.includes('resource_exhausted');

        if (!isQuotaError || retries >= MAX_RETRIES) {
          throw error;
        }

        // Determine wait time
        let waitTimeMs = 2000 * Math.pow(2, retries); // Default exponential backoff: 2s, 4s

        // Try to parse "retry in X s" from error message
        // Example: "Please retry in 36.223707311s."
        const retryMatch = errorStr.match(/retry in ([0-9.]+)\s?s/);
        if (retryMatch && retryMatch[1]) {
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
   * Clears conversation history entries older than TTL and trims to max size.
   * Called automatically before each generateTextWithMCP call.
   * @private
   * @returns {void}
   */
  _pruneConversationHistory() {
    const now = Date.now();
    const cutoffTime = now - CONVERSATION_HISTORY_TTL_MS;

    // Remove entries older than TTL
    const beforeCount = this.conversationHistory.length;
    this.conversationHistory = this.conversationHistory.filter(
      entry => entry.timestamp >= cutoffTime
    );
    const afterTTL = this.conversationHistory.length;

    // Trim to max size (keep most recent)
    if (this.conversationHistory.length > CONVERSATION_HISTORY_MAX_MESSAGES) {
      this.conversationHistory = this.conversationHistory.slice(-CONVERSATION_HISTORY_MAX_MESSAGES);
    }

    if (beforeCount !== this.conversationHistory.length) {
      console.log(`[GeminiClient] Pruned conversation history: ${beforeCount} → ${this.conversationHistory.length} entries (TTL removed: ${beforeCount - afterTTL}, max-size trimmed: ${afterTTL - this.conversationHistory.length})`);
    }
  }

  /**
   * Adds a message to the conversation history with current timestamp.
   * @private
   * @param {object} content - The message content object (role + parts)
   * @returns {void}
   */
  _addToConversationHistory(content) {
    this.conversationHistory.push({
      timestamp: Date.now(),
      content: content
    });
  }

  /**
   * Gets the current conversation history as an array of content objects.
   * @private
   * @returns {object[]} Array of content objects for the Gemini API
   */
  _getConversationHistoryContents() {
    return this.conversationHistory.map(entry => entry.content);
  }

  /**
   * Clears the entire conversation history.
   * Can be called externally to reset the conversation.
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
   * Seed the conversation history with a context message.
   * Injects the message as a model turn so that subsequent user commands
   * have immediate conversational context (e.g., Gemini "asked" something
   * and the user can reply in the next MCP command).
   * The injected message follows the same TTL / max-messages rules as any
   * other message in the conversation history.
   * @public
   * @param {string} contextMessage - The context / question to inject
   * @returns {void}
   */
  seedConversationContext(contextMessage) {
    if (!contextMessage || typeof contextMessage !== 'string') {
      console.warn('[GeminiClient] seedConversationContext called with invalid message');
      return;
    }

    this._addToConversationHistory({
      role: 'model',
      parts: [{ text: contextMessage }]
    });

    console.log(`[GeminiClient] Conversation context seeded (${this.conversationHistory.length} total messages)`);
  }

  async generateText(prompt) {
    console.log("Generating text with prompt:", prompt);

    return this._retryableRequest(async () => {
      const response = await this.genAI.models.generateContent({
        model: this.chatModel,
        contents: prompt
      });
      return response.text;
    }, 'generateText');
  }

  /**
   * Generates text from a multimodal prompt (text + image).
   * @param {string} textPrompt The text prompt to send.
   * @param {Buffer} imageBuffer The image as a Buffer.
   * @param {string} mimeType The MIME type of the image (e.g., 'image/jpeg', 'image/png').
   * @returns {Promise<string>} The generated text response.
   */
  async generateTextWithImage(textPrompt, imageBuffer, mimeType = 'image/jpeg') {
    console.log("Generating text with image, prompt:", textPrompt);
    console.log("Image buffer size:", imageBuffer.length, "bytes, mimeType:", mimeType);

    // Convert Buffer to Base64
    const base64Image = imageBuffer.toString('base64');

    // Build multimodal content array
    // Tip from Gemini docs: place text prompt after the image for best results with single image
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
   * Helper to convert a readable stream to a Buffer.
   * @param {import('stream').Readable} stream The readable stream.
   * @returns {Promise<Buffer>} The buffer containing the stream data.
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
  * @param {string} prompt The description of the image to generate.
  * @returns {string} The Base64 string of the generated image (the token).
  */
  async generateImage(prompt) {
    console.log("Generating image with Gemini (text-to-image) for prompt:", prompt);

    try {
      console.log("Calling Gemini image generation API...");

      // Use image generation model for text-to-image generation (requires paid tier)
      // Use image generation model for text-to-image generation (requires paid tier)
      const response = await this._retryableRequest(async () => {
        return await this.genAI.models.generateContent({
          model: GEMINI_IMAGE_MODEL,
          contents: prompt,
        });
      }, 'generateImage');

      console.log("Gemini API response received");

      // Extract the image from the response
      // The response contains parts which can be text or inlineData (images)
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

      console.log("Image generated successfully, bytes length:", base64ImageBytes.length);

      // Return the Base64 string
      return base64ImageBytes;
    } catch (error) {
      console.error("Error generating image with Gemini:", error);
      throw error;
    }
  }

  /**
   * Generates an image and returns it as a Readable stream.
   * @param {string} prompt The description of the image to generate.
   * @returns {Promise<Readable>} A Readable stream of the generated image.
   */
  async generateImageStream(prompt) {
    console.log("generateImageStream called");
    const base64Image = await this.generateImage(prompt);
    console.log("Converting base64 to buffer...");
    const imageBuffer = Buffer.from(base64Image, 'base64');
    console.log("Buffer created, size:", imageBuffer.length, "bytes");
    const stream = Readable.from(imageBuffer);
    console.log("Stream created");
    return stream;
  }

  /**
   * Generate text with MCP function calling support (multi-turn loop)
   * Uses ANY mode to force function calling until an action succeeds,
   * then switches to NONE (no tools) to allow final text response.
   * @param {string} prompt - User command/prompt
   * @returns {Promise<{response: string, success: boolean}>} - Response text and success status
   */
  async generateTextWithMCP(prompt) {
    if (!this.mcpAdapter) {
      throw new Error("MCP Adapter not available. Homey instance is required.");
    }

    console.log(`[MCP] User command: "${prompt}"`);

    // Get current date/time for context (crucial for schedule_command)
    const now = new Date();
    const currentDateTime = now.toISOString();

    // Detect user's timezone automatically
    let userTimezone = 'UTC';
    try {
      // Try to get Homey's configured timezone
      userTimezone = this.homey?.clock?.getTimezone?.() || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch (e) {
      // Fallback to system timezone detection
      userTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    }

    // Calculate timezone offset using Homey's timezone (not system timezone)
    // Use a more reliable method to get the offset
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: userTimezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZoneName: 'shortOffset'
    });

    const parts = formatter.formatToParts(now);
    const offsetPart = parts.find(part => part.type === 'timeZoneName');

    // If we can get the offset directly from formatToParts, use it
    let timezoneOffset = '+00:00';
    if (offsetPart && offsetPart.value && offsetPart.value.startsWith('GMT')) {
      // Extract offset from "GMT+1" or "GMT-5" format
      const offsetMatch = offsetPart.value.match(/GMT([+-])(\d+)/);
      if (offsetMatch) {
        const sign = offsetMatch[1];
        const hours = parseInt(offsetMatch[2], 10);
        timezoneOffset = `${sign}${String(hours).padStart(2, '0')}:00`;
      }
    } else {
      // Fallback: calculate offset manually
      const utcDate = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
      const tzDate = new Date(now.toLocaleString('en-US', { timeZone: userTimezone }));
      const diffMs = tzDate.getTime() - utcDate.getTime();
      const diffHours = Math.round(diffMs / 3600000);
      const sign = diffHours >= 0 ? '+' : '-';
      const absHours = Math.abs(diffHours);
      timezoneOffset = `${sign}${String(absHours).padStart(2, '0')}:00`;
    }

    // Format local time in user's timezone
    const localDateTime = now.toLocaleString('en-US', {
      timeZone: userTimezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });

    // Get Homey's configured language
    const homeyLanguage = this.homey?.i18n?.getLanguage?.() || 'en';

    // Build system instruction with current date/time context
    const systemInstructionWithContext = buildSystemInstruction(
      now,
      userTimezone,
      localDateTime,
      timezoneOffset,
      homeyLanguage
    );

    // Log date/time context for debugging schedule commands
    console.log('[MCP] System Instruction Date/Time Context:');
    console.log(`[MCP]   Local: ${localDateTime} (${userTimezone})`);
    console.log(`[MCP]   Offset: UTC${timezoneOffset}`);
    console.log(`[MCP]   Language: ${homeyLanguage}`);

    // Get tools from MCP adapter
    const toolsList = await this.mcpAdapter.listTools();
    console.log(`[MCP] Available tools: ${toolsList.tools.length}`);
    const functionDeclarations = toolsList.tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema
    }));

    // Prune old messages from conversation history (TTL + max size)
    this._pruneConversationHistory();

    // Get existing conversation history for chat initialization
    const existingHistory = this._getConversationHistoryContents();
    console.log(`[MCP] Persistent conversation history: ${existingHistory.length} messages`);

    // Create chat session with configuration and existing history
    // Chat API automatically manages conversation history for this session
    const chatConfig = {
      systemInstruction: systemInstructionWithContext,
      // Best practice: Use low temperature (0) for most models for deterministic function calling,
      // but keep default (1.0) for Gemini 3 models to avoid looping/degradation.
      temperature: this.smartHomeModel.includes('gemini-3') ? 1.0 : 0,
      tools: [{ functionDeclarations: functionDeclarations }],
      toolConfig: {
        functionCallingConfig: {
          mode: FunctionCallingConfigMode.AUTO  // Let Gemini decide when to use functions
        }
      }
    };

    const chat = this.genAI.chats.create({
      model: this.smartHomeModel,
      config: chatConfig,
      history: existingHistory  // Initialize with persistent history
    });

    console.log(`[MCP] Chat session created with AUTO mode`);

    const MAX_TURNS = 15;
    let turnCount = 0;
    let capturedTimerId = null;  // Track timer ID if schedule_command is called

    // Send initial user message
    console.log(`[MCP] Turn 1: Sending user message`);
    let response = await this._retryableRequest(async () => {
      return await chat.sendMessage({ message: prompt });
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

      // Execute function calls
      // Following Google's best practice: execute multiple independent function calls in parallel
      console.log(`[MCP] Executing ${functionCalls.length} function(s):`);
      if (functionCalls.length > 1) {
        console.log(`[MCP] Parallel execution: ${functionCalls.length} functions`);
      }

      // Execute all function calls in parallel using Promise.all
      // Best practice: Execute multiple independent functions in parallel
      // Reference: https://ai.google.dev/gemini-api/docs/function-calling#parallel-function-calling
      const functionPromises = functionCalls.map(async (call) => {
        console.log(`[MCP]   calling ${call.name}(${JSON.stringify(call.args)})`);

        try {
          const result = await this.mcpAdapter.callTool(call.name, call.args);
          // Create a safe version for logging (exclude large image data)
          const logResult = { ...result };
          if (logResult._imageData) {
            delete logResult._imageData;
            logResult._hasImage = true;
          }
          const resultStr = JSON.stringify(logResult);
          console.log(`[MCP]   ${result.success ? 'OK' : 'FAIL'} ${call.name}: ${resultStr}`);

          return {
            call,
            result,
            success: result.success === true
          };
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
      });

      // Wait for all function calls to complete
      const executedFunctions = await Promise.all(functionPromises);

      // Process results and build response array
      const functionResponses = [];
      for (const { call, result, success } of executedFunctions) {
        // Capture timer ID if schedule_command was called
        if (success && call.name === 'schedule_command' && result.scheduleId) {
          capturedTimerId = result.scheduleId;
          console.log(`[MCP]   Captured timer ID: ${capturedTimerId}`);
        }

        // Check if result contains image data (multimodal function response)
        if (success && result._hasImage && result._imageData && result._imageMimeType) {
          console.log(`[MCP]   Function returned image, building multimodal response`);

          // Create clean result without internal _ fields
          const cleanResult = { ...result };
          const imageBase64 = cleanResult._imageData;
          const mimeType = cleanResult._imageMimeType;
          delete cleanResult._imageData;
          delete cleanResult._imageMimeType;
          delete cleanResult._hasImage;

          // Add image reference to response
          cleanResult.image_info = "Image attached for visual analysis";

          // Build multimodal function response with image in parts
          functionResponses.push({
            functionResponse: {
              name: call.name,
              response: cleanResult,
              parts: [{
                inlineData: {
                  data: imageBase64,
                  mimeType: mimeType,
                  displayName: "snapshot"
                }
              }]
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

      // Check if we're about to exceed max turns
      if (turnCount >= MAX_TURNS) {
        console.log(`[MCP] ERROR: Max turns (${MAX_TURNS}) reached`);
        await this._syncChatToPersistentHistory(chat);
        return {
          response: this.homey.__('prompt.error.max_turns_reached'),
          success: false,
          timerId: capturedTimerId
        };
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
    console.log(`[MCP] ERROR: Exited loop at turn ${turnCount}`);
    await this._syncChatToPersistentHistory(chat);
    return {
      response: this.homey.__('prompt.error.max_turns_reached'),
      success: false,
      timerId: capturedTimerId
    };
  }

  /**
   * Synchronize chat history to persistent conversation history
   * @private
   * @param {Chat} chat - Chat instance
   */
  async _syncChatToPersistentHistory(chat) {
    try {
      const chatHistory = await chat.getHistory();
      // Clear existing persistent history and replace with chat history
      // This ensures thought signatures and all context are preserved
      this.conversationHistory = chatHistory.map(content => ({
        timestamp: Date.now(),
        content: content
      }));
      console.log(`[MCP] Synced ${chatHistory.length} messages to persistent history`);
    } catch (error) {
      console.error('[MCP] ERROR: Failed to sync chat history:', error.message);
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


}

module.exports = { GeminiClient };
