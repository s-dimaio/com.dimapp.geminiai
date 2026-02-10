'use strict';

const { HomeyAPIV3Local } = require('homey-api');
const { Type } = require('@google/genai');
const fs = require('fs');
const path = require('path');

/**
 * HomeyMCPAdapter
 * 
 * Adapter that exposes Homey functionality in MCP (Model Context Protocol) format.
 * This allows Gemini to interact with Homey devices and flows using standardized tools.
 */
class HomeyMCPAdapter {
  constructor(homey) {
    this.homey = homey;
    this.api = null;

    // Load reference files for validation and suggestions
    try {
      const classesPath = path.join(__dirname, 'homey_device_classes.json');
      this.deviceClasses = JSON.parse(fs.readFileSync(classesPath, 'utf8'));
    } catch (error) {
      this.homey.log('Warning: Could not load reference files:', error.message);
      this.deviceClasses = { classes: {} };
    }

    // Periodic checker will start only if needed for schedules > 24h
    this._schedulerInterval = null;
    this._scheduledTimeouts = new Map(); // Track active setTimeout IDs
  }

  /**
   * Initialize HomeyAPI instance
   * Must be called before using any device/zone/flow methods
   */
  async initialize() {
    if (!this.api) {
      // Cache session token and URL for HomeyScript proxy calls
      this._sessionToken = await this.homey.api.getOwnerApiToken();
      this._localUrl = await this.homey.api.getLocalUrl();

      // Create HomeyAPIV3Local instance for reading devices/zones/flows
      this.api = new HomeyAPIV3Local({
        token: this._sessionToken,
        baseUrl: this._localUrl,
        strategy: [],
        properties: {
          id: await this.homey.cloud.getHomeyId(),
          softwareVersion: this.homey.version,
        },
      });
    }
  }

  /**
   * List all available tools in MCP format
   * @returns {Promise<Object>} Object with tools array
   */
  async listTools() {
    return {
      tools: [
        {
          name: "control_device",
          description: `
                    Control a Homey device by changing a capability value.

                    **Use this to:**
                    - Turn devices on/off
                    - Adjust brightness
                    - Set temperature
                    - Change volume

                    **Examples:**
                    - Turn light on: \`capability='onoff'\`, \`value=true\`
                    - Dim to 50%: \`capability='dim'\`, \`value=0.5\`
                    - Set thermostat to 21°C: \`capability='target_temperature'\`, \`value=21\`

                    **Important:** You must use exact device name and correct capability name.
                    **Fallback:** If the specific command is not available here (e.g. "reset", "start program"), check \`list_device_actions\`.`,
          inputSchema: {
            type: "object",
            properties: {
              deviceName: {
                type: Type.STRING,
                description: "Exact device name (e.g., 'Living Room Light', 'Daikin Studio', 'Bedroom Thermostat'). Must match device name exactly. Use list_devices_in_zone if you don't know the exact name."
              },
              capability: {
                type: Type.STRING,
                description: "Capability to control. Common values: 'onoff' (true/false for on/off), 'dim' (0.0-1.0 for brightness), 'target_temperature' (number in degrees), 'volume_set' (0.0-1.0 for volume), 'windowcoverings_state' ('up'/'idle'/'down'). Check device state first to see available capabilities."
              },
              value: {
                description: "Value to set. Type depends on capability: boolean for 'onoff' (true=on, false=off), number 0.0-1.0 for 'dim', number in degrees for 'target_temperature', string for 'windowcoverings_state' or 'thermostat_mode'."
              }
            },
            required: ["deviceName", "capability", "value"]
          }
        },
        {
          name: "trigger_flow",
          description: `
                    Trigger/execute a Homey Flow (automation).

                    **Use this to activate:**
                    - Scenes (e.g., 'Good Morning', 'Movie Time')
                    - Complex automations (e.g., 'Away Mode')

                    **Requirements:**
                    - Flow must exist in Homey
                    - Flow must be enabled
                    - You need the **exact flow name**`,
          inputSchema: {
            type: Type.OBJECT,
            properties: {
              flowName: {
                type: Type.STRING,
                description: "Exact name of the Flow to trigger (e.g., 'Good Morning', 'Evening Lights', 'Away Mode'). Flow name must match exactly as defined in Homey."
              },
              args: {
                type: Type.OBJECT,
                description: "Optional arguments/tokens to pass to the flow (for Advanced Flows with arguments). Key-value pairs."
              }
            },
            required: ["flowName"]
          }
        },
        {
          name: "get_device_state",
          description: `
                    **REQUIRED** to check the current state of any Homey device.

                    **Use this for:**
                    - Check if light is on/off
                    - Read current temperature
                    - Query any device capability value

                    **Important:** This is your ONLY way to read device states.`,
          inputSchema: {
            type: Type.OBJECT,
            properties: {
              deviceName: {
                type: Type.STRING,
                description: "Name of the device to query"
              }
            },
            required: ["deviceName"]
          }
        },
        {
          name: "list_flows",
          description: `
                    **REQUIRED** to discover and list all Homey Flows (automations).

                    **Use this when:**
                    - User asks "what flows do I have?", "list my automations"
                    - You need to find flow names before calling \`trigger_flow\`
                    - User wants to see enabled/disabled flows
                    - User asks about flows in a specific folder

                    **Flow Types:**
                    - **Standard Flow**: Traditional when-and-then flows
                    - **Advanced Flow**: Visual canvas-based flows (Homey Pro only)

                    **Filters available:**
                    - \`enabled\`: true (only active flows), false (only disabled flows), or omit for all
                    - \`folder\`: folder name to filter by specific folder
                    - \`type\`: 'standard', 'advanced', or 'all' (default: 'all')

                    **Returns:**
                    - List of flows with: name, id, enabled status, folder, type
                    - Summary counts by type and status

                    **Examples:**
                    - "List all flows" → \`list_flows()\`
                    - "Show enabled flows" → \`list_flows({ enabled: true })\`
                    - "Show Advanced Flows" → \`list_flows({ type: 'advanced' })\``,
          inputSchema: {
            type: Type.OBJECT,
            properties: {
              enabled: {
                type: Type.BOOLEAN,
                description: "Optional filter: true for enabled flows only, false for disabled flows only. Omit to show all flows."
              },
              folder: {
                type: Type.STRING,
                description: "Optional filter: folder name to show only flows in that folder."
              },
              type: {
                type: Type.STRING,
                description: "Optional filter: 'standard' for standard flows, 'advanced' for Advanced Flows, 'all' for both (default: 'all').",
                enum: ["standard", "advanced", "all"]
              }
            },
            required: []
          }
        },
        {
          name: "get_flow_info",
          description: `
                    Get detailed information about a specific Homey Flow.

                    **Use this when:**
                    - User asks "tell me about the X flow"
                    - You need to check if a flow exists before triggering it
                    - User wants details about a specific automation

                    **Searches in:**
                    - Standard Flows
                    - Advanced Flows

                    **Returns:**
                    - Flow name, id, enabled status
                    - Flow type (standard or advanced)
                    - Folder location
                    - Additional metadata

                    **Important:** If flow not found, suggests similar flow names.`,
          inputSchema: {
            type: Type.OBJECT,
            properties: {
              flowName: {
                type: Type.STRING,
                description: "Name of the flow to get information about (e.g., 'Good Morning', 'Movie Time'). Case-insensitive search."
              }
            },
            required: ["flowName"]
          }
        },
        {
          name: "list_devices_in_zone",
          description: `
                    Get detailed list of all devices in a specific zone/room.

                    **Use this when:**
                    - You need device names for \`control_device\`
                    - User asks "what devices are in the bedroom?"
                    - User asks "list kitchen devices"
                    - This tool searches recursively (includes sub-zones)

                    **Returns:**
                    - Exact device names
                    - Device classes
                    - Available capabilities
                    - Availability status

                    **Essential** for finding exact device names before calling \`control_device\`.`,
          inputSchema: {
            type: Type.OBJECT,
            properties: {
              zoneName: {
                type: Type.STRING,
                description: "Zone/room name to list devices from (e.g., 'Living Room', 'Kitchen', 'Bedroom', 'Studio', 'Camera di Camilla'). Case-insensitive."
              }
            },
            required: ["zoneName"]
          }
        },
        {
          name: "list_zones",
          description: `
                    Get list of all zones/rooms in the home with their hierarchy.

                    **Use this when:**
                    - User mentions a room name that might not exist
                    - You need to verify zone names before calling other functions

                    **Returns:**
                    - Zone names
                    - Zone IDs
                    - Parent zones (if any)`,
          inputSchema: {
            type: Type.OBJECT,
            properties: {},
            required: []
          }
        },
        {
          name: "list_all_devices",
          description: `
                    Get complete list of **ALL** devices in the entire home.

                    **Use this when user asks:**
                    - "List all devices"
                    - "What devices do I have?"
                    - "Show me everything"
                    - When you need to see all available device names at once

                    **Returns:**
                    - Every device with name, class, zone
                    - Capabilities
                    - Availability status`,
          inputSchema: {
            type: "object",
            properties: {},
            required: []
          }
        },
        {
          name: "list_devices_by_class",
          description: `
                    **REQUIRED** to filter and list all devices of a specific type/class.

                    **Use this when:**
                    - You need to find all devices of the same type
                    - User asks "show me all lights", "list thermostats"

                    **Available classes:**
                    \`light\`, \`socket\`, \`thermostat\`, \`lock\`, \`sensor\`, \`speaker\`, \`tv\`, \`fan\`, \`heater\`, \`camera\`, \`doorbell\`, \`blinds\`, \`curtain\`, \`sunshade\`, and more.`,
          inputSchema: {
            type: Type.OBJECT,
            properties: {
              deviceClass: {
                type: Type.STRING,
                description: "Device class to filter by. Common values: 'light' (all lights), 'socket' (all plugs), 'thermostat' (all thermostats), 'sensor' (all sensors), 'lock' (all locks), 'speaker' (all speakers), 'fan' (all fans), 'windowcoverings' (all window coverings), 'blinds', 'curtain', 'sunshade'"
              }
            },
            required: ["deviceClass"]
          }
        },

        {
          name: "get_devices_status_by_class",
          description: `
                    Get status of **ALL** devices of a specific class with complete state information. Can be filtered by zone.

                    **Use this for:**
                    - Class-wide status queries like "which lights are on?", "what's the lock status?"
                    - Zone-specific queries like "are there lights on in the kitchen?" (with \`zone='Kitchen'\`)
                    - This tool searches recursively (includes sub-zones)
                    - "What sockets are on?" (no zone parameter)

                    **Response Format (Conditional):**
                    
                    **IF all devices have \`onoff\` capability** (e.g., lights, sockets):
                    - Returns: \`summary\` with on/off counts, \`devicesOn\`, \`devicesOff\`
                    - Each device includes complete \`state\` object with all capability values
                    
                    **IF any device lacks \`onoff\`** (e.g., locks, sensors, thermostats):
                    - Returns: \`summary\` with total count only, \`devices\` array
                    - Each device includes complete \`state\` object with all capability values
                    - **Locks**: Check \`state.locked\` (true=locked, false=unlocked)
                    - **Sensors**: Check \`state.alarm_motion\`, \`state.alarm_contact\`, etc.
                    - **Thermostats**: Check \`state.target_temperature\`, \`state.measure_temperature\`
                    - **Window Coverings**: Check \`state.windowcoverings_state\`

                    **Always includes:**
                    - Zone names for each device
                    - **Complete \`state\` object** with ALL capability values
                    - **Capabilities list** for proper identification`,
          inputSchema: {
            type: Type.OBJECT,
            properties: {
              deviceClass: {
                type: Type.STRING,
                description: "Device class to query. Common values: 'light', 'socket', 'thermostat', 'fan', 'switch', 'camera', 'lock', 'speaker', 'sensor', 'airconditioning', 'heater'."
              },
              zone: {
                type: Type.STRING,
                description: "Optional zone/room name to filter results (e.g., 'Kitchen', 'Bedroom', 'Studio'). If omitted, returns devices from all zones."
              }
            },
            required: ["deviceClass"]
          }
        },
        {
          name: "get_device_count_by_zone",
          description: `
                    Get device count and status **SUMMARY** for a specific zone/room.

                    **Use this for counting and summary questions:**
                    - "How many lights in the bedroom?"
                    - "What's on in the kitchen?"
                    - "Are there lights on in the studio?"

                    **Returns Summary by Device Class (Conditional Format):**
                    
                    **IF all devices of a class have \`onoff\`** (e.g., lights, sockets):
                    - Returns: \`{ total: X, on: Y, off: Z }\`
                    
                    **IF any device lacks \`onoff\`** (e.g., locks, sensors, thermostats):
                    - Returns: \`{ total: X }\` (no on/off counts)
                    
                    **Example Response:**
                    \`\`\`
                    byClass: {
                      light: { total: 5, on: 2, off: 3 },  // All lights have onoff
                      lock: { total: 2 }                    // Locks don't have onoff
                    }
                    \`\`\`

                    **Important:** This is the correct tool when user mentions a specific room name for counting or summary.`,
          inputSchema: {
            type: Type.OBJECT,
            properties: {
              zone: {
                type: Type.STRING,
                description: "Zone/room name to get summary for (e.g., 'Living Room', 'Kitchen', 'Bedroom', 'Studio'). Required."
              }
            },
            required: ["zone"]
          }
        },
        {
          name: "get_device_class_info",
          description: `
                    Look up device class details or search for correct class name.

                    **Use this when:**
                    - User says plural or informal terms:
                      - "lights" → maps to \`light\`
                      - "plugs" → maps to \`socket\`
                      - "heating" → maps to \`thermostat\` or \`heater\`
                      - "air conditioning" → maps to \`airconditioning\`

                    **Returns:**
                    - Class details
                    - Common capabilities
                    - Icon information

                    **Essential** for translating user terms to Homey class names.`,
          inputSchema: {
            type: Type.OBJECT,
            properties: {
              className: {
                type: Type.STRING,
                description: "Exact device class name (e.g., 'light', 'socket', 'thermostat', 'airconditioning'). Use this if you know the exact class name."
              },
              searchTerm: {
                type: Type.STRING,
                description: "Search term to find matching classes (e.g., 'lights', 'plugs', 'heating', 'windows', 'air con'). Use this when translating user's words to class names."
              }
            }
          }
        },
        {
          name: "schedule_command",
          description: `
                    Schedule a command to be executed at a future time.

                    **Use this when user wants to perform an action later:**
                    - "Turn off lights at 5pm tomorrow"
                    - "Turn on heating in 30 minutes"
                    - "Set temperature to 21°C at 7am Monday"
                    - "Start washing machine in 2 hours"

                    **Features:**
                    - Supports scheduling up to **365 days** in advance
                    - Precise execution for times within 24 hours
                    - Command will be executed automatically at the specified time

                    **Format Requirements:**
                    - \`executeAt\` accepts time in **Homey's local timezone**
                    - Format: \`YYYY-MM-DDTHH:MM:SS\` (without timezone suffix)
                    - Calculate times naturally in local time - conversion is automatic`,
          inputSchema: {
            type: Type.OBJECT,
            properties: {
              command: {
                type: Type.STRING,
                description: "The natural language command to execute later (e.g., 'turn off all lights in living room', 'set thermostat to 20 degrees'). This will be processed through Gemini at execution time."
              },
              executeAt: {
                type: Type.STRING,
                description: "ISO 8601 datetime in LOCAL time (Homey's timezone), format: 'YYYY-MM-DDTHH:MM:SS' (e.g., '2026-02-08T22:00:00'). Pass the time in Homey's local timezone - the system will automatically convert to UTC internally. Current local time is provided in the system instructions."
              },
              description: {
                type: Type.STRING,
                description: "Human-readable description of what will happen (e.g., 'Turn off lights at 5pm tomorrow', 'Start heating in 30 minutes')."
              }
            },
            required: ["command", "executeAt", "description"]
          }
        },
        {
          name: "search_devices",
          description: `
                    Search for devices by matching keywords in their names.

                    **CRITICAL SEARCH INSTRUCTIONS:**
                    1.  **MULTI-LANGUAGE QUERY REQUIRED**: You **MUST** include search terms in **BOTH** English and User's Language.
                    2.  **FUZZY MATCHING (Refusi & Varianti)**: The system uses strict text matching. You MUST simulate fuzzy matching by providing:
                        *   **Common Typos**: (e.g. "light" -> "lght, lihgt, lite")
                        *   **Phonetic Variations**: (e.g. "Philips" -> "Phillips, Filips")
                        *   **Synonyms**: (e.g. "monitor" -> "display, screen, tv")
                    3.  **FORMAT**: Separate ALL keywords with commas.

                    *Example:* User asks for "Luce Cucina" (Italian):
                    *Query:* \`"luce, light, lamp, cucina, kitchen, kitch, cucin, cook, food"\`

                    **Use this when:**
                    - User describes a device function but device has a specific name.
                    - Broad class searches fail.
                    - You suspect a typo in the user's request.

                    **Returns:**
                    - Devices matching **ANY** of the provided keywords (case-insensitive partial match).`,
          inputSchema: {
            type: Type.OBJECT,
            properties: {
              query: {
                type: Type.STRING,
                description: "Comma-separated list of keywords in BOTH English and User's language (e.g. 'presence, motion, presenza, movimento')."
              }
            },
            required: ["query"]
          }
        },
        {
          name: "list_device_actions",
          description: `
                    List all specialized actions (Flow Cards) available for a specific device.

                    **Use this when:**
                    - User asks "what can I do with the [device]?"
                    - User wants to perform a specific action not covered by standard controls (e.g. "reset meter", "set specific mode")
                    - You need to find the card ID to use with \`run_action_card\`

                    **Returns:**
                    - List of action cards with IDs and required arguments.
                    - **CRITICAL:** You MUST read the \`title\` and \`description\` of each card to understand what it does.`,
          inputSchema: {
            type: Type.OBJECT,
            properties: {
              deviceName: {
                type: Type.STRING,
                description: "Exact name of the device to list actions for."
              }
            },
            required: ["deviceName"]
          }
        },
        {
          name: "run_action_card",
          description: `
                    Execute a specific Action Card on a device.
                    
                    **Use this when:**
                    - You want to execute a specific action found via \`list_device_actions\`
                    - User requests a device-specific command (e.g. "Reset energy meter on Socket A")

                    **Requirements:**
                    - You must have the \`cardId\` (from \`list_device_actions\`)
                    - You must provide any required arguments map`,
          inputSchema: {
            type: Type.OBJECT,
            properties: {
              deviceName: {
                type: Type.STRING,
                description: "Name of the device (used for context verification)"
              },
              cardId: {
                type: Type.STRING,
                description: "The unique ID of the action card to execute (get this from list_device_actions)"
              },
              args: {
                type: Type.OBJECT,
                description: "Map of arguments required by the card (e.g. { 'brightness': 0.5 }). Empty object if no args."
              }
            },
            required: ["deviceName", "cardId"]
          }
        }
      ]
    };
  }


  /**
   * Execute an MCP tool
   * @param {string} name - Tool name
   * @param {Object} args - Tool arguments
   * @returns {Promise<Object>} Execution result
   */
  async callTool(name, args) {
    try {
      // Ensure API is initialized before executing any tool
      await this.initialize();

      switch (name) {
        case "control_device":
          return await this.controlDevice(args.deviceName, args.capability, args.value);

        case "trigger_flow":
          return await this.triggerFlow(args.flowName, args.args);

        case "get_device_state":
          return await this.getDeviceState(args.deviceName);

        case "list_devices_in_zone":
          return await this.listDevicesInZone(args.zoneName);

        case "list_zones":
          return await this.listZones();

        case "list_all_devices":
          return await this.listAllDevices();

        case "list_devices_by_class":
          return await this.listDevicesByClass(args.deviceClass);

        // case "get_lights_status":
        //   return await this.getLightsStatus();

        case "get_devices_status_by_class":
          return await this.getDevicesStatusByClass(args.deviceClass, args.zone);

        case "get_device_count_by_zone":
          return await this.getDeviceCountByZone(args.zone);

        case "get_device_class_info":
          return await this.getDeviceClassInfo(args.className, args.searchTerm);

        case "schedule_command":
          return await this.scheduleCommand(args.command, args.executeAt, args.description);

        case "list_flows":
          return await this.listFlows(args.enabled, args.folder, args.type);

        case "get_flow_info":
          return await this.getFlowInfo(args.flowName);

        case "search_devices":
          return await this.searchDevices(args.query);

        case "list_device_actions":
          return await this.listDeviceActions(args.deviceName);

        case "run_action_card":
          return await this.runActionCard(args.deviceName, args.cardId, args.args);

        default:
          return {
            success: false,
            error: `Unknown tool: ${name}`
          };
      }
    } catch (error) {
      return {
        success: false,
        error: error.message,
        stack: error.stack
      };
    }
  }

  /**
   * Control a device by setting a capability value
   */
  async controlDevice(deviceName, capability, value) {
    // Validate required parameters
    if (!deviceName || deviceName === undefined) {
      return {
        success: false,
        error: "Missing required parameter 'deviceName'. Please specify which device to control."
      };
    }
    if (!capability || capability === undefined) {
      return {
        success: false,
        error: "Missing required parameter 'capability'. Common values: 'onoff', 'dim', 'target_temperature'."
      };
    }
    if (value === undefined || value === null) {
      return {
        success: false,
        error: "Missing required parameter 'value'. Specify the value to set (e.g., true/false, 0-1, temperature)."
      };
    }

    const devices = await this.api.devices.getDevices();
    const zones = await this.api.zones.getZones();

    // Try exact match (case-insensitive)
    let device = Object.values(devices).find(d =>
      d.name.toLowerCase() === deviceName.toLowerCase()
    );

    if (!device) {
      // Device not found - tell Gemini to call list function first
      return {
        success: false,
        error: `Device "${deviceName}" not found. You must call list_devices_in_zone or list_all_devices first to see the exact device names, then call control_device again with the exact name from that list.`,
        required_action: "Call list_devices_in_zone or list_all_devices to see available devices"
      };
    }

    // Check if capability exists
    if (!device.capabilitiesObj || !device.capabilitiesObj[capability]) {
      // Suggest similar capabilities
      const availableCaps = Object.keys(device.capabilitiesObj || {});
      const suggestion = this.suggestCapability(capability, availableCaps);

      return {
        success: false,
        error: `Capability "${capability}" not found on device "${deviceName}". You MUST now call list_device_actions("${deviceName}") to find the correct Action Card for this operation.`,
        availableCapabilities: availableCaps,
        suggestion: suggestion ? `Did you mean '${suggestion}'?` : null,
        required_action: `Call list_device_actions with deviceName="${deviceName}" to see available actions`
      };
    }

    // Validate capability value using reference data
    const validation = this.validateCapabilityValue(capability, value);
    if (!validation.valid) {
      return {
        success: false,
        error: validation.error,
        expectedType: validation.expectedType,
        expectedRange: validation.expectedRange
      };
    }

    // Convert value to appropriate type
    let convertedValue = value;
    if (capability === 'onoff') {
      convertedValue = value === 'true' || value === true;
    } else if (capability === 'dim' || capability === 'volume_set') {
      convertedValue = parseFloat(value);
    } else if (capability === 'target_temperature') {
      convertedValue = parseFloat(value);
    }

    // Set the capability value
    try {
      await device.setCapabilityValue(capability, convertedValue);
    } catch (error) {
      return {
        success: false,
        error: `Failed to set capability "${capability}" on "${deviceName}". This capability is read-only or requires a specific action. You MUST now call list_device_actions("${deviceName}") to find the correct Action Card.`,
        originalError: error.message,
        required_action: `Call list_device_actions with deviceName="${deviceName}" to see available actions`
      };
    }

    // Get zone name by ID lookup (zones already fetched at the top)
    let zoneName = "Unknown";
    if (device.zone && zones[device.zone]) {
      zoneName = zones[device.zone].name;
    }

    return {
      success: true,
      device: device.name,
      capability: capability,
      value: convertedValue,
      zone: zoneName,
      message: `Successfully set ${capability} to ${convertedValue} on ${device.name}`
    };
  }

  /**
   * Ensure HomeyScript proxy is ready.
   * Creates or retrieves a helper script in HomeyScript that we use to trigger flows.
   * HomeyScript's token has the 'homey.flow.start' scope that third-party apps lack.
   * Uses direct HTTP calls with owner token.
   * @returns {Promise<{scriptId: string}>}
   */
  async _ensureHomeyScriptProxy() {
    // Ensure API is initialized to get token/URL
    await this.initialize();

    // Create or find our helper script (once)
    if (!this._homeyScriptProxyId) {
      try {
        // List scripts via direct HTTP call
        const response = await fetch(`${this._localUrl}/api/app/com.athom.homeyscript/script`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${this._sessionToken}`,
            'Content-Type': 'application/json',
          },
        });

        if (!response.ok) {
          if (response.status === 404) {
            throw new Error('HomeyScript app is NOT installed. Please tell the user that HomeyScript must be installed from the Homey App Store to enable flow triggering and advanced device actions.');
          }
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const scripts = await response.json();
        const existing = Object.values(scripts).find(s => s.name === 'GeminiAI-FlowTrigger');
        if (existing) {
          this._homeyScriptProxyId = existing.id;
          this.homey.log('[HomeyMCPAdapter] Found existing HomeyScript proxy:', this._homeyScriptProxyId);
        }
      } catch (e) {
        // If it's our specific "NOT installed" error, rethrow it so it reaches Gemini
        if (e.message.includes('HomeyScript app is NOT installed')) {
          throw e;
        }
        this.homey.log('[HomeyMCPAdapter] Could not list HomeyScript scripts:', e.message);
      }

      if (!this._homeyScriptProxyId) {
        try {
          // Create script via direct HTTP call
          const response = await fetch(`${this._localUrl}/api/app/com.athom.homeyscript/script`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${this._sessionToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              name: 'GeminiAI-FlowTrigger',
              code: '// Flow trigger proxy for GeminiAI app\n// Do not delete — used by com.dimapp.geminiai\n',
            }),
          });

          if (!response.ok) {
            if (response.status === 404) {
              throw new Error('HomeyScript app is NOT installed. Please tell the user that HomeyScript must be installed from the Homey App Store to enable flow triggering and advanced device actions.');
            }
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }

          const newScript = await response.json();
          this._homeyScriptProxyId = newScript.id;
          this.homey.log('[HomeyMCPAdapter] Created HomeyScript proxy:', this._homeyScriptProxyId);
        } catch (e) {
          // Rethrow missing app error
          if (e.message.includes('HomeyScript app is NOT installed')) {
            throw e;
          }
          throw new Error(`Failed to create HomeyScript proxy script: ${e.message}`);
        }
      }
    }

    return { scriptId: this._homeyScriptProxyId };
  }

  /**
 * Trigger a flow via HomeyScript's privileged token.
 * @param {string} flowId - The flow UUID
 * @param {string} flowType - 'standard' or 'advanced'
 * @param {Object} [args] - Optional arguments/tokens
 * @returns {Promise<void>}
 */
  async _triggerFlowViaHomeyScript(flowId, flowType, args = {}) {
    const { scriptId } = await this._ensureHomeyScriptProxy();

    const method = flowType === 'advanced' ? 'triggerAdvancedFlow' : 'triggerFlow';

    // Prepare args string for HomeyScript
    const argsStr = args && Object.keys(args).length > 0
      ? JSON.stringify(args)
      : 'null';

    const code = `await Homey.flow.${method}({ id: \"${flowId}\" }, ${argsStr});`;

    this.homey.log(`[HomeyMCPAdapter] Executing via HomeyScript: ${code}`);

    // Call HomeyScript API via direct HTTP
    const response = await fetch(`${this._localUrl}/api/app/com.athom.homeyscript/script/${scriptId}/run`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this._sessionToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ code }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();

    if (!result.success) {
      const errMsg = result.returns?.message || 'HomeyScript execution failed';
      throw new Error(errMsg);
    }
  }

  /**
   * Run a flow card action via HomeyScript's privileged token.
   * @param {string} cardId - The action card ID
   * @param {string} deviceUri - Device URI (e.g., 'homey:device:<uuid>')
   * @param {Object} args - Action arguments
   * @returns {Promise<void>}
   */
  async _runActionCardViaHomeyScript(cardId, deviceUri, args) {
    const { scriptId } = await this._ensureHomeyScriptProxy();

    // Serialize args safely for code injection
    const argsJson = JSON.stringify(args).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const code = `await Homey.flow.runFlowCardAction({ id: "${cardId}", uri: "${deviceUri}", args: JSON.parse("${argsJson}") });`;

    this.homey.log(`[HomeyMCPAdapter] Executing action via HomeyScript: ${cardId}`);

    // Call HomeyScript API via direct HTTP
    const response = await fetch(`${this._localUrl}/api/app/com.athom.homeyscript/script/${scriptId}/run`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this._sessionToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ code }),
    });

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error('HomeyScript app is NOT installed or the proxy script is missing. Please tell the user that HomeyScript must be installed from the Homey App Store to enable flow triggering and advanced device actions.');
      }
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();

    if (!result.success) {
      const errMsg = result.returns?.message || 'HomeyScript execution failed';
      throw new Error(errMsg);
    }
  }

  /**
   * Trigger a Homey Flow
   * @param {string} flowName - Name of the flow
   * @param {Object} [args] - Optional arguments/tokens
   */
  async triggerFlow(flowName, args = {}) {
    // Validate required parameter
    if (!flowName || flowName === undefined) {
      return {
        success: false,
        error: "Missing required parameter 'flowName'. Please specify the name of the Flow to trigger."
      };
    }

    // Ensure API is initialized (for listing flows)
    await this.initialize();

    try {
      // Retrieve both standard and Advanced Flows
      const standardFlows = await this.api.flow.getFlows();
      const advancedFlows = await this.api.flow.getAdvancedFlows();

      // Search in standard flows first
      let flow = Object.values(standardFlows).find(f =>
        f.name.toLowerCase() === flowName.toLowerCase()
      );
      let flowType = 'standard';

      // If not found, search in Advanced Flows
      if (!flow) {
        flow = Object.values(advancedFlows).find(f =>
          f.name.toLowerCase() === flowName.toLowerCase()
        );
        flowType = 'advanced';
      }

      // If still not found, return error with suggestions
      if (!flow) {
        const allFlows = [
          ...Object.values(standardFlows),
          ...Object.values(advancedFlows)
        ];

        return {
          success: false,
          error: `Flow "${flowName}" not found`,
          availableFlows: allFlows.map(f => f.name)
        };
      }

      // Log flow details for debugging
      this.homey.log(`[HomeyMCPAdapter] Found flow: ${flow.name}, type: ${flowType}, triggerable: ${flow.triggerable}, id: ${flow.id}`);

      // Check if flow is triggerable
      if (flow.triggerable === false) {
        return {
          success: false,
          error: `Flow "${flow.name}" cannot be manually triggered. Only flows with a "This Flow is started" trigger card can be manually triggered.`,
          flowName: flow.name,
          flowId: flow.id,
          flowType: flowType
        };
      }

      // Trigger the flow via HomeyScript (which has the required homey.flow.start scope)
      this.homey.log(`[HomeyMCPAdapter] Triggering ${flowType} flow via HomeyScript proxy, id: ${flow.id}`);
      await this._triggerFlowViaHomeyScript(flow.id, flowType, args);

      return {
        success: true,
        flowName: flow.name,
        flowId: flow.id,
        flowType: flowType,
        triggeredWithArgs: args,
        message: `Successfully triggered ${flowType} flow "${flow.name}"`
      };

    } catch (err) {
      this.homey.error('[HomeyMCPAdapter] triggerFlow Error:', err.message);
      return {
        success: false,
        error: `Failed to trigger flow "${flowName}": ${err.message}`
      };
    }
  }

  /**
   * List all Homey Flows (standard + Advanced) with optional filters
   * @param {boolean} [enabled] - Filter by enabled status (true/false)
   * @param {string} [folder] - Filter by folder name
   * @param {string} [type] - Filter by type: 'standard', 'advanced', or 'all' (default: 'all')
   * @returns {Promise<Object>} List of flows with summary
   */
  async listFlows(enabled = null, folder = null, type = 'all') {
    try {
      await this.initialize();

      // Retrieve standard flows
      const standardFlows = await this.api.flow.getFlows();

      // Retrieve Advanced Flows
      const advancedFlows = await this.api.flow.getAdvancedFlows();

      // Combine flows with type field
      const allFlows = [
        ...Object.values(standardFlows).map(f => ({ ...f, type: 'standard' })),
        ...Object.values(advancedFlows).map(f => ({ ...f, type: 'advanced' }))
      ];

      // Apply filters
      let filteredFlows = allFlows;

      // Filter by enabled status
      if (enabled !== null) {
        filteredFlows = filteredFlows.filter(f => f.enabled === enabled);
      }

      // Filter by folder
      if (folder) {
        filteredFlows = filteredFlows.filter(f =>
          f.folder && f.folder.toLowerCase() === folder.toLowerCase()
        );
      }

      // Filter by type
      if (type && type !== 'all') {
        filteredFlows = filteredFlows.filter(f => f.type === type);
      }

      // Map to simplified format
      const flowList = filteredFlows.map(f => ({
        name: f.name,
        id: f.id,
        enabled: f.enabled !== false,
        folder: f.folder || null,
        type: f.type
      }));

      // Calculate summary counts
      const summary = {
        total: flowList.length,
        standard: flowList.filter(f => f.type === 'standard').length,
        advanced: flowList.filter(f => f.type === 'advanced').length,
        enabled: flowList.filter(f => f.enabled).length,
        disabled: flowList.filter(f => !f.enabled).length
      };

      return {
        success: true,
        summary,
        flows: flowList,
        message: `Found ${flowList.length} flow(s) (${summary.standard} standard, ${summary.advanced} advanced)`
      };

    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get detailed information about a specific flow (standard or Advanced)
   * @param {string} flowName - Name of the flow
   * @returns {Promise<Object>} Flow details
   */
  async getFlowInfo(flowName) {
    // Validate required parameter
    if (!flowName || flowName === undefined) {
      return {
        success: false,
        error: "Missing required parameter 'flowName'. Please specify the name of the Flow."
      };
    }

    try {
      await this.initialize();

      // Retrieve both standard and Advanced Flows
      const standardFlows = await this.api.flow.getFlows();
      const advancedFlows = await this.api.flow.getAdvancedFlows();

      // Search in standard flows first
      let flow = Object.values(standardFlows).find(f =>
        f.name.toLowerCase() === flowName.toLowerCase()
      );
      let flowType = 'standard';

      // If not found, search in Advanced Flows
      if (!flow) {
        flow = Object.values(advancedFlows).find(f =>
          f.name.toLowerCase() === flowName.toLowerCase()
        );
        flowType = 'advanced';
      }

      // If still not found, suggest similar flows
      if (!flow) {
        const allFlows = [
          ...Object.values(standardFlows),
          ...Object.values(advancedFlows)
        ];

        return {
          success: false,
          error: `Flow "${flowName}" not found`,
          availableFlows: allFlows.map(f => f.name),
          suggestion: this.suggestDeviceClass(flowName, allFlows.map(f => f.name))
        };
      }

      // Return detailed flow information
      return {
        success: true,
        flow: {
          name: flow.name,
          id: flow.id,
          enabled: flow.enabled !== false,
          folder: flow.folder || null,
          type: flowType
        },
        message: `Flow "${flow.name}" is a ${flowType} flow, ${flow.enabled ? 'enabled' : 'disabled'}`
      };

    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get current state of a device
   */
  async getDeviceState(deviceName) {
    // Validate required parameter
    if (!deviceName || deviceName === undefined) {
      return {
        success: false,
        error: "Missing required parameter 'deviceName'. Please specify which device to query."
      };
    }

    const devices = await this.api.devices.getDevices();
    const zones = await this.api.zones.getZones();

    const device = Object.values(devices).find(d =>
      d.name.toLowerCase() === deviceName.toLowerCase()
    );

    if (!device) {
      return {
        success: false,
        error: `Device "${deviceName}" not found`
      };
    }

    // Collect all capability values
    const state = {};
    if (device.capabilitiesObj) {
      for (const [capName, capObj] of Object.entries(device.capabilitiesObj)) {
        state[capName] = capObj.value;
      }
    }

    // Get zone name by ID lookup
    let zoneName = "Unknown";
    if (device.zone && zones[device.zone]) {
      zoneName = zones[device.zone].name;
    }

    return {
      success: true,
      device: deviceName,
      deviceId: device.id,
      class: device.class,
      zone: zoneName,
      state,
      available: device.available !== false,
      message: `Current state of ${deviceName}`
    };
  }

  /**
   * List all devices in a specific zone, including their Action Cards
   */
  async listDevicesInZone(zoneName) {
    // Validate required parameter
    if (!zoneName || zoneName === undefined) {
      return {
        success: false,
        error: "Missing required parameter 'zoneName'. Please specify the room/zone name (e.g., 'Living Room', 'Kitchen')."
      };
    }

    try {
      await this.initialize();

      const devices = await this.api.devices.getDevices();
      const zones = await this.api.zones.getZones();
      // Get all available action cards once (optimization)
      const allActionCards = await this.api.flow.getFlowCardActions();

      // Find target zone first
      const targetZone = Object.values(zones).find(
        z => z.name.toLowerCase() === zoneName.toLowerCase()
      );

      if (!targetZone) {
        return {
          success: false,
          error: `Zone "${zoneName}" not found`,
          availableZones: Object.values(zones).map(z => z.name)
        };
      }

      // Get all zone IDs (target + sub-zones)
      const targetZoneIds = this._getAllChildZoneIds(targetZone.id, zones);

      // Filter devices by zone ID list
      const devicesInZone = Object.values(devices).filter(device => {
        return device.zone && targetZoneIds.includes(device.zone);
      });

      if (devicesInZone.length === 0) {
        return {
          success: false,
          error: `No devices found in zone "${zoneName}" (including sub-zones)`,
          availableZones: Object.values(zones).map(z => z.name)
        };
      }

      const deviceList = await Promise.all(devicesInZone.map(async d => ({
        name: d.name,
        id: d.id,
        class: d.class,
        capabilities: Object.keys(d.capabilitiesObj || {}),
        actionCards: await this._getDeviceActionCards(d, allActionCards),
        available: d.available !== false
      })));

      return {
        success: true,
        zone: zoneName,
        deviceCount: deviceList.length,
        devices: deviceList,
        message: `Found ${deviceList.length} device(s) in ${zoneName}. Note: 'actionCards' list special commands available for each device.`
      };

    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * List all zones/rooms in the home
   */
  async listZones() {
    const zones = await this.api.zones.getZones();

    const zoneList = Object.values(zones).map(z => ({
      name: z.name,
      id: z.id,
      parent: z.parent ? zones[z.parent]?.name : null
    }));

    return {
      success: true,
      totalZones: zoneList.length,
      zones: zoneList,
      message: `Found ${zoneList.length} zone(s) in the home`
    };
  }

  /**
   * List ALL devices in the home with their states and action cards
   */
  async listAllDevices() {
    try {
      await this.initialize();
      const devices = await this.api.devices.getDevices();
      const zones = await this.api.zones.getZones();

      const deviceList = Object.values(devices).map(d => {
        // Get current state of key capabilities
        const state = {};
        if (d.capabilitiesObj) {
          for (const [capName, capObj] of Object.entries(d.capabilitiesObj)) {
            state[capName] = capObj.value;
          }
        }

        return {
          name: d.name,
          id: d.id,
          class: d.class,
          zone: d.zone && zones[d.zone] ? zones[d.zone].name : "Unknown",
          capabilities: Object.keys(d.capabilitiesObj || {}),
          state: state,
          available: d.available !== false
        };
      });

      // Group by device class for easier analysis
      const byClass = {};
      deviceList.forEach(d => {
        if (!byClass[d.class]) byClass[d.class] = [];
        byClass[d.class].push(d);
      });

      return {
        success: true,
        totalDevices: deviceList.length,
        devices: deviceList,
        devicesByClass: byClass,
        zonesCount: Object.keys(zones).length,
        message: `Found ${deviceList.length} device(s) in the home.`
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * List all devices of a specific class
   * @param {string} deviceClass - Device class to filter by (e.g., 'light', 'thermostat', 'sensor')
   * @returns {Promise<Object>} Filtered device list
   */
  async listDevicesByClass(deviceClass) {
    // Validate required parameter
    if (!deviceClass || deviceClass === undefined) {
      return {
        success: false,
        error: "Missing required parameter 'deviceClass'. Please specify the device class (e.g., 'light', 'thermostat', 'sensor').",
        availableClasses: Object.keys(this.deviceClasses.classes || {})
      };
    }

    const devices = await this.api.devices.getDevices();
    const zones = await this.api.zones.getZones();
    // Get all available action cards once (optimization) - needed for fallback
    const allActionCards = await this.api.flow.getFlowCardActions();

    // Normalize class name for comparison
    const normalizedClass = deviceClass.toLowerCase();

    // Filter devices by effectiveClass (virtualClass takes precedence over physical class)
    // This ensures that sockets configured as lights (via "What's plugged in?") are treated as lights
    const filteredDevices = Object.values(devices).filter(d => {
      const effectiveClass = (d.virtualClass || d.class)?.toLowerCase();
      return effectiveClass === normalizedClass;
    });

    if (filteredDevices.length === 0) {
      // Collect all unique classes from actual devices
      const actualClasses = [...new Set(Object.values(devices).map(d => d.class).filter(Boolean))];

      return {
        success: false,
        error: `No devices found with class "${deviceClass}"`,
        availableClasses: actualClasses,
        suggestion: this.suggestDeviceClass(deviceClass, actualClasses)
      };
    }

    const deviceList = await Promise.all(filteredDevices.map(async d => {
      // Get current state of key capabilities
      const state = {};
      if (d.capabilitiesObj) {
        for (const [capName, capObj] of Object.entries(d.capabilitiesObj)) {
          state[capName] = capObj.value;
        }
      }

      return {
        name: d.name,
        id: d.id,
        class: d.class,
        virtualClass: d.virtualClass || null,
        effectiveClass: d.virtualClass || d.class,
        zone: d.zone && zones[d.zone] ? zones[d.zone].name : "Unknown",
        capabilities: Object.keys(d.capabilitiesObj || {}),
        actionCards: await this._getDeviceActionCards(d, allActionCards),
        state: state,
        available: d.available !== false
      };
    }));

    // Get class info from reference data
    const classInfo = this.deviceClasses.classes?.[normalizedClass];

    return {
      success: true,
      deviceClass: deviceClass,
      classInfo: classInfo ? {
        name: classInfo.name,
        icon: classInfo.icon,
        description: classInfo.description,
        commonCapabilities: classInfo.commonCapabilities
      } : null,
      deviceCount: deviceList.length,
      devices: deviceList,
      message: `Found ${deviceList.length} ${deviceClass} device(s). Note: 'actionCards' list special commands available for each device.`
    };
  }

  /**
   * Validate capability value - basic validation only
   * @param {string} capability - Capability name
   * @param {any} value - Value to validate
   * @returns {Object} Validation result with valid flag and error message
   */
  validateCapabilityValue(capability, value) {
    // Basic validation only - Homey API will handle detailed validation
    return { valid: true };
  }

  /**
   * Suggest similar capability name using Levenshtein distance
   * @param {string} input - User's input capability
   * @param {Array<string>} available - Available capabilities
   * @returns {string|null} Suggested capability or null
   */
  suggestCapability(input, available) {
    if (!input || !available || available.length === 0) return null;

    const inputLower = input.toLowerCase();

    // First try exact substring match
    let match = available.find(cap => cap.toLowerCase().includes(inputLower));
    if (match) return match;

    // Then try if input is substring of any capability
    match = available.find(cap => inputLower.includes(cap.toLowerCase()));
    if (match) return match;

    // Levenshtein distance for closest match
    let minDistance = Infinity;
    let suggestion = null;

    for (const cap of available) {
      const distance = this.levenshteinDistance(inputLower, cap.toLowerCase());
      if (distance < minDistance && distance <= 3) { // Max 3 character difference
        minDistance = distance;
        suggestion = cap;
      }
    }

    return suggestion;
  }

  /**
   * Suggest similar device class name
   * @param {string} input - User's input class
   * @param {Array<string>} available - Available classes
   * @returns {string|null} Suggested class or null
   */
  suggestDeviceClass(input, available) {
    if (!input || !available || available.length === 0) return null;

    const inputLower = input.toLowerCase();

    // Try exact or partial match
    let match = available.find(cls => cls.toLowerCase() === inputLower);
    if (match) return match;

    match = available.find(cls => cls.toLowerCase().includes(inputLower) || inputLower.includes(cls.toLowerCase()));
    if (match) return match;

    return null;
  }

  /**
   * Calculate Levenshtein distance between two strings
   * @param {string} a - First string
   * @param {string} b - Second string
   * @returns {number} Edit distance
   */
  levenshteinDistance(a, b) {
    const matrix = [];

    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }

    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }

    return matrix[b.length][a.length];
  }



  /**
   * Get status (on/off) for devices of a specific class, optionally filtered by zone
   * Returns separate arrays for devices that are on vs off
   * @param {string} deviceClass - Device class to filter by
   * @param {string} [zoneName] - Optional zone name to filter by
   */
  async getDevicesStatusByClass(deviceClass, zoneName = null) {
    try {
      await this.initialize();

      if (!deviceClass || !this.deviceClasses.classes[deviceClass]) {
        // Collect all unique classes from actual devices
        const devices = await this.api.devices.getDevices();
        const actualClasses = [...new Set(Object.values(devices).map(d => d.class).filter(Boolean))];

        return {
          success: false,
          error: `Unknown device class: "${deviceClass}"`,
          availableClasses: actualClasses
        };
      }

      const devices = await this.api.devices.getDevices();
      const zones = await this.api.zones.getZones();

      // Filter by effectiveClass (virtualClass takes precedence over physical class)
      // This ensures that sockets configured as lights (via "What's plugged in?") are treated as lights
      let classDevices = Object.values(devices).filter(d => {
        const effectiveClass = d.virtualClass || d.class;
        return effectiveClass === deviceClass;
      });

      // Filter by zone if specified
      if (zoneName) {
        const targetZone = Object.values(zones).find(
          z => z.name.toLowerCase() === zoneName.toLowerCase()
        );

        if (!targetZone) {
          const availableZones = Object.values(zones).map(z => z.name);
          return {
            success: false,
            error: `Zone "${zoneName}" not found`,
            availableZones: availableZones
          };
        }

        // Get all zone IDs (target + sub-zones)
        const targetZoneIds = this._getAllChildZoneIds(targetZone.id, zones);

        // Filter devices that belong to target zone or its sub-zones
        classDevices = classDevices.filter(d => d.zone && targetZoneIds.includes(d.zone));
      }

      if (classDevices.length === 0) {
        return {
          success: true,
          deviceClass,
          zone: zoneName || 'all',
          summary: {
            total: 0,
            on: 0,
            off: 0,
            unknown: 0,
            percentageOn: 0
          },
          devicesOn: [],
          devicesOff: [],
          devicesUnknown: []
        };
      }

      // Map devices with complete state for all capabilities
      const devicesWithState = classDevices.map(d => {
        // Collect all capability values into state object
        const state = {};
        if (d.capabilitiesObj) {
          for (const [capName, capObj] of Object.entries(d.capabilitiesObj)) {
            state[capName] = capObj.value;
          }
        }

        return {
          name: d.name,
          class: d.class,
          virtualClass: d.virtualClass || null,
          effectiveClass: d.virtualClass || d.class,
          zone: d.zone && zones[d.zone] ? zones[d.zone].name : 'Unknown',
          capabilities: Object.keys(d.capabilitiesObj || {}),
          state: state,
          available: d.available
        };
      });

      // Check if ALL devices have the onoff capability
      const allHaveOnOff = devicesWithState.length > 0 &&
        devicesWithState.every(d => d.capabilities.includes('onoff'));

      if (allHaveOnOff) {
        // Format for devices with onoff (lights, sockets, etc.)
        const devicesOn = devicesWithState.filter(d => d.state.onoff === true);
        const devicesOff = devicesWithState.filter(d => d.state.onoff === false);

        return {
          success: true,
          deviceClass,
          zone: zoneName || 'all',
          classInfo: this.deviceClasses.classes[deviceClass],
          summary: {
            total: devicesWithState.length,
            on: devicesOn.length,
            off: devicesOff.length,
            percentageOn: devicesWithState.length > 0
              ? Math.round((devicesOn.length / devicesWithState.length) * 100)
              : 0
          },
          devicesOn: devicesOn,
          devicesOff: devicesOff
        };
      } else {
        // Generic format for devices without onoff (locks, sensors, thermostats, etc.)
        return {
          success: true,
          deviceClass,
          zone: zoneName || 'all',
          classInfo: this.deviceClasses.classes[deviceClass],
          summary: {
            total: devicesWithState.length
          },
          devices: devicesWithState
        };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Get device count and status by zone
   * Useful for queries like "how many lights in the kitchen?", "devices in bedroom"
   */
  async getDeviceCountByZone(zoneName = null) {
    try {
      await this.initialize();
      const devices = await this.api.devices.getDevices();
      const zones = await this.api.zones.getZones();

      // Group devices by zone
      const devicesByZone = {};

      Object.values(devices).forEach(device => {
        const zone = device.zone && zones[device.zone]
          ? zones[device.zone].name
          : 'Unknown';

        if (!devicesByZone[zone]) {
          devicesByZone[zone] = [];
        }
        devicesByZone[zone].push(device);
      });

      // If specific zone requested
      if (zoneName) {
        // Try exact match first (case-insensitive)
        let matchingZone = null;
        for (const [zone, devs] of Object.entries(devicesByZone)) {
          if (zone.toLowerCase() === zoneName.toLowerCase()) {
            matchingZone = zone;
            break;
          }
        }

        if (!matchingZone) {
          return {
            success: false,
            error: `Zone "${zoneName}" not found`,
            availableZones: Object.keys(devicesByZone)
          };
        }

        const zoneDevices = devicesByZone[matchingZone];

        // Also include devices from sub-zones
        // Note: devicesByZone keys are just top-level names, we need to do this smarter
        // Re-implementing correctly:

        const targetZone = Object.values(zones).find(z => z.name === matchingZone);
        if (targetZone) {
          const targetZoneIds = this._getAllChildZoneIds(targetZone.id, zones);
          const recursiveDevices = Object.values(devices).filter(d => d.zone && targetZoneIds.includes(d.zone));

          return {
            success: true,
            zone: matchingZone,
            includesSubZones: true,
            summary: this._computeZoneSummary(recursiveDevices)
          };
        }

        // Fallback for edge cases (should not reach here if zone found)
        return {
          success: true,
          zone: matchingZone,
          summary: this._computeZoneSummary(zoneDevices)
        };
      }

      // Return all zones
      const allZonesSummary = {};
      Object.entries(devicesByZone).forEach(([zone, devs]) => {
        allZonesSummary[zone] = this._computeZoneSummary(devs);
      });

      return {
        success: true,
        summary: allZonesSummary
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Helper: Compute summary for a list of devices
   * @private
   */
  _computeZoneSummary(devices) {
    const summary = {
      totalDevices: devices.length,
      byClass: {}
    };

    // Group devices by effectiveClass first
    const devicesByClass = {};
    devices.forEach(d => {
      // Use virtualClass if set (user's "What's plugged in?" setting), otherwise use physical class
      const effectiveClass = d.virtualClass || d.class;

      if (!devicesByClass[effectiveClass]) {
        devicesByClass[effectiveClass] = [];
      }
      devicesByClass[effectiveClass].push(d);
    });

    // For each class, determine if we should show on/off counts
    Object.entries(devicesByClass).forEach(([className, classDevices]) => {
      // Check if ALL devices in this class have onoff capability
      const allHaveOnOff = classDevices.every(d =>
        d.capabilitiesObj && 'onoff' in d.capabilitiesObj
      );

      if (allHaveOnOff) {
        // Include on/off counts for classes where all devices have onoff
        const on = classDevices.filter(d => d.capabilitiesObj?.onoff?.value === true).length;
        const off = classDevices.filter(d => d.capabilitiesObj?.onoff?.value === false).length;

        summary.byClass[className] = {
          total: classDevices.length,
          on: on,
          off: off
        };
      } else {
        // Only include total for classes without universal onoff support
        summary.byClass[className] = {
          total: classDevices.length
        };
      }
    });

    return summary;
  }

  /**
   * Get information about a device class or search for device classes
   * @param {string} className - Exact device class name (optional)
   * @param {string} searchTerm - Search term for fuzzy matching (optional)
   * @returns {Promise<Object>} Device class information or search results
   */
  async getDeviceClassInfo(className = null, searchTerm = null) {
    try {
      // Get info for specific device class
      if (className) {
        const classLower = className.toLowerCase();
        const info = this.deviceClasses.classes[classLower];

        if (info) {
          return {
            success: true,
            className: classLower,
            name: info.name,
            icon: info.icon,
            description: info.description,
            commonCapabilities: info.commonCapabilities,
            requiredCapabilities: info.requiredCapabilities,
            examples: info.examples,
            notes: info.notes
          };
        }

        // Class not found - suggest similar one
        const allClasses = Object.keys(this.deviceClasses.classes);
        const suggestion = this.suggestDeviceClass(className, allClasses);

        return {
          success: false,
          error: `Device class "${className}" not found`,
          suggestion: suggestion ? `Did you mean '${suggestion}'?` : null,
          availableClasses: allClasses.slice(0, 20),
          hint: "Use searchTerm parameter to search for classes"
        };
      }

      // Search for device classes
      if (searchTerm) {
        const searchLower = searchTerm.toLowerCase();

        // Fuzzy search in class names and descriptions
        const matches = Object.entries(this.deviceClasses.classes)
          .filter(([id, info]) =>
            id.toLowerCase().includes(searchLower) ||
            info.name.toLowerCase().includes(searchLower) ||
            info.description.toLowerCase().includes(searchLower) ||
            (info.examples && info.examples.some(ex => ex.toLowerCase().includes(searchLower)))
          )
          .slice(0, 10)
          .map(([id, info]) => ({
            className: id,
            name: info.name,
            icon: info.icon,
            description: info.description,
            commonCapabilities: info.commonCapabilities
          }));

        if (matches.length === 0) {
          return {
            success: false,
            searchTerm,
            error: `No device classes found matching "${searchTerm}"`,
            hint: "Try terms like 'light', 'plug', 'heating', 'window', 'sensor'",
            availableClasses: Object.keys(this.deviceClasses.classes).slice(0, 15)
          };
        }

        return {
          success: true,
          searchTerm,
          matchCount: matches.length,
          matches
        };
      }

      // No parameters - return all available classes
      const allClasses = Object.entries(this.deviceClasses.classes).map(([id, info]) => ({
        className: id,
        name: info.name,
        icon: info.icon,
        description: info.description
      }));

      return {
        success: true,
        message: "All available device classes",
        totalClasses: allClasses.length,
        classes: allClasses,
        hint: "Use 'className' parameter for details or 'searchTerm' to search"
      };

    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Search for devices by matching keywords in their name
   * @param {string} query - Search term
   */
  async searchDevices(query) {
    if (!query) {
      return {
        success: false,
        error: "Missing required parameter 'query'"
      };
    }

    try {
      await this.initialize();

      const devices = await this.api.devices.getDevices();
      const zones = await this.api.zones.getZones();
      // Split query by commas or spaces to get multiple keywords
      const keywords = query.toLowerCase().split(/[,\s]+/).filter(k => k.length > 2);

      if (keywords.length === 0) {
        return {
          success: false,
          error: "Query too short or empty. Please provide valid keywords."
        };
      }

      // Filter devices where name contains ANY of the keywords
      const matches = Object.values(devices).filter(d => {
        const nameLower = d.name.toLowerCase();
        return keywords.some(k => nameLower.includes(k));
      });

      if (matches.length === 0) {
        return {
          success: true,
          query: query,
          parsedKeywords: keywords,
          count: 0,
          devices: [],
          message: `No devices found matching any of: ${keywords.join(', ')}`
        };
      }

      // Map to useful output format
      const results = matches.map(d => ({
        name: d.name,
        class: d.class,
        zone: d.zone && zones[d.zone] ? zones[d.zone].name : 'Unknown',
        pills: d.capabilitiesObj ? Object.keys(d.capabilitiesObj) : [] // "pills" or "capabilities" - listing keys helps identify device type
      }));

      return {
        success: true,
        query: query,
        count: results.length,
        devices: results,
        message: `Found ${results.length} device(s) matching "${query}"`
      };

    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Schedule a command to be executed at a future time
   * @param {string} command - Natural language command to execute
   * @param {string} executeAt - ISO 8601 datetime in LOCAL time (Homey's timezone)
   * @param {string} description - Human readable description
   * @returns {Promise<Object>}
   */
  async scheduleCommand(command, executeAt, description) {
    try {
      // Validate format
      if (!executeAt || typeof executeAt !== 'string') {
        return {
          success: false,
          error: `Invalid datetime format. Received: ${executeAt}`
        };
      }

      // Get Homey's timezone
      let userTimezone = 'UTC';
      try {
        userTimezone = this.homey?.clock?.getTimezone?.() || 'UTC';
      } catch (e) {
        this.homey.log('[scheduleCommand] Could not get timezone, using UTC');
      }

      // Parse executeAt as LOCAL time
      const localDate = new Date(executeAt);

      // Validation
      if (isNaN(localDate.getTime())) {
        return {
          success: false,
          error: 'Invalid datetime format. Use ISO 8601 format (e.g., 2026-02-08T22:00:00)'
        };
      }

      // Convert LOCAL time to UTC
      // Calculate timezone offset
      const utcDate = new Date(localDate.toLocaleString('en-US', { timeZone: 'UTC' }));
      const tzDate = new Date(localDate.toLocaleString('en-US', { timeZone: userTimezone }));
      const offsetMs = tzDate.getTime() - utcDate.getTime();

      // Subtract offset to get UTC time
      const executeUTC = new Date(localDate.getTime() - offsetMs);
      const now = new Date();

      this.homey.log(`[scheduleCommand] Input (local): ${executeAt}`);
      this.homey.log(`[scheduleCommand] Timezone: ${userTimezone}, Offset: ${offsetMs}ms`);
      this.homey.log(`[scheduleCommand] Converted to UTC: ${executeUTC.toISOString()}`);
      this.homey.log(`[scheduleCommand] Current UTC: ${now.toISOString()}`);

      const delayMs = executeUTC.getTime() - now.getTime();

      // Allow 60-second tolerance for race conditions (multi-turn loops take time)
      // This handles cases like "in 10 seconds" where AI processing takes a few seconds
      const TOLERANCE_MS = 60000; // 60 seconds

      if (delayMs < -TOLERANCE_MS) {
        // More than 60 seconds in the past - reject
        return {
          success: false,
          error: 'Scheduled time is too far in the past',
          requestedTime: executeAt,
          currentTime: now.toISOString(),
          delaySeconds: Math.round(delayMs / 1000)
        };
      }

      // If within tolerance (slightly in past), adjust to immediate execution
      const actualDelayMs = Math.max(delayMs, 0);
      const delayMinutes = Math.round(delayMs / 60000);
      const delayHours = Math.round(delayMs / 3600000);
      const delayDays = Math.round(delayMs / 86400000);

      // Limit to 365 days (1 year)
      const MAX_DAYS = 365;
      if (delayDays > MAX_DAYS) {
        return {
          success: false,
          error: `Cannot schedule commands more than ${MAX_DAYS} days in the future`,
          requestedDelay: `${delayDays} giorni`,
          maxDelay: `${MAX_DAYS} giorni`
        };
      }

      // Create unique identifier
      const scheduleId = `schedule_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // Store in persistent settings
      const scheduledCommands = this.homey.settings.get('scheduled_commands') || {};
      scheduledCommands[scheduleId] = {
        command,
        executeAt: executeUTC.toISOString(),
        description,
        createdAt: now.toISOString(),
        status: 'pending'
      };
      this.homey.settings.set('scheduled_commands', scheduledCommands);

      this.homey.log(`[scheduleCommand] Scheduled ${scheduleId} for ${executeUTC.toISOString()} (in ${delayMinutes} minutes)`);

      // Hybrid scheduling strategy:
      // - < 24 hours: Use homey.setTimeout() for precise execution
      // - > 24 hours: Use periodic checker (every 10 minutes)
      const HOURS_24_MS = 24 * 60 * 60 * 1000;

      if (actualDelayMs < HOURS_24_MS) {
        // Short delay: use setTimeout for precise execution
        this.homey.log(`[scheduleCommand] Using setTimeout for ${scheduleId} (${Math.round(actualDelayMs / 1000)}s)`);
        this._scheduleWithTimeout(scheduleId, command, actualDelayMs);
      } else {
        // Long delay: use periodic checker
        this.homey.log(`[scheduleCommand] Using periodic checker for ${scheduleId} (${delayDays} days)`);
        this._ensureSchedulerCheckerRunning();
      }

      // Format human-readable time info
      let timeInfo;
      if (delayMinutes === 0) {
        const seconds = Math.round(actualDelayMs / 1000);
        timeInfo = `${seconds} secondo${seconds !== 1 ? 'i' : ''}`;
      } else if (delayMinutes < 60) {
        timeInfo = `${delayMinutes} minut${delayMinutes !== 1 ? 'i' : 'o'}`;
      } else if (delayHours < 48) {
        timeInfo = `${delayHours} or${delayHours !== 1 ? 'e' : 'a'}`;
      } else {
        timeInfo = `${delayDays} giorn${delayDays !== 1 ? 'i' : 'o'}`;
      }

      return {
        success: true,
        scheduleId,
        command,
        executeAt: executeUTC.toISOString(),
        description,
        delayMinutes,
        delayDays: Math.round(delayDays * 10) / 10,
        message: `Comando programmato con successo. Verrà eseguito tra ${timeInfo}`
      };

    } catch (error) {
      this.homey.error('[scheduleCommand] Error:', error);
      return {
        success: false,
        error: error.message || 'Failed to schedule command'
      };
    }
  }

  /**
   * Start periodic scheduler checker (every 10 minutes)
   * Only for schedules > 24 hours
   * @private
   */
  _startSchedulerChecker() {
    if (this._schedulerInterval) {
      return; // Already running
    }

    // Check every 10 minutes
    const CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

    this._schedulerInterval = this.homey.setInterval(async () => {
      await this._checkAndExecutePendingCommands();
    }, CHECK_INTERVAL_MS);

    this.homey.log('[schedulerChecker] Started (check every 10 minutes for long schedules)');
  }

  /**
   * Ensure scheduler checker is running (start if not already)
   * @private
   */
  _ensureSchedulerCheckerRunning() {
    if (!this._schedulerInterval) {
      this._startSchedulerChecker();
    }
  }

  /**
   * Schedule command execution using homey.setTimeout (for < 24h)
   * @private
   */
  _scheduleWithTimeout(scheduleId, command, delayMs) {
    const timeoutId = this.homey.setTimeout(async () => {
      this.homey.log(`[setTimeout] Executing scheduled command: ${scheduleId}`);
      await this._executeScheduledCommand(scheduleId, command);
      this._scheduledTimeouts.delete(scheduleId);
    }, delayMs);

    this._scheduledTimeouts.set(scheduleId, timeoutId);
  }

  /**
   * Check and execute pending scheduled commands
   * @private
   */
  async _checkAndExecutePendingCommands() {
    const scheduledCommands = this.homey.settings.get('scheduled_commands') || {};
    const now = new Date();

    for (const [scheduleId, schedule] of Object.entries(scheduledCommands)) {
      if (schedule.status === 'pending') {
        const executeAt = new Date(schedule.executeAt);

        // Execute if time has passed (with 10 min tolerance)
        if (now >= executeAt) {
          this.homey.log(`[schedulerChecker] Executing due command: ${scheduleId}`);
          await this._executeScheduledCommand(scheduleId, schedule.command);
        }
      }
    }
  }

  /**
   * Execute a scheduled command
   * @private
   */
  async _executeScheduledCommand(scheduleId, command) {
    this.homey.log(`[_executeScheduledCommand] Executing: ${scheduleId}`);

    try {
      // Get the app instance to access GeminiClient
      const app = this.homey.app;

      if (!app.geminiClient) {
        throw new Error('GeminiClient not initialized');
      }

      // Execute the command through Gemini with MCP
      // Note: This starts a fresh conversation with no prior context
      const result = await app.geminiClient.generateTextWithMCP(command);

      // Delete scheduled command from settings after execution
      const scheduledCommands = this.homey.settings.get('scheduled_commands') || {};
      if (scheduledCommands[scheduleId]) {
        this.homey.log(`[_executeScheduledCommand] Removing executed command from settings: ${scheduleId}`);
        delete scheduledCommands[scheduleId];
        this.homey.settings.set('scheduled_commands', scheduledCommands);
      }

      // Trigger flow card for notification
      const trigger = this.homey.flow.getTriggerCard('scheduled_command_executed');
      if (trigger) {
        await trigger.trigger({
          command: command,
          success: result.success,
          response: result.response,
          timer_id: scheduleId
        });
      }

      this.homey.log(`[_executeScheduledCommand] Completed: ${scheduleId} - Success: ${result.success}`);

    } catch (error) {
      this.homey.error(`[_executeScheduledCommand] Failed for ${scheduleId}:`, error);

      // Delete scheduled command from settings even on error
      const scheduledCommands = this.homey.settings.get('scheduled_commands') || {};
      if (scheduledCommands[scheduleId]) {
        this.homey.log(`[_executeScheduledCommand] Removing failed command from settings: ${scheduleId}`);
        delete scheduledCommands[scheduleId];
        this.homey.settings.set('scheduled_commands', scheduledCommands);
      }
    }
  }

  /**
   * Restore scheduled commands after app restart
   * Must be called from app.js onInit()
   */
  async restoreScheduledCommands() {
    const scheduledCommands = this.homey.settings.get('scheduled_commands') || {};
    const now = new Date();

    let restoredShort = 0;
    let restoredLong = 0;
    let pastDueCount = 0;
    let expiredCount = 0;

    const HOURS_24_MS = 24 * 60 * 60 * 1000;
    const TOLERANCE_MS = 10 * 60 * 1000; // 10 minutes tolerance
    const PAST_DUE_THRESHOLD = HOURS_24_MS + TOLERANCE_MS;

    for (const [scheduleId, schedule] of Object.entries(scheduledCommands)) {
      if (schedule.status === 'pending') {
        const executeAt = new Date(schedule.executeAt);
        const delayMs = executeAt.getTime() - now.getTime();

        if (delayMs > 0) {
          // FUTURE: Timer not yet expired
          if (delayMs < HOURS_24_MS) {
            // Short delay: restore with setTimeout
            this.homey.log(`[restoreScheduledCommands] Restoring with setTimeout: ${scheduleId} (in ${Math.round(delayMs / 60000)} minutes)`);
            this._scheduleWithTimeout(scheduleId, schedule.command, delayMs);
            restoredShort++;
          } else {
            // Long delay: will be handled by periodic checker
            this.homey.log(`[restoreScheduledCommands] Will use checker: ${scheduleId} (in ${Math.round(delayMs / 3600000)} hours)`);
            restoredLong++;
          }
        } else {
          // PAST: Timer already expired
          const absPastDueMs = Math.abs(delayMs);

          if (absPastDueMs <= PAST_DUE_THRESHOLD) {
            // Expired less than 24h + 10min ago → execute anyway
            const lateMinutes = Math.round(absPastDueMs / 60000);
            this.homey.log(`[restoreScheduledCommands] Past due: ${scheduleId} (${lateMinutes} min late, will execute immediately)`);
            pastDueCount++;
          } else {
            // Expired more than 24h + 10min ago → too old, delete
            const lateDays = Math.round(absPastDueMs / (24 * 60 * 60 * 1000));
            this.homey.log(`[restoreScheduledCommands] Deleting expired: ${scheduleId} (${lateDays} days late, too old)`);
            delete scheduledCommands[scheduleId];
            expiredCount++;
          }
        }
      }
    }

    // Save cleaned settings (expired commands deleted)
    if (expiredCount > 0) {
      this.homey.settings.set('scheduled_commands', scheduledCommands);
    }

    // Start checker if there are long schedules
    if (restoredLong > 0) {
      this._ensureSchedulerCheckerRunning();
    }

    if (restoredShort > 0 || restoredLong > 0 || pastDueCount > 0 || expiredCount > 0) {
      this.homey.log(`[restoreScheduledCommands] Found ${restoredShort} short (setTimeout), ${restoredLong} long (checker), ${pastDueCount} past-due, ${expiredCount} expired (deleted)`);

      // If there are past-due commands, execute them immediately
      if (pastDueCount > 0) {
        this.homey.log(`[restoreScheduledCommands] Executing ${pastDueCount} past-due commands now`);
        await this._checkAndExecutePendingCommands();
      }
    }
  }

  /**
   * Cancel a scheduled command
   * Clears the timeout and removes from settings
   * @param {string} scheduleId - Schedule ID to cancel
   * @returns {Promise<Object>}
   */
  async cancelScheduledCommand(scheduleId) {
    try {
      this.homey.log(`[cancelScheduledCommand] Called with scheduleId: ${scheduleId}`);

      // Get current scheduled commands
      const scheduledCommands = this.homey.settings.get('scheduled_commands') || {};

      this.homey.log(`[cancelScheduledCommand] Current scheduled commands:`, Object.keys(scheduledCommands));

      // Check if schedule exists
      if (!scheduledCommands[scheduleId]) {
        return {
          success: false,
          error: `Schedule ${scheduleId} not found`
        };
      }

      const schedule = scheduledCommands[scheduleId];

      // Clear timeout if exists
      if (this._scheduledTimeouts.has(scheduleId)) {
        const timeoutId = this._scheduledTimeouts.get(scheduleId);
        this.homey.clearTimeout(timeoutId);
        this._scheduledTimeouts.delete(scheduleId);
        this.homey.log(`[cancelScheduledCommand] Cleared setTimeout for: ${scheduleId}`);
      }

      // Remove from settings
      delete scheduledCommands[scheduleId];
      this.homey.settings.set('scheduled_commands', scheduledCommands);

      this.homey.log(`[cancelScheduledCommand] Cancelled and removed: ${scheduleId}`);

      return {
        success: true,
        scheduleId,
        command: schedule.command,
        message: `Successfully cancelled scheduled command: ${schedule.description || schedule.command}`
      };
    } catch (error) {
      this.homey.error(`[cancelScheduledCommand] Error:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Cleanup on app destroy
   * Called from app.js onUninit()
   */
  async cleanup() {
    // Clear periodic checker if running
    if (this._schedulerInterval) {
      this.homey.clearInterval(this._schedulerInterval);
      this.homey.log('[schedulerChecker] Stopped');
    }

    // Clear all active timeouts
    if (this._scheduledTimeouts && this._scheduledTimeouts.size > 0) {
      this.homey.log(`[cleanup] Clearing ${this._scheduledTimeouts.size} active setTimeout timers`);
      // Note: homey.setTimeout timers are auto-cleared on app destroy,
      // but we track them for visibility
      this._scheduledTimeouts.clear();
    }
  }
  /**
   * List all action cards available for a specific device
   * @param {string} deviceName 
   */
  async listDeviceActions(deviceName) {
    if (!deviceName) {
      return { success: false, error: "Missing deviceName" };
    }

    try {
      await this.initialize();
      const devices = await this.api.devices.getDevices();

      const device = Object.values(devices).find(d =>
        d.name.toLowerCase() === deviceName.toLowerCase()
      );

      if (!device) {
        return { success: false, error: `Device "${deviceName}" not found` };
      }

      // Get all action cards
      const actionCards = await this.api.flow.getFlowCardActions();

      // Filter actions belonging to this device
      // device.uri is like "homey:device:<uuid>"
      // card.ownerUri should match this
      const deviceActions = Object.values(actionCards).filter(card =>
        card.ownerUri === 'homey:device:' + device.id ||
        card.ownerUri === device.uri // Check both just in case
      );

      const formattedActions = deviceActions.map(card => ({
        id: card.id,
        title: card.titleFormatted || card.title,
        description: card.title, // Sometimes titleFormatted is null
        uri: card.uri, // Deprecated but might be useful for debug
        args: card.args // List of arguments required
      }));

      return {
        success: true,
        deviceName: device.name,
        count: formattedActions.length,
        actions: formattedActions
      };

    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Run a specific action card
   * @param {string} deviceName - For verification context
   * @param {string} cardId 
   * @param {Object} args 
   */
  async runActionCard(deviceName, cardId, args = {}) {
    try {
      await this.initialize();

      // Verify device exists first
      const devices = await this.api.devices.getDevices();
      const device = Object.values(devices).find(d =>
        d.name.toLowerCase() === deviceName.toLowerCase()
      );

      if (!device) {
        return { success: false, error: `Device "${deviceName}" not found` };
      }

      // Get the card info for better error messages
      const card = await this.api.flow.getFlowCardAction({
        id: cardId,
        uri: 'homey:device:' + device.id
      });

      if (!card) {
        return { success: false, error: "Card not found" };
      }

      const deviceUri = 'homey:device:' + device.id;

      // Execute via HomeyScript proxy (like triggerFlow)
      this.homey.log(`[HomeyMCPAdapter] Running action card via HomeyScript proxy: ${cardId}`);
      await this._runActionCardViaHomeyScript(cardId, deviceUri, args);

      return {
        success: true,
        message: `Executed action "${card.titleFormatted || card.title}" on ${device.name}`
      };

    } catch (error) {
      this.homey.error(`[runActionCard] Error:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Helper: Get all child zone IDs recursively
   * @private
   * @param {string} rootZoneId - ID of the root zone
   * @param {Object} zones - Map of all zones (from homey.api.zones.getZones())
   * @returns {string[]} Array of zone IDs (including rootZoneId)
   */
  _getAllChildZoneIds(rootZoneId, zones) {
    const ids = [rootZoneId];

    // Find direct children
    const children = Object.values(zones).filter(z => z.parent === rootZoneId);

    for (const child of children) {
      // Recursively add children of children
      const childIds = this._getAllChildZoneIds(child.id, zones);
      ids.push(...childIds);
    }

    return ids;
  }

  /**
   * Helper: Get action cards for a specific device
   * @private
   * @param {Object} device - Device object
   * @param {Object} allActionCards - All available action cards (optional, for performance)
   * @returns {Array} List of action cards
   */
  async _getDeviceActionCards(device, allActionCards = null) {
    if (!allActionCards) {
      await this.initialize();
      allActionCards = await this.api.flow.getFlowCardActions();
    }

    return Object.values(allActionCards).filter(card =>
      card.ownerUri === 'homey:device:' + device.id ||
      card.ownerUri === device.uri
    ).map(card => ({
      id: card.id,
      title: card.titleFormatted || card.title,
      description: card.title,
      // uri: card.uri, // internal
      // args: card.args // internal
    }));
  }
}

module.exports = { HomeyMCPAdapter };
