'use strict';

const { HomeyAPIV3Local } = require('homey-api');
const fs = require('fs');
const path = require('path');
const { getTools } = require('./ToolSchema');
const { Scheduler } = require('./Scheduler');

/**
 * HomeyMCPAdapter
 *
 * Bridges Homey's runtime APIs with the MCP (Model Context Protocol) tool interface
 * consumed by GeminiClient. Each public method corresponds to one MCP tool that
 * Gemini can invoke. Tool schemas are defined in {@link module:ToolSchema}.
 * Command scheduling is delegated to {@link Scheduler}.
 */
class HomeyMCPAdapter {

  /**
   * Creates a new HomeyMCPAdapter instance.
   *
   * @public
   * @param {import('homey')} homey - The Homey app instance.
   * @example
   * const adapter = new HomeyMCPAdapter(homey);
   * await adapter.initialize();
   */
  constructor(homey) {
    this.homey = homey;

    /** @type {?HomeyAPIV3Local} Cached Homey API instance, initialised on first use */
    this.api = null;

    // Load reference file for device class validation and suggestions
    try {
      const classesPath = path.join(__dirname, 'homey_device_classes.json');
      this.deviceClasses = JSON.parse(fs.readFileSync(classesPath, 'utf8'));
    } catch (error) {
      this.homey.log('Warning: Could not load reference files:', error.message);
      this.deviceClasses = { classes: {} };
    }

    /** @type {Scheduler} Handles timed command execution */
    this.scheduler = new Scheduler(homey);
  }

  // ── Public Methods ──────────────────────────────────────────────────────────

  /**
   * Initialises the HomeyAPI instance (idempotent).
   *
   * Must be called before any method that accesses devices, zones, or flows.
   * Subsequent calls are no-ops if the API is already initialised.
   *
   * @public
   * @returns {Promise<void>}
   * @throws {Error} If the Homey API cannot be initialised.
   * @example
   * await adapter.initialize();
   */
  async initialize() {
    if (!this.api) {
      this._sessionToken = await this.homey.api.getOwnerApiToken();
      this._localUrl = await this.homey.api.getLocalUrl();

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
   * Returns the full list of MCP tool definitions consumed by GeminiClient.
   *
   * Delegates to {@link module:ToolSchema.getTools} — this method has no
   * dependency on the Homey runtime.
   *
   * @public
   * @returns {Promise<{tools: Object[]}>} Object containing the tools array.
   * @example
   * const { tools } = await adapter.listTools();
   * // tools.length === 19
   */
  async listTools() {
    return { tools: getTools() };
  }

  /**
   * Dispatches an MCP tool call to the corresponding adapter method.
   *
   * Ensures the Homey API is initialised before every call and wraps execution
   * in a top-level try/catch so that unexpected errors are returned as
   * `{ success: false, error }` rather than thrown.
   *
   * @public
   * @param {string} name - MCP tool name (e.g. `'control_device'`).
   * @param {Object} args - Tool arguments as defined in the tool schema.
   * @returns {Promise<Object>} Execution result with at least a `success` boolean.
   * @throws Never — errors are caught and returned as `{ success: false, error, stack }`.
   * @example
   * const result = await adapter.callTool('control_device', {
   *   deviceName: 'Living Room Light',
   *   capability: 'onoff',
   *   value: true
   * });
   */
  async callTool(name, args) {
    try {
      await this.initialize();

      switch (name) {
        case 'control_device':
          return await this.controlDevice(args.deviceName, args.capability, args.value, args.deviceId || null);
        case 'trigger_flow':
          return await this.triggerFlow(args.flowName, args.args);
        case 'get_device_state':
          return await this.getDeviceState(args.deviceName);
        case 'list_devices_in_zone':
          return await this.listDevicesInZone(args.zoneName);
        case 'list_zones':
          return await this.listZones();
        case 'list_all_devices':
          return await this.listAllDevices();
        case 'list_devices_by_class':
          return await this.listDevicesByClass(args.deviceClass);
        case 'get_devices_status_by_class':
          return await this.getDevicesStatusByClass(args.deviceClass, args.zone);
        case 'get_device_count_by_zone':
          return await this.getDeviceCountByZone(args.zone);
        case 'get_device_class_info':
          return await this.getDeviceClassInfo(args.className, args.searchTerm);
        case 'schedule_command':
          return await this.scheduler.scheduleCommand(args.command, args.executeAt, args.description);
        case 'list_flows':
          return await this.listFlows(args.enabled, args.folder, args.type);
        case 'get_flow_info':
          return await this.getFlowInfo(args.flowName);
        case 'search_devices':
          return await this.searchDevices(args.query);
        case 'list_device_actions':
          return await this.listDeviceActions(args.deviceName);
        case 'run_action_card':
          return await this.runActionCard(args.deviceName, args.cardId, args.args);
        case 'get_device_image':
          return await this.getDeviceImage(args.deviceName);
        case 'get_device_history':
          return await this.getDeviceHistory(args.deviceName);
        case 'get_log_entries':
          return await this.getLogEntries(args.deviceName, args.logId, args.resolution);
        default:
          return { success: false, error: `Unknown tool: ${name}` };
      }
    } catch (error) {
      return { success: false, error: error.message, stack: error.stack };
    }
  }

  /**
   * Controls a Homey device by setting a specific capability value.
   *
   * Performs three validation steps before executing:
   * 1. Required parameter check.
   * 2. Device existence check (exact case-insensitive name match).
   * 3. Capability existence check with Levenshtein-based suggestion.
   *
   * @public
   * @param {string} deviceName - Exact device name (case-insensitive).
   * @param {string} capability - Capability identifier (e.g. `'onoff'`, `'dim'`, `'target_temperature'`).
   * @param {boolean|number|string} value - Value to set; type must match the capability.
   * @returns {Promise<Object>} Result with `success`, `device`, `capability`, `value`, `zone`, `message`.
   * @throws Never — errors are returned as `{ success: false, error }`.
   * @example
   * const result = await adapter.controlDevice('Living Room Light', 'onoff', true);
   * // { success: true, device: 'Living Room Light', capability: 'onoff', value: true, zone: 'Living Room', message: '...' }
   */
  async controlDevice(deviceName, capability, value, deviceId = null) {
    if (!deviceName && !deviceId) {
      return { success: false, error: "Missing required parameter: provide 'deviceName' or 'deviceId'." };
    }
    if (!capability) {
      return { success: false, error: "Missing required parameter 'capability'. Common values: 'onoff', 'dim', 'target_temperature'." };
    }
    if (value === undefined || value === null) {
      return { success: false, error: "Missing required parameter 'value'. Specify the value to set (e.g., true/false, 0-1, temperature)." };
    }

    const devices = await this.api.devices.getDevices();
    const zones = await this.api.zones.getZones();

    let device;

    if (deviceId) {
      // Unambiguous lookup by UUID
      device = Object.values(devices).find(d => d.id === deviceId);
      if (!device) {
        return { success: false, error: `Device with id "${deviceId}" not found. Call list_devices_in_zone or list_all_devices to get valid device IDs.` };
      }
    } else {
      // Name-based lookup — detect omonimia
      const matches = Object.values(devices).filter(d =>
        d.name.toLowerCase() === deviceName.toLowerCase()
      );

      if (matches.length === 0) {
        return {
          success: false,
          error: `Device "${deviceName}" not found. You must call list_devices_in_zone or list_all_devices first to see the exact device names, then call control_device again with the exact name from that list.`,
          required_action: 'Call list_devices_in_zone or list_all_devices to see available devices'
        };
      }

      if (matches.length > 1) {
        // Multiple devices share the same name — cannot proceed safely
        return {
          success: false,
          ambiguous: true,
          error: `Multiple devices named "${deviceName}" found. Ask the user which one they mean, then retry control_device using the deviceId of the correct device.`,
          matches: matches.map(d => ({
            name: d.name,
            id: d.id,
            zone: d.zone && zones[d.zone] ? zones[d.zone].name : 'Unknown'
          }))
        };
      }

      device = matches[0];
    }

    if (!device.capabilitiesObj || !device.capabilitiesObj[capability]) {
      const availableCaps = Object.keys(device.capabilitiesObj || {});
      const suggestion = this._suggestCapability(capability, availableCaps);
      return {
        success: false,
        error: `Capability "${capability}" not found on device "${deviceName}". You MUST now call list_device_actions("${deviceName}") to find the correct Action Card for this operation.`,
        availableCapabilities: availableCaps,
        suggestion: suggestion ? `Did you mean '${suggestion}'?` : null,
        required_action: `Call list_device_actions with deviceName="${deviceName}" to see available actions`
      };
    }

    const validation = this._validateCapabilityValue(capability, value);
    if (!validation.valid) {
      return { success: false, error: validation.error, expectedType: validation.expectedType, expectedRange: validation.expectedRange };
    }

    // Coerce value to correct type
    let convertedValue = value;
    if (capability === 'onoff') {
      convertedValue = value === 'true' || value === true;
    } else if (capability === 'dim' || capability === 'volume_set' || capability === 'target_temperature') {
      convertedValue = parseFloat(value);
    }

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

    const zoneName = device.zone && zones[device.zone] ? zones[device.zone].name : 'Unknown';

    return {
      success: true,
      device: device.name,
      capability,
      value: convertedValue,
      zone: zoneName,
      message: `Successfully set ${capability} to ${convertedValue} on ${device.name}`
    };
  }

  /**
   * Triggers a Homey Flow (standard or Advanced) by name.
   *
   * Uses the HomeyScript proxy to obtain the `homey.flow.start` scope
   * that third-party apps cannot request directly.
   *
   * @public
   * @param {string} flowName - Exact flow name (case-insensitive).
   * @param {Object} [args={}] - Optional arguments/tokens for Advanced Flows.
   * @returns {Promise<Object>} Result with `success`, `flowName`, `flowId`, `flowType`, `message`.
   * @throws Never — errors are returned as `{ success: false, error }`.
   * @example
   * const result = await adapter.triggerFlow('Good Morning');
   * // { success: true, flowName: 'Good Morning', flowType: 'standard', ... }
   */
  async triggerFlow(flowName, args = {}) {
    if (!flowName) {
      return { success: false, error: "Missing required parameter 'flowName'. Please specify the name of the Flow to trigger." };
    }

    await this.initialize();

    try {
      const standardFlows = await this.api.flow.getFlows();
      const advancedFlows = await this.api.flow.getAdvancedFlows();

      let flow = Object.values(standardFlows).find(f => f.name.toLowerCase() === flowName.toLowerCase());
      let flowType = 'standard';

      if (!flow) {
        flow = Object.values(advancedFlows).find(f => f.name.toLowerCase() === flowName.toLowerCase());
        flowType = 'advanced';
      }

      if (!flow) {
        const allFlows = [...Object.values(standardFlows), ...Object.values(advancedFlows)];
        return { success: false, error: `Flow "${flowName}" not found`, availableFlows: allFlows.map(f => f.name) };
      }

      this.homey.log(`[HomeyMCPAdapter] Found flow: ${flow.name}, type: ${flowType}, triggerable: ${flow.triggerable}, id: ${flow.id}`);

      if (flow.triggerable === false) {
        return {
          success: false,
          error: `Flow "${flow.name}" cannot be manually triggered. Only flows with a "This Flow is started" trigger card can be manually triggered.`,
          flowName: flow.name,
          flowId: flow.id,
          flowType
        };
      }

      this.homey.log(`[HomeyMCPAdapter] Triggering ${flowType} flow via HomeyScript proxy, id: ${flow.id}`);
      await this._triggerFlowViaHomeyScript(flow.id, flowType, args);

      return {
        success: true,
        flowName: flow.name,
        flowId: flow.id,
        flowType,
        triggeredWithArgs: args,
        message: `Successfully triggered ${flowType} flow "${flow.name}"`
      };

    } catch (err) {
      this.homey.error('[HomeyMCPAdapter] triggerFlow Error:', err.message);
      return { success: false, error: `Failed to trigger flow "${flowName}": ${err.message}` };
    }
  }

  /**
   * Lists Homey Flows (standard and/or Advanced) with optional filters.
   *
   * @public
   * @param {boolean|null} [enabled=null] - Filter by enabled status; `null` returns all.
   * @param {string|null} [folder=null] - Filter by folder name (case-insensitive).
   * @param {string} [type='all'] - Filter by type: `'standard'`, `'advanced'`, or `'all'`.
   * @returns {Promise<Object>} Result with `success`, `summary`, `flows`, `message`.
   * @throws Never — errors are returned as `{ success: false, error }`.
   * @example
   * const result = await adapter.listFlows(true, null, 'advanced');
   * // Returns all enabled Advanced Flows
   */
  async listFlows(enabled = null, folder = null, type = 'all') {
    try {
      await this.initialize();

      const standardFlows = await this.api.flow.getFlows();
      const advancedFlows = await this.api.flow.getAdvancedFlows();

      let allFlows = [
        ...Object.values(standardFlows).map(f => ({ ...f, type: 'standard' })),
        ...Object.values(advancedFlows).map(f => ({ ...f, type: 'advanced' }))
      ];

      if (enabled !== null) allFlows = allFlows.filter(f => f.enabled === enabled);
      if (folder) allFlows = allFlows.filter(f => f.folder && f.folder.toLowerCase() === folder.toLowerCase());
      if (type && type !== 'all') allFlows = allFlows.filter(f => f.type === type);

      const flowList = allFlows.map(f => ({
        name: f.name,
        id: f.id,
        enabled: f.enabled !== false,
        folder: f.folder || null,
        type: f.type
      }));

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
      return { success: false, error: error.message };
    }
  }

  /**
   * Returns detailed information about a specific Homey Flow.
   *
   * Searches both standard and Advanced Flows. If not found, suggests
   * similar flow names using partial string matching.
   *
   * @public
   * @param {string} flowName - Flow name to look up (case-insensitive).
   * @returns {Promise<Object>} Result with `success`, `flow` details, and `message`.
   * @throws Never — errors are returned as `{ success: false, error }`.
   * @example
   * const result = await adapter.getFlowInfo('Good Morning');
   * // { success: true, flow: { name: 'Good Morning', type: 'standard', enabled: true, ... } }
   */
  async getFlowInfo(flowName) {
    if (!flowName) {
      return { success: false, error: "Missing required parameter 'flowName'. Please specify the name of the Flow." };
    }

    try {
      await this.initialize();

      const standardFlows = await this.api.flow.getFlows();
      const advancedFlows = await this.api.flow.getAdvancedFlows();

      let flow = Object.values(standardFlows).find(f => f.name.toLowerCase() === flowName.toLowerCase());
      let flowType = 'standard';

      if (!flow) {
        flow = Object.values(advancedFlows).find(f => f.name.toLowerCase() === flowName.toLowerCase());
        flowType = 'advanced';
      }

      if (!flow) {
        const allFlows = [...Object.values(standardFlows), ...Object.values(advancedFlows)];
        const suggestion = this._suggestDeviceClass(flowName, allFlows.map(f => f.name));
        return {
          success: false,
          error: `Flow "${flowName}" not found.${suggestion ? ` Did you mean "${suggestion}"?` : ''} Call list_flows to get all available flow names, then retry using one of the exact names in availableFlows.`,
          availableFlows: allFlows.map(f => f.name),
          suggestion: suggestion || null
        };
      }

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
      return { success: false, error: error.message };
    }
  }

  /**
   * Returns the current state of a Homey device.
   *
   * Collects all capability values from `device.capabilitiesObj` and returns
   * them as a flat `state` object.
   *
   * @public
   * @param {string} deviceName - Exact device name (case-insensitive).
   * @returns {Promise<Object>} Result with `success`, `device`, `class`, `zone`, `state`, `available`.
   * @throws Never — errors are returned as `{ success: false, error }`.
   * @example
   * const result = await adapter.getDeviceState('Bedroom Thermostat');
   * // { success: true, state: { measure_temperature: 21.5, target_temperature: 22, ... } }
   */
  async getDeviceState(deviceName) {
    if (!deviceName) {
      return { success: false, error: "Missing required parameter 'deviceName'. Please specify which device to query." };
    }

    const devices = await this.api.devices.getDevices();
    const zones = await this.api.zones.getZones();

    const device = Object.values(devices).find(d => d.name.toLowerCase() === deviceName.toLowerCase());

    if (!device) {
      return { success: false, error: `Device "${deviceName}" not found` };
    }

    const state = {};
    if (device.capabilitiesObj) {
      for (const [capName, capObj] of Object.entries(device.capabilitiesObj)) {
        state[capName] = capObj.value;
      }
    }

    const zoneName = device.zone && zones[device.zone] ? zones[device.zone].name : 'Unknown';

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
   * Lists all devices in a zone and its sub-zones.
   *
   * Returns a minimal discovery payload (name, id, class, zone, available) only.
   * Use `get_device_details(deviceId)` to retrieve capabilities, action cards and
   * current state for the device(s) you intend to interact with.
   *
   * @public
   * @param {string} zoneName - Zone/room name (case-insensitive).
   * @returns {Promise<Object>} Result with `success`, `zone`, `deviceCount`, `devices`, `message`.
   * @throws Never — errors are returned as `{ success: false, error }`.
   * @example
   * const result = await adapter.listDevicesInZone('Kitchen');
   * // { success: true, zone: 'Kitchen', deviceCount: 5, devices: [{ name, id, class, available }] }
   */
  async listDevicesInZone(zoneName) {
    if (!zoneName) {
      return { success: false, error: "Missing required parameter 'zoneName'. Please specify the room/zone name (e.g., 'Living Room', 'Kitchen')." };
    }

    try {
      await this.initialize();

      const devices = await this.api.devices.getDevices();
      const zones = await this.api.zones.getZones();

      const targetZone = Object.values(zones).find(z => z.name.toLowerCase() === zoneName.toLowerCase());

      if (!targetZone) {
        return { success: false, error: `Zone "${zoneName}" not found. Retry list_devices_in_zone using one of the exact names in availableZones.`, availableZones: Object.values(zones).map(z => z.name) };
      }

      const targetZoneIds = this._getAllChildZoneIds(targetZone.id, zones);
      const devicesInZone = Object.values(devices).filter(d => d.zone && targetZoneIds.includes(d.zone));

      if (devicesInZone.length === 0) {
        return { success: false, error: `No devices found in zone "${zoneName}" (including sub-zones). Retry list_devices_in_zone using one of the exact names in availableZones.`, availableZones: Object.values(zones).map(z => z.name) };
      }

      // Minimal discovery payload — intentionally excludes id, capabilities and actionCards.
      // Call list_device_actions(deviceName) to get available actions for a specific device.
      const deviceList = devicesInZone.map(d => ({
        name: d.name,
        class: d.class,
        available: d.available !== false
      }));

      return {
        success: true,
        zone: zoneName,
        deviceCount: deviceList.length,
        devices: deviceList,
        message: `Found ${deviceList.length} device(s) in ${zoneName}. Use list_device_actions(deviceName) to get available actions for a specific device.`
      };

    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Lists all zones/rooms in the home with their parent hierarchy.
   *
   * @public
   * @returns {Promise<Object>} Result with `success`, `totalZones`, `zones`, `message`.
   * @throws Never — errors are returned as `{ success: false, error }`.
   * @example
   * const result = await adapter.listZones();
   * // { success: true, totalZones: 8, zones: [{ name: 'Living Room', id: '...', parent: null }] }
   */
  async listZones() {
    const zones = await this.api.zones.getZones();

    const zoneList = Object.values(zones).map(z => ({
      name: z.name,
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
   * Lists every device in the home.
   *
   * Returns a minimal discovery payload (name, id, class, zone, available) only.
   * Use `get_device_details(deviceId)` to retrieve capabilities, action cards and
   * current state for the device(s) you intend to interact with.
   *
   * @public
   * @returns {Promise<Object>} Result with `success`, `totalDevices`, `devices`, `zonesCount`.
   * @throws Never — errors are returned as `{ success: false, error }`.
   * @example
   * const result = await adapter.listAllDevices();
   * // { success: true, totalDevices: 42, devices: [{ name, id, class, zone, available }] }
   */
  async listAllDevices() {
    try {
      await this.initialize();
      const devices = await this.api.devices.getDevices();
      const zones = await this.api.zones.getZones();

      // Minimal discovery payload — intentionally excludes id, capabilities, state and actionCards.
      // Use get_devices_status_by_class for per-class state queries.
      const deviceList = Object.values(devices).map(d => ({
        name: d.name,
        class: d.class,
        zone: d.zone && zones[d.zone] ? zones[d.zone].name : 'Unknown',
        available: d.available !== false
      }));

      return {
        success: true,
        totalDevices: deviceList.length,
        devices: deviceList,
        zonesCount: Object.keys(zones).length,
        message: `Found ${deviceList.length} device(s) in the home. Use list_device_actions(deviceName) to get available actions for a specific device.`
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Lists all devices of a specific class across the home.
   *
   * Uses `effectiveClass` (virtualClass || class) so that sockets configured
   * as lights via "What's plugged in?" are correctly included in `light` results.
   * Returns a minimal discovery payload only. Use `get_device_details(deviceId)`
   * to retrieve capabilities, action cards and current state for a specific device.
   *
   * @public
   * @param {string} deviceClass - Homey device class (e.g. `'light'`, `'thermostat'`, `'sensor'`).
   * @returns {Promise<Object>} Result with `success`, `deviceClass`, `deviceCount`, `devices`.
   * @throws Never — errors are returned as `{ success: false, error }`.
   * @example
   * const result = await adapter.listDevicesByClass('light');
   * // { success: true, deviceCount: 6, devices: [{ name, id, class, zone, available }] }
   */
  async listDevicesByClass(deviceClass) {
    if (!deviceClass) {
      return {
        success: false,
        error: "Missing required parameter 'deviceClass'. Please specify the device class (e.g., 'light', 'thermostat', 'sensor').",
        availableClasses: Object.keys(this.deviceClasses.classes || {})
      };
    }

    const devices = await this.api.devices.getDevices();
    const zones = await this.api.zones.getZones();

    const normalizedClass = deviceClass.toLowerCase();
    const filteredDevices = Object.values(devices).filter(d => {
      const effectiveClass = (d.virtualClass || d.class)?.toLowerCase();
      return effectiveClass === normalizedClass;
    });

    if (filteredDevices.length === 0) {
      const actualClasses = [...new Set(Object.values(devices)
        .flatMap(d => [d.virtualClass, d.class])
        .filter(Boolean)
      )];
      const suggestion = this._suggestDeviceClass(deviceClass, actualClasses);
      return {
        success: false,
        error: `No devices found with class "${deviceClass}".${suggestion ? ` Did you mean "${suggestion}"?` : ''} Retry list_devices_by_class using one of the exact values in availableClasses.`,
        availableClasses: actualClasses,
        suggestion: suggestion || null
      };
    }

    // Minimal discovery payload — intentionally excludes id, capabilities, actionCards and state.
    // Call get_device_details(deviceName) to get full details for a specific device.
    const deviceList = filteredDevices.map(d => ({
      name: d.name,
      class: d.class,
      virtualClass: d.virtualClass || null,
      effectiveClass: d.virtualClass || d.class,
      zone: d.zone && zones[d.zone] ? zones[d.zone].name : 'Unknown',
      available: d.available !== false
    }));

    return {
      success: true,
      deviceClass,
      deviceCount: deviceList.length,
      devices: deviceList,
      message: `Found ${deviceList.length} ${deviceClass} device(s). Use list_device_actions(deviceName) to get available actions for a specific device.`
    };
  }

  /**
   * Returns status of all devices of a specific class, optionally filtered by zone.
   *
   * Response format is conditional:
   * - If **all** devices have `onoff`: returns `devicesOn` / `devicesOff` arrays.
   * - If any device lacks `onoff` (locks, sensors, thermostats): returns a flat `devices` array.
   *
   * @public
   * @param {string} deviceClass - Homey device class to query.
   * @param {string|null} [zoneName=null] - Optional zone name filter (recursive, includes sub-zones).
   * @returns {Promise<Object>} Conditional result: either `devicesOn`/`devicesOff` or `devices`.
   * @throws Never — errors are returned as `{ success: false, error }`.
   * @example
   * const result = await adapter.getDevicesStatusByClass('light', 'Kitchen');
   * // { success: true, devicesOn: [...], devicesOff: [...], summary: { on: 2, off: 1 } }
   */
  async getDevicesStatusByClass(deviceClass, zoneName = null) {
    try {
      await this.initialize();

      if (!deviceClass || !this.deviceClasses.classes[deviceClass]) {
        const devices = await this.api.devices.getDevices();
        const actualClasses = [...new Set(Object.values(devices).map(d => d.class).filter(Boolean))];
        return { success: false, error: `Unknown device class: "${deviceClass}"`, availableClasses: actualClasses };
      }

      const devices = await this.api.devices.getDevices();
      const zones = await this.api.zones.getZones();

      let classDevices = Object.values(devices).filter(d => (d.virtualClass || d.class) === deviceClass);

      if (zoneName) {
        const targetZone = Object.values(zones).find(z => z.name.toLowerCase() === zoneName.toLowerCase());
        if (!targetZone) {
          return { success: false, error: `Zone "${zoneName}" not found`, availableZones: Object.values(zones).map(z => z.name) };
        }
        const targetZoneIds = this._getAllChildZoneIds(targetZone.id, zones);
        classDevices = classDevices.filter(d => d.zone && targetZoneIds.includes(d.zone));
      }

      if (classDevices.length === 0) {
        return {
          success: true, deviceClass, zone: zoneName || 'all',
          summary: { total: 0, on: 0, off: 0, unknown: 0, percentageOn: 0 },
          devicesOn: [], devicesOff: [], devicesUnknown: []
        };
      }

      // Build device state objects. capabilities list is omitted (use get_device_details).
      // classInfo is omitted to reduce token overhead on repeated recap calls.
      const devicesWithState = classDevices.map(d => {
        const state = {};
        const capabilityKeys = Object.keys(d.capabilitiesObj || {});
        if (d.capabilitiesObj) {
          for (const [capName, capObj] of Object.entries(d.capabilitiesObj)) {
            state[capName] = capObj.value;
          }
        }
        // Omit virtualClass/effectiveClass when null (= same as class) and available when true
        // to keep payload compact, especially for large classes like 'light'.
        const entry = {
          name: d.name,
          class: d.class,
          zone: d.zone && zones[d.zone] ? zones[d.zone].name : 'Unknown',
          state,
          _capKeys: capabilityKeys
        };
        if (d.virtualClass) {
          entry.virtualClass = d.virtualClass;
          entry.effectiveClass = d.virtualClass;
        }
        if (d.available === false) entry.available = false;
        return entry;
      });

      const allHaveOnOff = devicesWithState.every(d => d._capKeys.includes('onoff'));

      // Strip internal helper field before returning
      devicesWithState.forEach(d => delete d._capKeys);

      if (allHaveOnOff) {
        const devicesOn = devicesWithState.filter(d => d.state.onoff === true);
        const devicesOff = devicesWithState.filter(d => d.state.onoff === false);
        return {
          success: true, deviceClass, zone: zoneName || 'all',
          summary: {
            total: devicesWithState.length,
            on: devicesOn.length,
            off: devicesOff.length,
            percentageOn: devicesWithState.length > 0 ? Math.round((devicesOn.length / devicesWithState.length) * 100) : 0
          },
          devicesOn, devicesOff
        };
      } else {
        return {
          success: true, deviceClass, zone: zoneName || 'all',
          summary: { total: devicesWithState.length },
          devices: devicesWithState
        };
      }

    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Returns a device count and on/off summary for a zone and its sub-zones.
   *
   * Results are grouped by device class. If all devices in a class have `onoff`,
   * the summary includes `on`/`off` counts; otherwise only `total` is returned.
   *
   * @public
   * @param {string} zoneName - Zone/room name (case-insensitive).
   * @returns {Promise<Object>} Result with `success`, `zone`, `includesSubZones`, `summary`.
   * @throws Never — errors are returned as `{ success: false, error }`.
   * @example
   * const result = await adapter.getDeviceCountByZone('Kitchen');
   * // { success: true, zone: 'Kitchen', summary: { totalDevices: 5, byClass: { socket: { total: 2, on: 1, off: 1 } } } }
   */
  async getDeviceCountByZone(zoneName = null) {
    try {
      await this.initialize();
      const devices = await this.api.devices.getDevices();
      const zones = await this.api.zones.getZones();

      if (zoneName) {
        const targetZone = Object.values(zones).find(z => z.name.toLowerCase() === zoneName.toLowerCase());
        if (!targetZone) {
          return { success: false, error: `Zone "${zoneName}" not found. Retry get_device_count_by_zone using one of the exact names in availableZones.`, availableZones: Object.values(zones).map(z => z.name) };
        }

        const targetZoneIds = this._getAllChildZoneIds(targetZone.id, zones);
        const recursiveDevices = Object.values(devices).filter(d => d.zone && targetZoneIds.includes(d.zone));

        return {
          success: true,
          zone: targetZone.name,
          includesSubZones: true,
          summary: this._computeZoneSummary(recursiveDevices)
        };
      }

      // Return summary for all zones
      const devicesByZone = {};
      Object.values(devices).forEach(device => {
        const zone = device.zone && zones[device.zone] ? zones[device.zone].name : 'Unknown';
        if (!devicesByZone[zone]) devicesByZone[zone] = [];
        devicesByZone[zone].push(device);
      });

      const allZonesSummary = {};
      Object.entries(devicesByZone).forEach(([zone, devs]) => {
        allZonesSummary[zone] = this._computeZoneSummary(devs);
      });

      return { success: true, summary: allZonesSummary };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Looks up device class details or searches for matching classes.
   *
   * If neither `className` nor `searchTerm` is provided, returns all available classes.
   *
   * @public
   * @param {string|null} [className=null] - Exact class name (e.g. `'light'`).
   * @param {string|null} [searchTerm=null] - Fuzzy search term (e.g. `'lights'`, `'heating'`).
   * @returns {Promise<Object>} Result with class info, search matches, or full class list.
   * @throws Never — errors are returned as `{ success: false, error }`.
   * @example
   * const result = await adapter.getDeviceClassInfo(null, 'heating');
   * // { success: true, matches: [{ className: 'thermostat', ... }, { className: 'heater', ... }] }
   */
  async getDeviceClassInfo(className = null, searchTerm = null) {
    try {
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
        const allClasses = Object.keys(this.deviceClasses.classes);
        return {
          success: false,
          error: `Device class "${className}" not found`,
          suggestion: this._suggestDeviceClass(className, allClasses) ? `Did you mean '${this._suggestDeviceClass(className, allClasses)}'?` : null,
          availableClasses: allClasses.slice(0, 20),
          hint: 'Use searchTerm parameter to search for classes'
        };
      }

      if (searchTerm) {
        const searchLower = searchTerm.toLowerCase();
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
        return { success: true, searchTerm, matchCount: matches.length, matches };
      }

      const allClasses = Object.entries(this.deviceClasses.classes).map(([id, info]) => ({
        className: id, name: info.name, icon: info.icon, description: info.description
      }));
      return {
        success: true,
        message: 'All available device classes',
        totalClasses: allClasses.length,
        classes: allClasses,
        hint: "Use 'className' parameter for details or 'searchTerm' to search"
      };

    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Searches for devices whose names contain any of the provided keywords.
   *
   * Keywords are split on commas or whitespace. Keywords shorter than 3 characters
   * are ignored. Matching is case-insensitive partial-string.
   *
   * @public
   * @param {string} query - Comma-separated keywords (multilingual encouraged).
   * @returns {Promise<Object>} Result with `success`, `count`, `devices`, `parsedKeywords`.
   * @throws Never — errors are returned as `{ success: false, error }`.
   * @example
   * const result = await adapter.searchDevices('luce, light, cucina, kitchen');
   * // { success: true, count: 1, devices: [{ name: 'Luce Cucina', ... }] }
   */
  async searchDevices(query) {
    if (!query) {
      return { success: false, error: "Missing required parameter 'query'" };
    }

    try {
      await this.initialize();
      const devices = await this.api.devices.getDevices();
      const zones = await this.api.zones.getZones();
      const keywords = query.toLowerCase().split(/[,\s]+/).filter(k => k.length > 2);

      if (keywords.length === 0) {
        return { success: false, error: 'Query too short or empty. Please provide valid keywords.' };
      }

      const matches = Object.values(devices).filter(d => {
        const nameLower = d.name.toLowerCase();
        return keywords.some(k => nameLower.includes(k));
      });

      // Minimal discovery payload — id and capabilities omitted to reduce token overhead.
      // Call get_device_details(deviceName) to get full details for a specific device.
      const results = matches.map(d => ({
        name: d.name,
        class: d.class,
        zone: d.zone && zones[d.zone] ? zones[d.zone].name : 'Unknown',
        available: d.available !== false
      }));

      return {
        success: true,
        query,
        parsedKeywords: keywords,
        count: results.length,
        devices: results,
        message: results.length > 0
          ? `Found ${results.length} device(s) matching "${query}". Use list_device_actions(deviceName) to get available actions for a specific device.`
          : `No devices found matching any of: ${keywords.join(', ')}`
      };

    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Lists all specialised Action Cards available for a device.
   *
   * @public
   * @param {string} deviceName - Exact device name (case-insensitive).
   * @returns {Promise<Object>} Result with `success`, `deviceName`, `count`, `actions`.
   * @throws Never — errors are returned as `{ success: false, error }`.
   * @example
   * const result = await adapter.listDeviceActions('Cam Cucina');
   * // { success: true, count: 4, actions: [{ id: '...', title: 'Take snapshot', ... }] }
   */
  async listDeviceActions(deviceName) {
    if (!deviceName) {
      return { success: false, error: 'Missing deviceName' };
    }

    try {
      await this.initialize();
      const devices = await this.api.devices.getDevices();
      const device = Object.values(devices).find(d => d.name.toLowerCase() === deviceName.toLowerCase());

      if (!device) {
        return { success: false, error: `Device "${deviceName}" not found` };
      }

      const actionCards = await this.api.flow.getFlowCardActions();
      const deviceActions = Object.values(actionCards).filter(card =>
        card.ownerUri === 'homey:device:' + device.id ||
        card.ownerUri === device.uri
      );

      const formattedActions = deviceActions.map(card => ({
        id: card.id,
        title: card.titleFormatted || card.title,
        description: card.title,
        args: card.args,
        tokens: card.tokens || []
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
   * Executes a specific Action Card on a device via the HomeyScript proxy.
   *
   * Device lookup uses two strategies:
   * 1. UUID extracted from `cardId` (`homey:device:<uuid>:<action>`) — robust against LLM name hallucination.
   * 2. Fuzzy name match with Unicode NFC normalisation — fallback for atypical cardId formats.
   *
   * If the action card returns an image token, the device image is automatically
   * fetched and included in the response for visual analysis.
   *
   * @public
   * @param {string} deviceName - Device name hint (used as fallback only; may be approximate).
   * @param {string} cardId - Action card ID in `homey:device:<uuid>:<actionName>` format.
   * @param {Object} [args={}] - Arguments required by the action card.
   * @returns {Promise<Object>} Result with `success`, `message`, optional `tokens`, and optional `_imageData`.
   * @throws Never — errors are returned as `{ success: false, error }`.
   * @example
   * const result = await adapter.runActionCard('Cam Cucina', 'homey:device:8c9f6...:create_snapshot_std', {});
   * // { success: true, message: '...', _imageData: '...', _hasImage: true }
   */
  async runActionCard(deviceName, cardId, args = {}) {
    try {
      await this.initialize();
      const devices = await this.api.devices.getDevices();
      let device;

      // Strategy 1: extract UUID from cardId
      const deviceIdMatch = cardId && cardId.match(/^homey:device:([^:]+):/);
      if (deviceIdMatch) {
        device = Object.values(devices).find(d => d.id === deviceIdMatch[1]);
      }

      // Strategy 2: fuzzy name match with NFC normalisation
      if (!device) {
        const normalizedInput = deviceName.trim().normalize('NFC').toLowerCase();
        device = Object.values(devices).find(d =>
          d.name.trim().normalize('NFC').toLowerCase() === normalizedInput
        );
      }

      if (!device) {
        return { success: false, error: `Device "${deviceName}" not found. Call list_devices_in_zone or list_all_devices to get the exact device name, then retry run_action_card.` };
      }

      const card = await this.api.flow.getFlowCardAction({ id: cardId, uri: 'homey:device:' + device.id });
      if (!card) {
        return { success: false, error: `Action card "${cardId}" not found on device "${device.name}". Call list_device_actions with deviceName="${device.name}" to get valid card IDs, then retry run_action_card.` };
      }

      const hasImageToken = card.tokens && card.tokens.some(t => t.type === 'image');
      const deviceUri = 'homey:device:' + device.id;

      this.homey.log(`[HomeyMCPAdapter] Running action card via HomeyScript proxy: ${cardId}`);
      const actionResult = await this._runActionCardViaHomeyScript(cardId, deviceUri, args);

      const response = {
        success: true,
        message: `Executed action "${card.titleFormatted || card.title}" on ${device.name}`
      };

      if (actionResult && typeof actionResult === 'object') {
        response.tokens = actionResult;
      }

      if (hasImageToken) {
        this.homey.log(`[HomeyMCPAdapter] Action card has image token, fetching device image...`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        const imageData = await this._fetchDeviceImage(device.id);
        if (imageData) {
          response._imageData = imageData.imageBase64;
          response._imageMimeType = imageData.mimeType;
          response._hasImage = true;
          this.homey.log(`[HomeyMCPAdapter] Image fetched successfully: ${imageData.imageId}`);
        } else {
          this.homey.log(`[HomeyMCPAdapter] No image found for device ${device.id}`);
        }
      }

      return response;

    } catch (error) {
      this.homey.error(`[runActionCard] Error:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Retrieves the current image from a device (camera, doorbell, etc.).
   *
   * @public
   * @param {string} deviceName - Device name (case-insensitive).
   * @returns {Promise<Object>} Result with `success`, `_imageData`, `_imageMimeType`, `_hasImage`, `imageId`, `lastUpdated`.
   * @throws Never — errors are returned as `{ success: false, error }`.
   * @example
   * const result = await adapter.getDeviceImage('Cam Cucina');
   * // { success: true, _imageData: '<base64>', _hasImage: true, ... }
   */
  async getDeviceImage(deviceName) {
    if (!deviceName) {
      return { success: false, error: 'Missing deviceName' };
    }

    try {
      await this.initialize();
      const devices = await this.api.devices.getDevices();
      const device = Object.values(devices).find(d => d.name.toLowerCase() === deviceName.toLowerCase());

      if (!device) {
        return { success: false, error: `Device "${deviceName}" not found. Call list_devices_in_zone or list_all_devices to get the exact device name, then retry get_device_image.` };
      }

      const imageData = await this._fetchDeviceImage(device.id);

      if (!imageData) {
        return { success: false, error: this.homey.__('prompt.error.no_device_image') };
      }

      return {
        success: true,
        deviceName: device.name,
        _imageData: imageData.imageBase64,
        _imageMimeType: imageData.mimeType,
        _hasImage: true,
        message: `Image retrieved from ${device.name}`,
        imageId: imageData.imageId,
        lastUpdated: imageData.lastUpdated
      };

    } catch (error) {
      this.homey.error(`[getDeviceImage] Error:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Lists all available insight logs for a device.
   *
   * Use `getLogEntries` to retrieve actual time-series data for a specific log.
   *
   * @public
   * @param {string} deviceName - Exact device name (case-insensitive).
   * @returns {Promise<Object>} Result with `success`, `device`, `logs`, `count`, `message`.
   * @throws Never — errors are returned as `{ success: false, error }`.
   * @example
   * const result = await adapter.getDeviceHistory('Daikin Sala');
   * // { success: true, logs: [{ id: 'measure_temperature', name: 'Temperature', ... }] }
   */
  async getDeviceHistory(deviceName) {
    const devices = await this.api.devices.getDevices();
    const device = Object.values(devices).find(d => d.name.toLowerCase() === deviceName.toLowerCase());

    if (!device) {
      return {
        success: false,
        error: `Device "${deviceName}" not found. Call list_devices_in_zone or list_all_devices to get the exact device name, then retry get_device_history.`
      };
    }

    try {
      const logs = await device.getLogs();

      if (Object.keys(logs).length === 0) {
        return {
          success: true,
          device: device.name,
          logs: [],
          message: `No historical logs available for ${device.name}. This device may not track any capabilities over time.`
        };
      }

      const formattedLogs = Object.values(logs).map(log => ({
        id: log.id,
        name: log.title || log.id,
        uri: log.uri,
        type: log.type,
        units: log.units || null,
        ownerUri: log.ownerUri
      }));

      return {
        success: true,
        device: device.name,
        deviceId: device.id,
        logs: formattedLogs,
        count: formattedLogs.length,
        message: `Found ${formattedLogs.length} log(s) for ${device.name}. Use get_log_entries with the log ID to retrieve actual data.`
      };
    } catch (error) {
      return { success: false, error: `Failed to retrieve logs for ${deviceName}: ${error.message}` };
    }
  }

  /**
   * Retrieves time-series data from a device insight log.
   *
   * Bypasses `Log.getEntries()` (which ignores the `resolution` parameter in HomeyAPIV3)
   * and calls `this.api.insights.getLogEntries()` directly to correctly forward the
   * resolution as a REST query parameter.
   *
   * @public
   * @param {string} deviceName - Exact device name (case-insensitive).
   * @param {string} logId - Log ID returned by {@link getDeviceHistory}.
   * @param {string} resolution - Time resolution: `'last24Hours'` | `'last7Days'` |
   *   `'last14Days'` | `'last31Days'` | `'last6Months'` | `'last1Years'` | `'last5Years'`.
   * @returns {Promise<Object>} Result with `success`, `entries` (local timestamps), `statistics`, `timezone`.
   * @throws Never — errors are returned as `{ success: false, error }`.
   * @example
   * const result = await adapter.getLogEntries('Daikin Sala', 'measure_temperature', 'last7Days');
   * // { success: true, entries: [{ timestamp: '2026-02-15T12:00:00', value: 21.5 }], statistics: { min, max, average } }
   */
  async getLogEntries(deviceName, logId, resolution) {
    const devices = await this.api.devices.getDevices();
    const device = Object.values(devices).find(d => d.name.toLowerCase() === deviceName.toLowerCase());

    if (!device) {
      return { success: false, error: `Device "${deviceName}" not found. Call list_devices_in_zone or list_all_devices to get the exact device name, then retry get_log_entries.` };
    }

    try {
      const logs = await device.getLogs();
      const log = logs[logId];

      if (!log) {
        const availableLogIds = Object.keys(logs);
        return {
          success: false,
          error: `Log "${logId}" not found for device "${deviceName}". Call get_device_history with deviceName="${deviceName}" to get valid log IDs, then retry get_log_entries using one of the exact IDs in availableLogs.`,
          availableLogs: availableLogIds
        };
      }

      // Log.getEntries() in HomeyAPIV3 ignores the resolution parameter (SDK limitation).
      // We bypass it and call the manager method directly.
      const entries = await this.api.insights.getLogEntries({ id: log.id, resolution });
      const entriesArray = entries && entries.values ? entries.values : [];

      if (!entriesArray || entriesArray.length === 0) {
        return {
          success: true, device: deviceName, logId, logName: log.title || logId, resolution, entries: [],
          message: 'No data available for this time range.'
        };
      }

      // Get Homey's timezone for local timestamp conversion
      let userTimezone = 'UTC';
      try {
        userTimezone = this.homey?.clock?.getTimezone?.() || 'UTC';
      } catch (e) {
        this.homey.log('[getLogEntries] Could not get timezone, using UTC');
      }

      // Convert each entry's UTC timestamp to Homey's local timezone.
      // Raw entry format: { t: unix_timestamp_ms, v: number|boolean }
      const formattedEntries = entriesArray.map(entry => {
        const utcDate = new Date(entry.t);
        const utcDateStr = new Date(utcDate.toLocaleString('en-US', { timeZone: 'UTC' }));
        const localDateStr = new Date(utcDate.toLocaleString('en-US', { timeZone: userTimezone }));
        const offsetMs = localDateStr.getTime() - utcDateStr.getTime();
        const localDate = new Date(utcDate.getTime() + offsetMs);
        return {
          timestamp: localDate.toISOString().replace('Z', ''), // No 'Z' → local time
          value: entry.v
        };
      });

      const values = formattedEntries.map(e => e.value).filter(v => v != null);
      const stats = values.length > 0 ? {
        count: values.length,
        min: Math.min(...values),
        max: Math.max(...values),
        average: values.reduce((a, b) => a + b, 0) / values.length
      } : null;

      return {
        success: true, device: deviceName, logId, logName: log.title || logId,
        units: log.units || null, resolution, timezone: userTimezone,
        entries: formattedEntries, statistics: stats,
        message: `Retrieved ${formattedEntries.length} data points for ${log.title || logId} from ${deviceName}. Timestamps are in local time (${userTimezone}).`
      };

    } catch (error) {
      return { success: false, error: `Failed to retrieve log entries: ${error.message}` };
    }
  }

  /**
   * Releases all resources (scheduler timers, periodic checker).
   * Must be called from `app.js` `onUninit()`.
   *
   * @public
   * @returns {void}
   * @example
   * // In app.js onUninit():
   * this.mcpAdapter.cleanup();
   */
  cleanup() {
    this.scheduler.cleanup();
  }

  /**
   * Restores scheduled commands from Homey settings after an app restart.
   * Must be called from `app.js` `onInit()` after the adapter is ready.
   *
   * @public
   * @returns {Promise<void>}
   * @example
   * // In app.js onInit():
   * await this.mcpAdapter.restoreScheduledCommands();
   */
  async restoreScheduledCommands() {
    await this.scheduler.restoreScheduledCommands();
  }

  // ── Private Methods ─────────────────────────────────────────────────────────

  /**
   * Ensures a HomeyScript proxy script exists and returns its ID.
   *
   * The proxy script is used to trigger flows and run action cards using
   * HomeyScript's privileged `homey.flow.start` scope, which third-party
   * apps cannot obtain directly.
   *
   * @private
   * @returns {Promise<{scriptId: string}>} Object containing the proxy script ID.
   * @throws {Error} If HomeyScript is not installed or the proxy script cannot be created.
   */
  async _ensureHomeyScriptProxy() {
    await this.initialize();

    if (!this._homeyScriptProxyId) {
      try {
        const response = await fetch(`${this._localUrl}/api/app/com.athom.homeyscript/script`, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${this._sessionToken}`, 'Content-Type': 'application/json' },
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
        if (e.message.includes('HomeyScript app is NOT installed')) throw e;
        this.homey.log('[HomeyMCPAdapter] Could not list HomeyScript scripts:', e.message);
      }

      if (!this._homeyScriptProxyId) {
        try {
          const response = await fetch(`${this._localUrl}/api/app/com.athom.homeyscript/script`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${this._sessionToken}`, 'Content-Type': 'application/json' },
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
          if (e.message.includes('HomeyScript app is NOT installed')) throw e;
          throw new Error(`Failed to create HomeyScript proxy script: ${e.message}`);
        }
      }
    }

    return { scriptId: this._homeyScriptProxyId };
  }

  /**
   * Triggers a flow (standard or Advanced) via the HomeyScript proxy.
   *
   * @private
   * @param {string} flowId - The flow UUID.
   * @param {string} flowType - `'standard'` or `'advanced'`.
   * @param {Object} [args={}] - Optional flow arguments/tokens.
   * @returns {Promise<void>}
   * @throws {Error} If the HomeyScript execution fails.
   */
  async _triggerFlowViaHomeyScript(flowId, flowType, args = {}) {
    const { scriptId } = await this._ensureHomeyScriptProxy();
    const method = flowType === 'advanced' ? 'triggerAdvancedFlow' : 'triggerFlow';
    const argsStr = args && Object.keys(args).length > 0 ? JSON.stringify(args) : 'null';
    const code = `await Homey.flow.${method}({ id: \"${flowId}\" }, ${argsStr});`;

    this.homey.log(`[HomeyMCPAdapter] Executing via HomeyScript: ${code}`);

    const response = await fetch(`${this._localUrl}/api/app/com.athom.homeyscript/script/${scriptId}/run`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this._sessionToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

    const result = await response.json();
    if (!result.success) {
      throw new Error(result.returns?.message || 'HomeyScript execution failed');
    }
  }

  /**
   * Executes a device action card via the HomeyScript proxy.
   *
   * @private
   * @param {string} cardId - The action card ID.
   * @param {string} deviceUri - Device URI (e.g. `'homey:device:<uuid>'`).
   * @param {Object} args - Action arguments.
   * @returns {Promise<*>} The `returns` value from the HomeyScript execution (token data).
   * @throws {Error} If HomeyScript is not installed, the proxy is missing, or execution fails.
   */
  async _runActionCardViaHomeyScript(cardId, deviceUri, args) {
    const { scriptId } = await this._ensureHomeyScriptProxy();
    const argsJson = JSON.stringify(args).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const code = `await Homey.flow.runFlowCardAction({ id: "${cardId}", uri: "${deviceUri}", args: JSON.parse("${argsJson}") });`;

    this.homey.log(`[HomeyMCPAdapter] Executing action via HomeyScript: ${cardId}`);

    const response = await fetch(`${this._localUrl}/api/app/com.athom.homeyscript/script/${scriptId}/run`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this._sessionToken}`, 'Content-Type': 'application/json' },
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
      throw new Error(result.returns?.message || 'HomeyScript execution failed');
    }

    return result.returns;
  }

  /**
   * Fetches the most recent image from a device via Homey's ManagerImages REST API.
   *
   * @private
   * @param {string} deviceId - The device UUID.
   * @returns {Promise<{imageBase64: string, mimeType: string, imageId: string, lastUpdated: string}|null>}
   *   Image data object, or `null` if no image is available or an error occurs.
   */
  async _fetchDeviceImage(deviceId) {
    try {
      await this.initialize();
      const devices = await this.api.devices.getDevices();
      const device = Object.values(devices).find(d => d.id === deviceId);

      if (!device) throw new Error(`Device ${deviceId} not found`);
      if (!device.images || device.images.length === 0) {
        this.homey.log(`[HomeyMCPAdapter] Device has no images array or empty`);
        return null;
      }

      const response = await fetch(`${this._localUrl}/api/manager/images/image`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${this._sessionToken}`, 'Content-Type': 'application/json' },
      });

      if (!response.ok) throw new Error(`Failed to fetch images: HTTP ${response.status}`);

      const allImages = await response.json();
      const deviceImageIds = device.images
        .filter(img => img.imageObj && img.imageObj.id)
        .map(img => img.imageObj.id);

      const deviceImages = Object.values(allImages).filter(img => deviceImageIds.includes(img.id));

      if (deviceImages.length === 0) {
        this.homey.log(`[HomeyMCPAdapter] No matching images found after filtering`);
        return null;
      }

      const latestImage = deviceImages.sort((a, b) => new Date(b.lastUpdated) - new Date(a.lastUpdated))[0];

      const imageResponse = await fetch(`${this._localUrl}${latestImage.url}`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${this._sessionToken}` },
      });

      if (!imageResponse.ok) throw new Error(`Failed to download image: HTTP ${imageResponse.status}`);

      const imageBuffer = await imageResponse.arrayBuffer();
      const bufferSize = imageBuffer.byteLength;

      const MAX_IMAGE_SIZE = 4 * 1024 * 1024; // 4 MB
      if (bufferSize > MAX_IMAGE_SIZE) {
        throw new Error(`Image too large: ${(bufferSize / 1024 / 1024).toFixed(2)} MB (max 4MB)`);
      }

      const imageBase64 = Buffer.from(imageBuffer).toString('base64');
      const mimeType = imageResponse.headers.get('content-type') || 'image/jpeg';

      this.homey.log(`[HomeyMCPAdapter] Fetched image for device ${deviceId}: ${(bufferSize / 1024).toFixed(2)} KB, type: ${mimeType}`);

      return { imageBase64, mimeType, imageId: latestImage.id, lastUpdated: latestImage.lastUpdated };

    } catch (error) {
      this.homey.error(`[HomeyMCPAdapter] Error fetching device image:`, error);
      return null;
    }
  }

  /**
   * Returns the list of action cards associated with a specific device.
   *
   * @private
   * @param {Object} device - Homey device object.
   * @param {Object|null} [allActionCards=null] - Pre-fetched action cards map (performance optimisation).
   *   If `null`, cards are fetched from the API.
   * @returns {Promise<Array<{id: string, title: string, description: string, tokens: Array}>>}
   *   Filtered and formatted list of action cards for the device.
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
      tokens: card.tokens || []
    }));
  }

  /**
   * Returns all zone IDs within the subtree rooted at `rootZoneId` (inclusive).
   *
   * @private
   * @param {string} rootZoneId - ID of the root zone.
   * @param {Object} zones - Full zones map from `homey.api.zones.getZones()`.
   * @returns {string[]} Array of zone IDs (including `rootZoneId` itself).
   * @example
   * const ids = this._getAllChildZoneIds('home-id', zones);
   * // ['home-id', 'living-room-id', 'kitchen-id', ...]
   */
  _getAllChildZoneIds(rootZoneId, zones) {
    const ids = [rootZoneId];
    const children = Object.values(zones).filter(z => z.parent === rootZoneId);
    for (const child of children) {
      ids.push(...this._getAllChildZoneIds(child.id, zones));
    }
    return ids;
  }

  /**
   * Computes a device count summary grouped by effective class for a list of devices.
   *
   * For classes where **all** devices have `onoff`, includes `on`/`off` counts.
   * For classes where any device lacks `onoff`, only `total` is returned.
   *
   * @private
   * @param {Object[]} devices - Array of Homey device objects.
   * @returns {{ totalDevices: number, byClass: Object }} Summary object.
   */
  _computeZoneSummary(devices) {
    const summary = { totalDevices: devices.length, byClass: {} };
    const devicesByClass = {};

    devices.forEach(d => {
      const effectiveClass = d.virtualClass || d.class;
      if (!devicesByClass[effectiveClass]) devicesByClass[effectiveClass] = [];
      devicesByClass[effectiveClass].push(d);
    });

    Object.entries(devicesByClass).forEach(([className, classDevices]) => {
      const allHaveOnOff = classDevices.every(d => d.capabilitiesObj && 'onoff' in d.capabilitiesObj);

      if (allHaveOnOff) {
        const on = classDevices.filter(d => d.capabilitiesObj?.onoff?.value === true).length;
        const off = classDevices.filter(d => d.capabilitiesObj?.onoff?.value === false).length;
        summary.byClass[className] = { total: classDevices.length, on, off };
      } else {
        summary.byClass[className] = { total: classDevices.length };
      }
    });

    return summary;
  }

  /**
   * Performs basic capability value validation.
   *
   * Validation is intentionally minimal — the Homey API handles detailed type
   * and range enforcement internally. This method exists as an extension point.
   *
   * @private
   * @param {string} capability - Capability identifier.
   * @param {*} value - Value to validate.
   * @returns {{ valid: boolean, error?: string, expectedType?: string, expectedRange?: string }}
   */
  _validateCapabilityValue(capability, value) {
    // Detailed validation is delegated to the Homey API.
    return { valid: true };
  }

  /**
   * Suggests the closest capability name using substring matching and Levenshtein distance.
   *
   * @private
   * @param {string} input - User-provided capability name.
   * @param {string[]} available - List of available capability names on the device.
   * @returns {string|null} The best matching capability name, or `null` if none found within threshold.
   * @example
   * this._suggestCapability('onOf', ['onoff', 'dim']); // → 'onoff'
   */
  _suggestCapability(input, available) {
    if (!input || !available || available.length === 0) return null;
    const inputLower = input.toLowerCase();

    let match = available.find(cap => cap.toLowerCase().includes(inputLower));
    if (match) return match;

    match = available.find(cap => inputLower.includes(cap.toLowerCase()));
    if (match) return match;

    let minDistance = Infinity;
    let suggestion = null;
    for (const cap of available) {
      const distance = this._levenshteinDistance(inputLower, cap.toLowerCase());
      if (distance < minDistance && distance <= 3) {
        minDistance = distance;
        suggestion = cap;
      }
    }
    return suggestion;
  }

  /**
   * Suggests the closest device class name using substring matching.
   *
   * @private
   * @param {string} input - User-provided class name or informal term.
   * @param {string[]} available - List of known class names.
   * @returns {string|null} The best matching class name, or `null` if none found.
   * @example
   * this._suggestDeviceClass('lights', ['light', 'socket']); // → 'light'
   */
  _suggestDeviceClass(input, available) {
    if (!input || !available || available.length === 0) return null;
    const inputLower = input.toLowerCase();

    const exact = available.find(cls => cls.toLowerCase() === inputLower);
    if (exact) return exact;

    const partial = available.find(cls =>
      cls.toLowerCase().includes(inputLower) || inputLower.includes(cls.toLowerCase())
    );
    return partial || null;
  }

  /**
   * Computes the Levenshtein edit distance between two strings.
   *
   * Used internally by {@link _suggestCapability} to find the closest capability name.
   *
   * @private
   * @param {string} a - First string.
   * @param {string} b - Second string.
   * @returns {number} Minimum number of single-character edits (insert, delete, substitute).
   * @example
   * this._levenshteinDistance('onof', 'onoff'); // → 1
   */
  _levenshteinDistance(a, b) {
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

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
}

module.exports = { HomeyMCPAdapter };

