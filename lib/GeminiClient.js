const { GoogleGenAI, FunctionCallingConfigMode } = require('@google/genai');
const { Readable } = require('stream');
const { HomeyMCPAdapter } = require('./HomeyMCPAdapter');

// Gemini model configuration
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-lite";      // Default main model for text/multimodal
const GEMINI_IMAGE_MODEL = "gemini-2.5-flash-image";   // Model for image generation

/**
 * Builds system instruction with dynamic date/time context for the smart home assistant.
 * @private
 * @param {Date} now - Current date/time
 * @param {string} userTimezone - User's timezone (e.g., 'Europe/Rome')
 * @param {string} localDateTime - Formatted local date/time string
 * @param {string} timezoneOffset - Timezone offset in format '+01:00' or '-05:00'
 * @returns {string} Complete system instruction with date/time context
 */
function buildSystemInstruction(now, userTimezone, localDateTime, timezoneOffset) {
  return `
    # Smart Home Assistant

    ## Your Role
    You are a helpful smart home assistant that helps users control their Homey devices and flows.

    **Core Capabilities:**
    - Control devices (lights, thermostats, switches, etc.)
    - Query device status and information
    - Trigger automation flows
    - Answer questions about the home state
    - Execute scheduled commands at specified times

    ## Guidelines

    **Device Discovery:**
    - Don't guess device names. If a device is not found, ALWAYS use \`list_devices_in_zone\` or \`list_all_devices\` to find the exact name.
    - When users mention room names (e.g., "studio", "camera"), use \`list_devices_in_zone\` with the zone name first.

    **Status Queries:**
    - For queries like "which lights are on?", use \`get_devices_status_by_class\` with \`deviceClass="light"\`.
    - For zone-specific queries like "lights on in kitchen?", use \`get_devices_status_by_class\` with both \`deviceClass\` and \`zone\` parameters.

    **Error Handling:**
    - If a function call fails, try alternative approaches before giving up. Never give up after just one failure.

    **Response Style:**
    - Always provide clear, natural language responses after executing functions.
    - Be concise but friendly in your responses.

    ---

    ## Current Date/Time Context

    **RIGHT NOW:**
    - **UTC:** ${now.toISOString()}
    - **Local (${userTimezone}):** ${localDateTime}
    - **Timezone:** ${userTimezone} (UTC${timezoneOffset})

    ---

    ## Scheduling Commands

    When user wants to schedule something using the \`schedule_command\` tool:

    1. User specifies times in **LOCAL time** (${userTimezone})
    2. Convert the LOCAL time to **UTC time** with Z suffix (\`YYYY-MM-DDTHH:MM:SSZ\`)
    3. Pass the UTC timestamp to the \`executeAt\` parameter

    **Example:**
    - User says: "turn on lights at 20:00"
    - You convert: 20:00 ${userTimezone} → UTC timestamp
    - You call: \`schedule_command(executeAt="2026-01-24T19:00:00Z", ...)\`
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
    this.modelName = options.modelName || DEFAULT_GEMINI_MODEL;
    this.mcpAdapter = this.homey ? new HomeyMCPAdapter(this.homey) : null;
    this.mcpModel = null;

    console.log(`[GeminiClient] Initialized with model: ${this.modelName}`);
  }

  async generateText(prompt) {
    console.log("Generating text with prompt:", prompt);

    const response = await this.genAI.models.generateContent({
      model: this.modelName,
      contents: prompt
    });
    return response.text;
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

    const response = await this.genAI.models.generateContent({
      model: this.modelName,
      contents: contents,
    });

    return response.text;
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
      const response = await this.genAI.models.generateContent({
        model: GEMINI_IMAGE_MODEL,
        contents: prompt,
      });

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
    const utcTime = now.getTime();
    const localTime = new Date(now.toLocaleString('en-US', { timeZone: userTimezone })).getTime();
    const timezoneOffsetMs = localTime - utcTime;
    const offsetHours = timezoneOffsetMs / 3600000;
    const offsetMinutes = Math.abs((timezoneOffsetMs % 3600000) / 60000);

    // Calculate timezone offset in standard format (+01:00, -05:00, etc.)
    const offsetSign = offsetHours >= 0 ? '+' : '-';
    const absOffsetHours = Math.abs(Math.floor(offsetHours));
    const timezoneOffset = `${offsetSign}${String(absOffsetHours).padStart(2, '0')}:${String(offsetMinutes).padStart(2, '0')}`;

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

    // Build system instruction with current date/time context
    const systemInstructionWithContext = buildSystemInstruction(
      now,
      userTimezone,
      localDateTime,
      timezoneOffset
    );

    // Get tools from MCP adapter
    const toolsList = await this.mcpAdapter.listTools();
    console.log(`[MCP] Available tools: ${toolsList.tools.length}`);
    const functionDeclarations = toolsList.tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema
    }));

    // Build conversation history
    const contents = [
      { role: "user", parts: [{ text: prompt }] }
    ];

    // Track different types of successes
    let hasDeviceAction = false;      // control_device or trigger_flow succeeded
    let hasInformativeAction = false; // informative query succeeded

    // Dispositive actions that modify device states or trigger automations
    const dispositiveActions = ['control_device', 'trigger_flow', 'schedule_command'];

    // Informative actions that retrieve information to answer the user's question
    // These trigger AUTO mode because they provide the final answer
    const informativeActions = [
      // 'get_lights_status',  // Commented out - use get_devices_status_by_class instead
      'get_devices_status_by_class',
      'get_device_count_by_zone',
      'get_device_state'
    ];

    // Discovery/support tools that help find information but don't answer the question directly
    // These do NOT trigger AUTO mode - they're intermediate steps
    // Examples: get_device_class_info, list_zones, list_devices, list_devices_in_zone

    const MAX_TURNS = 15;
    let turnCount = 0;
    let capturedTimerId = null;  // Track timer ID if schedule_command is called

    while (turnCount < MAX_TURNS) {
      turnCount++;

      // Determine mode based on action type:
      // - If device action succeeded → AUTO (allow final response)
      // - If only informative action succeeded and 2+ turns passed → AUTO (allow final response)
      // - Otherwise → ANY (keep searching for actions)
      const shouldSwitchToAuto = hasDeviceAction ||
        (hasInformativeAction && turnCount >= 2);

      const callingMode = shouldSwitchToAuto
        ? FunctionCallingConfigMode.AUTO  // Allow text or function calls
        : FunctionCallingConfigMode.ANY;   // Force function calls

      console.log(`[MCP] Turn ${turnCount}: mode=${shouldSwitchToAuto ? 'AUTO' : 'ANY'}, hasDeviceAction=${hasDeviceAction}, hasInformativeAction=${hasInformativeAction}`);

      // Call API with conversation history
      const apiConfig = {
        systemInstruction: systemInstructionWithContext,  // Use datetime-enhanced instruction
        // Best practice: Use low temperature (0) for most models for deterministic function calling,
        // but keep default (1.0) for Gemini 3 models to avoid looping/degradation.
        temperature: this.modelName.includes('gemini-3') ? 1.0 : 0,
        tools: [{ functionDeclarations: functionDeclarations }],
        toolConfig: {
          functionCallingConfig: {
            mode: callingMode  // ANY or AUTO depending on state
          }
        }
      };

      console.log(`[MCP] Calling generateContent with mode=${callingMode}, history_length=${contents.length}`);

      const response = await this.genAI.models.generateContent({
        model: this.modelName,
        contents: contents,
        config: apiConfig
      });

      const candidate = response.candidates?.[0];
      if (!candidate?.content?.parts) {
        console.log("[MCP] WARN: Empty response from API (no parts in content)");
        // Log the response for debugging
        console.log("[MCP] Response object:", JSON.stringify(response, null, 2));

        // If we had a successful device action but got empty response, that's actually OK
        // The model just chose not to say anything - we can provide a default success message
        if (hasDeviceAction) {
          console.log("[MCP] Device action was successful, returning default success message");
          return {
            response: this.homey.__('prompt.action_completed'),  // Localized "Done." / "Fatto."
            success: true,
            timerId: capturedTimerId
          };
        }

        // For informative actions, empty response is problematic
        if (hasInformativeAction) {
          return {
            response: this.homey.__('prompt.empty_response'),
            success: false,
            timerId: capturedTimerId
          };
        }

        // No action was taken yet - this is unexpected
        return {
          response: response.text || "No response generated.",
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

      // Note: Gemini 3 requires thoughtSignature to be preserved in multi-turn function calling.\n      // The SDK 1.38.0+ handles this automatically by including thoughtSignature in candidate.content.parts.

      // Add model response to history
      contents.push(candidate.content);

      // Check for function calls
      const functionCalls = response.functionCalls || [];

      if (functionCalls.length === 0) {
        // No function calls - return final text
        if (shouldSwitchToAuto) {
          console.log(`[MCP] Final response generated after ${turnCount} turn(s)`);
          const finalResponse = response.text || "Operation completed successfully.";
          return {
            response: finalResponse,
            // Success if we got a meaningful response (not empty/default)
            success: response.text && response.text.length > 0,
            timerId: capturedTimerId
          };
        } else {
          // Should not happen with ANY mode, but handle gracefully
          // Give one more chance by switching to AUTO mode
          console.log(`[MCP] WARN: No function calls in ANY mode, turn=${turnCount}, giving one more chance with AUTO`);
          if (turnCount < MAX_TURNS) {
            hasDeviceAction = true; // Force switch to AUTO for final attempt
            continue;
          }
          return {
            response: response.text || "Unable to complete the requested action.",
            success: false,
            timerId: capturedTimerId
          };
        }
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
          const resultStr = JSON.stringify(result);
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
        // Track different types of successes
        if (success) {
          if (dispositiveActions.includes(call.name)) {
            hasDeviceAction = true;
            console.log(`[MCP]   SUCCESS: Device action ${call.name}`);
          } else if (informativeActions.includes(call.name)) {
            hasInformativeAction = true;
            console.log(`[MCP]   SUCCESS: Informative action ${call.name}`);
          }

          // Capture timer ID if schedule_command was called
          if (call.name === 'schedule_command' && result.scheduleId) {
            capturedTimerId = result.scheduleId;
            console.log(`[MCP]   Captured timer ID: ${capturedTimerId}`);
          }
        }

        functionResponses.push({
          functionResponse: {
            name: call.name,
            response: result
          }
        });
      }

      // Add function responses to history
      contents.push({
        role: "function",
        parts: functionResponses
      });
      console.log(`[MCP] Added ${functionResponses.length} function result(s) to history for next turn`);

      // Continue loop to let model see results
    }

    console.log(`[MCP] ERROR: Max turns (${MAX_TURNS}) reached`);
    return {
      response: "Operation partially completed. Maximum interaction limit reached.",
      success: false,
      timerId: capturedTimerId
    };
  }

  /* ============================================================================
   * NOTE: Automatic Function Calling (AFC) 
   * ============================================================================
   * AFC is a Python SDK-only feature that is NOT available in JavaScript/Node.js.
   * 
   * From the official documentation:
   * "Automatic function calling is a Python SDK feature only."
   * 
   * The manual loop implementation in generateTextWithMCP() is the correct and
   * only approach for JavaScript, following Google's documented patterns for
   * multi-turn function calling in non-Python SDKs.
   * 
   * Reference: https://ai.google.dev/gemini-api/docs/function-calling
   * ============================================================================
   */


}

module.exports = { GeminiClient };
