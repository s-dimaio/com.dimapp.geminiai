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
      const capabilitiesPath = path.join(__dirname, 'homey_capabilities.json');
      this.deviceClasses = JSON.parse(fs.readFileSync(classesPath, 'utf8'));
      this.capabilities = JSON.parse(fs.readFileSync(capabilitiesPath, 'utf8'));
    } catch (error) {
      this.homey.log('Warning: Could not load reference files:', error.message);
      this.deviceClasses = { classes: {} };
      this.capabilities = { capabilities: {} };
    }
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
          description: "REQUIRED to control any Homey smart home device. Use this to turn lights on/off, adjust brightness, change temperature, etc. This is your ONLY way to interact with physical devices.",
          inputSchema: {
            type: "object",
            properties: {
              deviceName: {
                type: "string",
                description: "Name of the device to control (e.g., 'Living Room Light', 'Bedroom Thermostat')"
              },
              capability: {
                type: "string",
                description: "Capability to control. Common values: 'onoff' (on/off), 'dim' (brightness 0-1), 'target_temperature' (degrees), 'windowcoverings_state' (up/idle/down)"
              },
              value: {
                description: "Value to set. Boolean for onoff, number 0-1 for dim, number for temperature, string for others"
              }
            },
            required: ["deviceName", "capability", "value"]
          }
        },
        {
          name: "trigger_flow",
          description: "REQUIRED to trigger/start Homey Flows (automations). This is your ONLY way to activate complex automations or scenes.",
          inputSchema: {
            type: "object",
            properties: {
              flowName: {
                type: "string",
                description: "Exact name of the Flow to trigger"
              }
            },
            required: ["flowName"]
          }
        },
        {
          name: "get_device_state",
          description: "REQUIRED to check the current state of any Homey device (is light on/off, current temperature, etc.). This is your ONLY way to read device states.",
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
          description: "REQUIRED to discover and list all smart devices in a zone/room with their current states and capabilities. Use this to find lights, thermostats, sensors, etc. This is your ONLY way to discover what devices exist in the home.",
          inputSchema: {
            type: "object",
            properties: {
              zoneName: {
                type: "string",
                description: "Name of the zone/room (e.g., 'living room', 'bedroom', 'kitchen')"
              }
            },
            required: ["zoneName"]
          }
        },
        {
          name: "list_zones",
          description: "REQUIRED to discover all rooms/zones in the home. Use this to find which rooms exist before trying to list or control devices in a specific zone. This is your ONLY way to see all available rooms.",
          inputSchema: {
            type: "object",
            properties: {},
            required: []
          }
        },
        {
          name: "list_all_devices",
          description: "REQUIRED to get a complete list of ALL smart devices in the entire home with their current states. Use this when you need to count devices, find all lights, or get an overview of the whole home. This is your ONLY way to see all devices at once.",
          inputSchema: {
            type: "object",
            properties: {},
            required: []
          }
        },
        {
          name: "list_devices_by_class",
          description: "REQUIRED to filter and list all devices of a specific type/class (e.g., all lights, all thermostats, all sensors). Use this when you need to find all devices of the same type. Available classes: light, socket, thermostat, lock, sensor, speaker, tv, fan, heater, camera, doorbell, blinds, curtain, sunshade, and more.",
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
          description: "Get detailed list of devices of a specific class with their on/off status. Can be filtered by zone/room or return all devices in the entire home. USE THIS for questions like 'which lights are on?', 'lights in the kitchen' (with zone: 'Kitchen'), 'all sockets in bedroom' (with zone: 'Bedroom'), or 'show all thermostats' (without zone). Returns separate lists of devices that are on and devices that are off with their zone names.",
          inputSchema: {
            type: "object",
            properties: {
              deviceClass: {
                type: "string",
                description: "Device class to get status for (light, socket, thermostat, fan, switch, camera, lock, speaker, sensor, etc)"
              },
              zone: {
                type: "string",
                description: "Optional: Zone/room name to filter devices (e.g., 'Kitchen', 'Bedroom', 'Camera di Camilla'). If not specified, returns all devices of the class from the entire home."
              }
            },
            required: ["deviceClass"]
          }
        },
        {
          name: "get_device_count_by_zone",
          description: "Get device count and status summary for a SPECIFIC zone/room. ✅ USE THIS for zone-specific questions like 'are there lights on in the kitchen?', 'how many lights in the bedroom?', 'what's on in the bathroom?'. Returns counts by device class (light, socket, etc) with on/off status for the specified zone. ⚠️ This is the CORRECT tool whenever the user mentions a specific room/zone name. Do NOT use get_devices_status_by_class for zone-specific queries.",
          inputSchema: {
            type: "object",
            properties: {
              zone: {
                type: "string",
                description: "Zone/room name (e.g., 'Living Room', 'Kitchen', 'Camera di Camilla'). Leave empty to get summary for all zones."
              }
            }
          }
        },
        {
          name: "get_capability_info",
          description: "Get information about device capabilities or search for the correct capability name. USE THIS when: user mentions 'brightness' (→dim), 'temperature' (→target_temperature or measure_temperature), 'volume' (→volume_set), or any non-standard term. Returns capability details including type, range, and examples.",
          inputSchema: {
            type: "object",
            properties: {
              capability: {
                type: "string",
                description: "Exact capability name to get info about (e.g., 'dim', 'onoff', 'target_temperature'). Leave empty to search."
              },
              searchTerm: {
                type: "string",
                description: "Search term to find capabilities (e.g., 'brightness', 'temp', 'power', 'volume'). Use when user term doesn't match exact capability name."
              }
            }
          }
        },
        {
          name: "get_device_class_info",
          description: "Get information about device classes or search for the correct class name. USE THIS when: user says 'lights' (→light), 'plugs' (→socket), 'heating' (→thermostat), or any plural/informal term. Returns class details including common capabilities and icon.",
          inputSchema: {
            type: "object",
            properties: {
              className: {
                type: "string",
                description: "Exact device class name (e.g., 'light', 'socket', 'thermostat'). Leave empty to search."
              },
              searchTerm: {
                type: "string",
                description: "Search term to find device classes (e.g., 'lights', 'plug', 'heating', 'window'). Use when user term doesn't match exact class name."
              }
            }
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
        
        case "get_capability_info":
          return await this.getCapabilityInfo(args.capability, args.searchTerm);
        
        case "get_device_class_info":
          return await this.getDeviceClassInfo(args.className, args.searchTerm);
        
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
   * Validate capability value against expected type and range
   * @param {string} capability - Capability name
   * @param {any} value - Value to validate
   * @returns {Object} Validation result with valid flag and error message
   */
  validateCapabilityValue(capability, value) {
    const capInfo = this.capabilities.capabilities?.[capability];
    
    // If capability not in reference data, allow it (backward compatibility)
    if (!capInfo) {
      return { valid: true };
    }

    // Type validation
    if (capInfo.type === 'boolean') {
      if (typeof value !== 'boolean' && value !== 'true' && value !== 'false') {
        return {
          valid: false,
          error: `Capability "${capability}" expects a boolean value (true/false)`,
          expectedType: 'boolean',
          examples: capInfo.examples
        };
      }
    }

    if (capInfo.type === 'number') {
      const numValue = typeof value === 'number' ? value : parseFloat(value);
      
      if (isNaN(numValue)) {
        return {
          valid: false,
          error: `Capability "${capability}" expects a number`,
          expectedType: 'number',
          examples: capInfo.examples
        };
      }

      // Range validation
      if (capInfo.min !== undefined && numValue < capInfo.min) {
        return {
          valid: false,
          error: `Value ${numValue} is below minimum ${capInfo.min} for capability "${capability}"`,
          expectedRange: { min: capInfo.min, max: capInfo.max },
          examples: capInfo.examples
        };
      }

      if (capInfo.max !== undefined && numValue > capInfo.max) {
        return {
          valid: false,
          error: `Value ${numValue} exceeds maximum ${capInfo.max} for capability "${capability}"`,
          expectedRange: { min: capInfo.min, max: capInfo.max },
          examples: capInfo.examples
        };
      }
    }

    if (capInfo.type === 'enum') {
      if (!capInfo.values || !capInfo.values.includes(value)) {
        return {
          valid: false,
          error: `Invalid value "${value}" for capability "${capability}"`,
          expectedType: 'enum',
          allowedValues: capInfo.values,
          examples: capInfo.examples
        };
      }
    }

    // Check if capability is read-only
    if (capInfo.getable && !capInfo.setable) {
      return {
        valid: false,
        error: `Capability "${capability}" is read-only and cannot be set`,
        note: capInfo.notes
      };
    }

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
   * Get information about a specific capability or search for capabilities
   * @param {string} capability - Exact capability name (optional)
   * @param {string} searchTerm - Search term for fuzzy matching (optional)
   * @returns {Promise<Object>} Capability information or search results
   */
  async getCapabilityInfo(capability = null, searchTerm = null) {
    try {
      // Get info for specific capability
      if (capability) {
        const info = this.capabilities.capabilities[capability];
        if (info) {
          return {
            success: true,
            capability,
            type: info.type,
            title: info.title,
            description: info.description,
            getable: info.getable,
            setable: info.setable,
            min: info.min,
            max: info.max,
            units: info.units,
            values: info.values,
            examples: info.examples,
            notes: info.notes
          };
        }
        
        // Capability not found - suggest similar ones
        const allCapabilities = Object.keys(this.capabilities.capabilities);
        const suggestion = this.suggestCapability(capability, allCapabilities);
        
        return {
          success: false,
          error: `Capability "${capability}" not found`,
          suggestion: suggestion ? `Did you mean '${suggestion}'?` : null,
          hint: "Use searchTerm parameter to search for capabilities"
        };
      }
      
      // Search for capabilities
      if (searchTerm) {
        const searchLower = searchTerm.toLowerCase();
        
        // Fuzzy search in capability names, titles, and descriptions
        const matches = Object.entries(this.capabilities.capabilities)
          .filter(([name, info]) => 
            name.toLowerCase().includes(searchLower) ||
            info.title.toLowerCase().includes(searchLower) ||
            (info.description && info.description.toLowerCase().includes(searchLower))
          )
          .slice(0, 10)  // Limit to 10 results
          .map(([name, info]) => ({
            name,
            title: info.title,
            type: info.type,
            description: info.description,
            setable: info.setable,
            getable: info.getable
          }));
        
        if (matches.length === 0) {
          return {
            success: false,
            searchTerm,
            error: `No capabilities found matching "${searchTerm}"`,
            hint: "Try broader terms like 'light', 'temp', 'power', 'volume'",
            availableGroups: Object.keys(this.capabilities.capabilityGroups || {})
          };
        }
        
        return {
          success: true,
          searchTerm,
          matchCount: matches.length,
          matches
        };
      }
      
      // No parameters - return most common capabilities
      const commonCapabilities = [
        'onoff', 'dim', 'target_temperature', 'measure_temperature',
        'locked', 'volume_set', 'windowcoverings_state', 'alarm_motion',
        'measure_power', 'meter_power'
      ];
      
      const capList = commonCapabilities.map(cap => {
        const info = this.capabilities.capabilities[cap];
        return {
          name: cap,
          title: info?.title,
          type: info?.type,
          setable: info?.setable
        };
      }).filter(c => c.title);
      
      return {
        success: true,
        message: "Most common capabilities",
        capabilities: capList,
        totalAvailable: Object.keys(this.capabilities.capabilities).length,
        hint: "Use 'capability' parameter for details or 'searchTerm' to search"
      };
      
    } catch (error) {
      return { success: false, error: error.message };
    }
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
}

module.exports = { HomeyMCPAdapter };
