'use strict';

const { HomeyAPI } = require('homey-api');
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
      this.api = await HomeyAPI.createAppAPI({
        homey: this.homey
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

                    **Important:** You must use exact device name and correct capability name.`,
          inputSchema: {
            type: "object",
            properties: {
              deviceName: {
                type: "string",
                description: "Exact device name (e.g., 'Living Room Light', 'Daikin Studio', 'Bedroom Thermostat'). Must match device name exactly. Use list_devices_in_zone if you don't know the exact name."
              },
              capability: {
                type: "string",
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
            type: "object",
            properties: {
              flowName: {
                type: "string",
                description: "Exact name of the Flow to trigger (e.g., 'Good Morning', 'Evening Lights', 'Away Mode'). Flow name must match exactly as defined in Homey."
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
            type: "object",
            properties: {
              deviceName: {
                type: "string",
                description: "Name of the device to query"
              }
            },
            required: ["deviceName"]
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

                    **Returns:**
                    - Exact device names
                    - Device classes
                    - Available capabilities
                    - Availability status

                    **Essential** for finding exact device names before calling \`control_device\`.`,
          inputSchema: {
            type: "object",
            properties: {
              zoneName: {
                type: "string",
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
            type: "object",
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
            type: "object",
            properties: {
              deviceClass: {
                type: "string",
                description: "Device class to filter by. Common values: 'light' (all lights), 'socket' (all plugs), 'thermostat' (all thermostats), 'sensor' (all sensors), 'lock' (all locks), 'speaker' (all speakers), 'fan' (all fans), 'windowcoverings' (all window coverings), 'blinds', 'curtain', 'sunshade'"
              }
            },
            required: ["deviceClass"]
          }
        },
        // Commented out: get_lights_status is redundant with get_devices_status_by_class
        // Keep for potential future use if Gemini struggles without it
        /*
        {
          name: "get_lights_status",
          description: "Get detailed list of all lights in the home with their on/off status and zones. USE THIS for questions like 'which lights are on?', 'what lights are on?', 'list the lights that are on', 'show me all lights', etc. Returns separate lists of lights that are on and lights that are off with their zone names.",
          inputSchema: {
            type: "object",
            properties: {},
            required: []
          }
        },
        */
        {
          name: "get_devices_status_by_class",
          description: `
                    Get status of **ALL** devices of a specific class with on/off states. Can be filtered by zone.

                    **Use this for:**
                    - Class-wide status queries like "which lights are on?"
                    - Zone-specific queries like "are there lights on in the kitchen?" (with \`zone='Kitchen'\`)
                    - "What sockets are on?" (no zone parameter)

                    **Returns:**
                    - Summary counts
                    - Separate lists of devices: **ON** / **OFF** / **UNKNOWN**
                    - Zone names for each device`,
          inputSchema: {
            type: "object",
            properties: {
              deviceClass: {
                type: "string",
                description: "Device class to query. Common values: 'light', 'socket', 'thermostat', 'fan', 'switch', 'camera', 'lock', 'speaker', 'sensor', 'airconditioning', 'heater'."
              },
              zone: {
                type: "string",
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

                    **Returns:**
                    - Counts by device class (\`light\`, \`socket\`, \`thermostat\`, etc.)
                    - On/off status for the specified zone

                    **Important:** This is the correct tool when user mentions a specific room name for counting or summary.`,
          inputSchema: {
            type: "object",
            properties: {
              zone: {
                type: "string",
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
            type: "object",
            properties: {
              className: {
                type: "string",
                description: "Exact device class name (e.g., 'light', 'socket', 'thermostat', 'airconditioning'). Use this if you know the exact class name."
              },
              searchTerm: {
                type: "string",
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

                    **Features:**
                    - Supports scheduling up to **365 days** in advance
                    - Precise execution for times within 24 hours
                    - Command will be executed automatically at the specified time

                    **Important:**
                    - \`executeAt\` must be in **UTC** time with Z suffix
                    - Format: \`YYYY-MM-DDTHH:MM:SSZ\`
                    - Always convert local time to UTC before passing`,
          inputSchema: {
            type: "object",
            properties: {
              command: {
                type: "string",
                description: "The natural language command to execute later (e.g., 'turn off all lights in living room', 'set thermostat to 20 degrees'). This will be processed through Gemini at execution time."
              },
              executeAt: {
                type: "string",
                description: "ISO 8601 datetime, format: 'YYYY-MM-DDTHH:MM:SSZ' (e.g., '2026-01-16T21:00:00Z'). This is the UTC time when the command should be executed. Always convert local time to UTC before passing."
              },
              description: {
                type: "string",
                description: "Human-readable description of what will happen (e.g., 'Turn off lights at 5pm tomorrow', 'Start heating in 30 minutes')."
              }
            },
            required: ["command", "executeAt", "description"]
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
          return await this.triggerFlow(args.flowName);

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
        error: `Capability "${capability}" not found on device "${deviceName}"`,
        availableCapabilities: availableCaps,
        suggestion: suggestion ? `Did you mean '${suggestion}'?` : null
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
    await device.setCapabilityValue(capability, convertedValue);

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
   * Trigger a Homey Flow
   */
  async triggerFlow(flowName) {
    // Validate required parameter
    if (!flowName || flowName === undefined) {
      return {
        success: false,
        error: "Missing required parameter 'flowName'. Please specify the name of the Flow to trigger."
      };
    }

    const flows = await this.api.flow.getFlows();

    // Find flow by name (case-insensitive)
    const flow = Object.values(flows).find(f =>
      f.name.toLowerCase() === flowName.toLowerCase()
    );

    if (!flow) {
      return {
        success: false,
        error: `Flow "${flowName}" not found`,
        availableFlows: Object.values(flows).map(f => f.name)
      };
    }

    // Trigger the flow
    await flow.trigger();

    return {
      success: true,
      flowName: flow.name,
      flowId: flow.id,
      message: `Successfully triggered flow "${flow.name}"`
    };
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

    return {
      success: true,
      device: deviceName,
      deviceId: device.id,
      class: device.class,
      zone: device.zone?.name || "Unknown",
      state,
      available: device.available !== false,
      message: `Current state of ${deviceName}`
    };
  }

  /**
   * List all devices in a specific zone
   */
  async listDevicesInZone(zoneName) {
    // Validate required parameter
    if (!zoneName || zoneName === undefined) {
      return {
        success: false,
        error: "Missing required parameter 'zoneName'. Please specify the room/zone name (e.g., 'Living Room', 'Kitchen')."
      };
    }

    const devices = await this.api.devices.getDevices();
    const zones = await this.api.zones.getZones();

    // Filter devices by zone name (case-insensitive)
    // device.zone is a zone ID, so we need to look it up in zones
    const devicesInZone = Object.values(devices).filter(device => {
      if (!device.zone) return false;
      const deviceZone = zones[device.zone];
      return deviceZone && deviceZone.name.toLowerCase() === zoneName.toLowerCase();
    });

    if (devicesInZone.length === 0) {
      return {
        success: false,
        error: `No devices found in zone "${zoneName}"`,
        availableZones: Object.values(zones).map(z => z.name)
      };
    }

    const deviceList = devicesInZone.map(d => ({
      name: d.name,
      id: d.id,
      class: d.class,
      capabilities: Object.keys(d.capabilitiesObj || {}),
      available: d.available !== false
    }));

    return {
      success: true,
      zone: zoneName,
      deviceCount: deviceList.length,
      devices: deviceList,
      message: `Found ${deviceList.length} device(s) in ${zoneName}`
    };
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
   * List ALL devices in the home with their states
   */
  async listAllDevices() {
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
        zone: d.zone?.name || "Unknown",
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
      message: `Found ${deviceList.length} device(s) in the home`
    };
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

    // Normalize class name for comparison
    const normalizedClass = deviceClass.toLowerCase();

    // Filter devices by class
    const filteredDevices = Object.values(devices).filter(d =>
      d.class && d.class.toLowerCase() === normalizedClass
    );

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

    const deviceList = filteredDevices.map(d => {
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
        zone: d.zone && zones[d.zone] ? zones[d.zone].name : "Unknown",
        capabilities: Object.keys(d.capabilitiesObj || {}),
        state: state,
        available: d.available !== false
      };
    });

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
      message: `Found ${deviceList.length} ${deviceClass} device(s)`
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
   * Get summary of all lights with on/off count
   * Useful for queries like "how many lights are on?"
   * COMMENTED OUT: Use get_devices_status_by_class with deviceClass="light" instead
   */
  /*
  async getLightsStatus() {
    try {
      await this.initialize();
      const devices = await this.api.devices.getDevices();
      const zones = await this.api.zones.getZones();
      
      const lights = Object.values(devices).filter(d => d.class === 'light');
      
      // Map lights with proper zone names
      const lightsWithZones = lights.map(d => ({
        name: d.name,
        zone: d.zone && zones[d.zone] ? zones[d.zone].name : 'Unknown',
        onoff: d.capabilitiesObj?.onoff?.value || false,
        dim: d.capabilitiesObj?.dim?.value || null
      }));
      
      const lightsOn = lightsWithZones.filter(d => d.onoff === true);
      const lightsOff = lightsWithZones.filter(d => d.onoff === false);
      
      return {
        success: true,
        summary: {
          totalLights: lights.length,
          lightsOn: lightsOn.length,
          lightsOff: lightsOff.length,
          percentageOn: lights.length > 0 
            ? Math.round((lightsOn.length / lights.length) * 100) 
            : 0
        },
        lightsOn: lightsOn,
        lightsOff: lightsOff
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  */

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
      let classDevices = Object.values(devices).filter(d => d.class === deviceClass);

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

        classDevices = classDevices.filter(d => d.zone === targetZone.id);
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

      // Map devices with proper zone names
      const devicesWithZones = classDevices.map(d => ({
        name: d.name,
        zone: d.zone && zones[d.zone] ? zones[d.zone].name : 'Unknown',
        onoff: d.capabilitiesObj?.onoff?.value ?? null,
        dim: d.capabilitiesObj?.dim?.value ?? null,
        available: d.available
      }));

      const devicesOn = devicesWithZones.filter(d => d.onoff === true);
      const devicesOff = devicesWithZones.filter(d => d.onoff === false);
      const devicesUnknown = devicesWithZones.filter(d => d.onoff === null);

      return {
        success: true,
        deviceClass,
        zone: zoneName || 'all',
        classInfo: this.deviceClasses.classes[deviceClass],
        summary: {
          total: classDevices.length,
          on: devicesOn.length,
          off: devicesOff.length,
          unknown: devicesUnknown.length,
          percentageOn: classDevices.length > 0
            ? Math.round((devicesOn.length / classDevices.length) * 100)
            : 0
        },
        devicesOn: devicesOn,
        devicesOff: devicesOff,
        devicesUnknown: devicesUnknown
      };
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

    devices.forEach(d => {
      if (!summary.byClass[d.class]) {
        summary.byClass[d.class] = { total: 0, on: 0, off: 0 };
      }

      summary.byClass[d.class].total++;

      if (d.capabilitiesObj?.onoff?.value === true) {
        summary.byClass[d.class].on++;
      } else if (d.capabilitiesObj?.onoff) {
        summary.byClass[d.class].off++;
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
   * Schedule a command to be executed at a future time
   * @param {string} command - Natural language command to execute
   * @param {string} executeAt - ISO 8601 datetime
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

      // Parse executeAt as UTC (Gemini now correctly converts local → UTC)
      const executeDate = new Date(executeAt);
      const now = new Date();

      this.homey.log(`[scheduleCommand] Scheduled for: ${executeDate.toISOString()} (current: ${now.toISOString()})`);

      // Validation
      if (isNaN(executeDate.getTime())) {
        return {
          success: false,
          error: 'Invalid datetime format. Use ISO 8601 format (e.g., 2026-01-17T17:00:00Z)'
        };
      }

      const delayMs = executeDate.getTime() - now.getTime();

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
        executeAt: executeDate.toISOString(),
        description,
        createdAt: now.toISOString(),
        status: 'pending'
      };
      this.homey.settings.set('scheduled_commands', scheduledCommands);

      this.homey.log(`[scheduleCommand] Scheduled ${scheduleId} for ${executeDate.toISOString()} (in ${delayMinutes} minutes)`);

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
        timeInfo = `${Math.round(actualDelayMs / 1000)} secondi`;
      } else if (delayMinutes < 60) {
        timeInfo = `${delayMinutes} minuto${delayMinutes !== 1 ? 'i' : ''}`;
      } else if (delayHours < 48) {
        timeInfo = `${delayHours} ora${delayHours !== 1 ? 'e' : ''}`;
      } else {
        timeInfo = `${delayDays} giorno${delayDays !== 1 ? 'i' : ''}`;
      }

      return {
        success: true,
        scheduleId,
        command,
        executeAt: executeDate.toISOString(),
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
          schedule_id: scheduleId,
          command: command,
          success: result.success,
          response: result.response
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
}

module.exports = { HomeyMCPAdapter };
