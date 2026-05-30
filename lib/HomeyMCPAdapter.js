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
          return await this.getDeviceState(args.deviceName, args.deviceId);
        case 'discover_resources':
        case 'discover_devices': // Backward-compatible alias
          if (args.query) {
            return await this.searchDevices(args.query);
          }
          if (args.type === 'app') return await this.listInstalledApps();
          if (args.type === 'system') return await this.listSystemManagers();
          if (args.zoneName && args.deviceClass) {
            return await this.listDevicesByClassInZone(args.deviceClass, args.zoneName);
          } else if (args.zoneName) {
            return await this.listDevicesInZone(args.zoneName);
          } else if (args.deviceClass) {
            return await this.listDevicesByClass(args.deviceClass);
          }
          return await this.listAllDevices();
        case 'list_zones':
          return await this.listZones();
        case 'get_home_summary':
          if (args.deviceClass) {
            return await this.getDevicesStatusByClass(args.deviceClass, args.zone || null);
          } else if (args.zone) {
            return await this.getDeviceCountByZone(args.zone);
          }
          // No parameters → return a global device count summary grouped by class
          return await this.getDeviceCountByZone(null);
        case 'manage_schedule':
          if (args.action === 'list') {
            const list = await this.scheduler.listScheduledCommands();
            return { success: true, count: list.length, schedules: list };
          }
          if (args.action === 'cancel') {
            if (!args.scheduleId) {
              return { success: false, error: "Missing required parameter 'scheduleId' for cancel action." };
            }
            return await this.scheduler.cancelScheduledCommand(args.scheduleId);
          }
          // Default: create
          return await this.scheduler.scheduleCommand(args.command, args.executeAt, args.description);
        case 'schedule_command': // Backward-compatible alias
          return await this.scheduler.scheduleCommand(args.command, args.executeAt, args.description);
        case 'discover_flows':
          if (args.flowName) {
            return await this.getFlowInfo(args.flowName);
          }
          return await this.listFlows(args.enabled, args.folder, args.type);
        case 'search_devices': // Backward-compatible alias
          return await this.searchDevices(args.query);
        // Renamed from list_device_actions — backward-compatible alias kept below
        case 'discover_flow_cards':
          return await this.discoverFlowCards(
            args.cardType || 'action',
            args.deviceName,
            args.deviceId,
            args.ownerUri
          );
        // Legacy alias: kept for any cached context that still references the old name
        case 'list_device_actions':
          return await this.discoverFlowCards('action', args.deviceName, args.deviceId, null);
        case 'run_action_card':
          return await this.runActionCard(args.deviceName, args.cardId, args.args, args.deviceId);
        case 'get_device_image':
          return await this.getDeviceImage(args.deviceName, args.deviceId);
        case 'get_device_logs':
          if (!args.logId) {
            return await this.getDeviceHistory(args.deviceName, args.deviceId);
          }
          if (!args.resolution) {
            return {
              success: false,
              error: `Missing required parameter 'resolution' for log retrieval. Valid values: 'last24Hours', 'last7Days', 'last14Days', 'last31Days', 'last6Months', 'last1Years', 'last5Years'.`,
              availableResolutions: ['last24Hours', 'last7Days', 'last14Days', 'last31Days', 'last6Months', 'last1Years', 'last5Years']
            };
          }
          return await this.getLogEntries(args.deviceName, args.logId, args.resolution, args.deviceId);
        case 'manage_flow':
          return await this.manageFlow(args);
        case 'manage_advanced_flow':
          return await this.manageAdvancedFlow(args);
        case 'discover_flow_details':
          return await this.discoverFlowDetails(args.flowId, args.flowName);
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
   * @param {?string} [deviceId=null] - Optional specific device ID to resolve name conflicts (optional).
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

    let device;
    try {
      const resolved = await this._resolveDevice(deviceName, deviceId);
      device = resolved.device;
    } catch (err) {
      if (err.ambiguous) {
        return {
          success: false,
          ambiguous: true,
          error: `${err.message} Ask the user which one they mean, then retry control_device using the deviceId of the correct device.`,
          matches: err.matches
        };
      }
      return {
        success: false,
        error: `${err.message} You must call discover_resources first to see the exact resource names, then retry with the exact name.`,
        required_action: 'Call discover_resources to see available resources'
      };
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

    let zoneName = 'Unknown';
    try {
      const zones = await this.api.zones.getZones();
      if (device.zone && zones[device.zone]) {
        zoneName = zones[device.zone].name;
      }
    } catch (error) {
      this.homey.log(`[HomeyMCPAdapter] Failed to resolve zone for device "${device.name}":`, error.message);
    }

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
          error: `Flow "${flowName}" not found.${suggestion ? ` Did you mean "${suggestion}"?` : ''} Call discover_flows to get all available flow names, then retry using one of the exact names in availableFlows.`,
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
   * @param {string|null} [deviceId=null] - Optional device UUID for unambiguous lookup.
   * @returns {Promise<Object>} Result with `success`, `device`, `class`, `zone`, `state`, `available`.
   * @throws Never — errors are returned as `{ success: false, error }`.
   * @example
   * const result = await adapter.getDeviceState('Bedroom Thermostat');
   * // { success: true, state: { measure_temperature: 21.5, target_temperature: 22, ... } }
   */
  async getDeviceState(deviceName, deviceId = null) {
    if (!deviceName && !deviceId) {
      return { success: false, error: "Missing required parameter: provide 'deviceName' or 'deviceId'." };
    }

    await this.initialize();
    const devices = await this.api.devices.getDevices();
    const zones = await this.api.zones.getZones();

    let device;
    try {
      const resolved = await this._resolveDevice(deviceName, deviceId);
      device = resolved.device;
    } catch (err) {
      if (err.ambiguous) {
        return {
          success: false,
          ambiguous: true,
          error: `${err.message} Please specify which one you mean by using its deviceId.`,
          matches: err.matches
        };
      }
      return {
        success: false,
        error: `${err.message} You must call discover_resources first to see the exact resource names, then retry.`
      };
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
        return { success: false, error: `Zone "${zoneName}" not found. Retry discover_devices using one of the exact names in availableZones.`, availableZones: Object.values(zones).map(z => z.name) };
      }

      const targetZoneIds = this._getAllChildZoneIds(targetZone.id, zones);
      let devicesInZone = Object.values(devices).filter(d => d.zone && targetZoneIds.includes(d.zone));

      // Filter out devices not intended for visibility (groups or hidden)
      devicesInZone = this._filterVisibleDevices(devicesInZone);

      if (devicesInZone.length === 0) {
        return { success: false, error: `No devices found in zone "${zoneName}" (including sub-zones). Retry discover_devices using one of the exact names in availableZones.`, availableZones: Object.values(zones).map(z => z.name) };
      }

      const deviceList = devicesInZone.map(d => {
        return {
          name: d.name,
          id: d.id,
          class: d.class,
          zone: zoneName,
          available: d.available !== false
        };
      });

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
   * Use `get_device_state(deviceName)` to retrieve capabilities and
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
      const devicesMap = await this.api.devices.getDevices();
      const zones = await this.api.zones.getZones();

      // Filter out members of grouped devices to avoid duplication
      const devices = this._filterVisibleDevices(devicesMap);

      // Minimal discovery payload — intentionally excludes id, capabilities, state and actionCards.
      // Use get_home_summary for per-class state queries.
      const deviceList = devices.map(d => ({
        name: d.name,
        id: d.id,
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
   * Returns a minimal discovery payload only. Use `get_device_state(deviceName)`
   * to retrieve capabilities and current state for a specific device.
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

    const devicesMap = await this.api.devices.getDevices();
    const zones = await this.api.zones.getZones();

    // Filter out members of grouped devices or hidden devices to avoid duplication
    const allDevicesFiltered = this._filterVisibleDevices(devicesMap);

    const normalizedClass = deviceClass.toLowerCase();
    const filteredDevices = allDevicesFiltered.filter(d => {
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
        error: `No devices found with class "${deviceClass}".${suggestion ? ` Did you mean "${suggestion}"?` : ''} Retry discover_devices using one of the exact values in availableClasses.`,
        availableClasses: actualClasses,
        suggestion: suggestion || null
      };
    }

    const deviceList = filteredDevices.map(d => ({
      name: d.name,
      id: d.id,
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
   * Lists devices of a specific class within a specific zone.
   *
   * @public
   * @param {string} deviceClass - Homey device class
   * @param {string} zoneName - Zone name
   * @returns {Promise<Object>}
   */
  async listDevicesByClassInZone(deviceClass, zoneName) {
    if (!deviceClass || !zoneName) {
      return { success: false, error: "Missing required parameters 'deviceClass' and/or 'zoneName'." };
    }

    try {
      await this.initialize();
      const zones = await this.api.zones.getZones();
      const normalizedZoneInput = zoneName.toLowerCase();
      
      // Find the zone
      const targetZone = Object.values(zones).find(z => z.name.toLowerCase() === normalizedZoneInput);
      if (!targetZone) {
        return { success: false, error: `Zone '${zoneName}' not found.` };
      }

      // Get all nested zones, just like listDevicesInZone
      const nestedZoneIds = this._getAllChildZoneIds(targetZone.id, zones); // Fixed typo from _getNestedZoneIds
      const devicesMap = await this.api.devices.getDevices();

      // Filter out members of grouped devices or hidden devices to avoid duplication
      const allDevicesFiltered = this._filterVisibleDevices(devicesMap);

      // Filter by both zone and class
      const normalizedClass = deviceClass.toLowerCase();
      let devicesInZone = allDevicesFiltered.filter(device => {
        const isInZone = nestedZoneIds.includes(device.zone);
        const effectiveClass = (device.virtualClass || device.class)?.toLowerCase();
        const matchesClass = effectiveClass === normalizedClass;
        return isInZone && matchesClass;
      });

      return {
        success: true,
        zoneName: targetZone.name,
        deviceClass: normalizedClass,
        deviceCount: devicesInZone.length,
        devices: devicesInZone.map(d => {
          return {
            name: d.name,
            id: d.id,
            class: (d.virtualClass || d.class)?.toLowerCase(),
            zone: targetZone.name,
            available: d.available !== false
          };
        }),
        message: `Found ${devicesInZone.length} '${deviceClass}' in '${targetZone.name}'. Use list_device_actions(deviceName) to get available actions.`
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
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

      const visibleDevices = this._filterVisibleDevices(devices);
      let classDevices = visibleDevices.filter(d => (d.virtualClass || d.class) === deviceClass);

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

      // Build device state objects. capabilities list is omitted (use get_device_state).
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
      const devicesMap = await this.api.devices.getDevices();
      const zones = await this.api.zones.getZones();

      // Filter out members of grouped devices to avoid duplication
      const devicesArray = this._filterVisibleDevices(devicesMap);

      if (zoneName) {
        const targetZone = Object.values(zones).find(z => z.name.toLowerCase() === zoneName.toLowerCase());
        if (!targetZone) {
          return { success: false, error: `Zone "${zoneName}" not found. Retry get_home_summary using one of the exact names in availableZones.`, availableZones: Object.values(zones).map(z => z.name) };
        }

        const targetZoneIds = this._getAllChildZoneIds(targetZone.id, zones);
        const recursiveDevices = devicesArray.filter(d => d.zone && targetZoneIds.includes(d.zone));

        return {
          success: true,
          zone: targetZone.name,
          includesSubZones: true,
          summary: this._computeZoneSummary(recursiveDevices)
        };
      }

      // Return summary for all zones
      const devicesByZone = {};
      devicesArray.forEach(device => {
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
      const devicesMap = await this.api.devices.getDevices();
      const zones = await this.api.zones.getZones();
      const keywords = query.toLowerCase().split(/[,\s]+/).filter(k => k.length > 2);

      // Filter out members of grouped devices or hidden devices to avoid duplication
      const allDevicesFiltered = this._filterVisibleDevices(devicesMap);

      if (keywords.length === 0) {
        return { success: false, error: 'Query too short or empty. Please provide valid keywords.' };
      }

      const matches = allDevicesFiltered.filter(d => {
        const nameLower = d.name.toLowerCase();
        return keywords.some(k => nameLower.includes(k));
      });

      // Minimal discovery payload — id and capabilities omitted to reduce token overhead.
      // Call get_device_state(deviceName) to get full details for a specific device.
      const results = matches.map(d => ({
        name: d.name,
        id: d.id,
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
   * @param {string|null} [deviceId=null] - Optional device UUID.
   * @returns {Promise<Object>} Result with `success`, `deviceName`, `count`, `actions`.
   * @throws Never — errors are returned as `{ success: false, error }`.
   * @example
  /**
   * Lists all Flow Cards of a given type (action, trigger, condition) with optional filtering.
   *
   * This method replaces the old `listDeviceActions` and extends it to support trigger
   * and condition card types in addition to action cards. For trigger/condition cards,
   * at least one filter (`deviceName` or `ownerUri`) must be provided to prevent
   * returning an unbounded list that would consume too many tokens.
   *
   * @public
   * @param {'action'|'trigger'|'condition'} [cardType='action'] - Type of flow card to retrieve.
   * @param {string|null} [deviceName=null] - Filter by device name (case-insensitive). Required for 'action'.
   * @param {string|null} [deviceId=null] - Filter by device UUID (fallback for ambiguous names).
   * @param {string|null} [ownerUri=null] - Filter by ownerUri for app/system manager cards (e.g. 'homey:manager:clock').
   * @returns {Promise<Object>} Result with `success`, `count`, `cards`, and optional `deviceName`.
   * @throws Never — errors are returned as `{ success: false, error }`.
   * @example
   * // Action cards for a device
   * const r = await adapter.discoverFlowCards('action', 'Cam Cucina');
   * // Trigger cards for the clock manager
   * const r = await adapter.discoverFlowCards('trigger', null, null, 'homey:manager:clock');
   */
  async discoverFlowCards(cardType = 'action', deviceName = null, deviceId = null, ownerUri = null) {
    if (!deviceName && !deviceId && !ownerUri) {
      if (cardType === 'action') {
        return { success: false, error: "Missing required parameter: provide 'deviceName' or 'deviceId' for action cards." };
      }
      // Trigger/condition without any filter risks returning hundreds of results
      return {
        success: false,
        error: `Missing filter: provide 'deviceName' or 'ownerUri' when cardType='${cardType}' to avoid fetching too many results.`
      };
    }

    try {
      await this.initialize();
      const devices = await this.api.devices.getDevices();
      const zones = await this.api.zones.getZones();
      let device = null;

      // Resolve device if deviceName or deviceId is given
      if (deviceId || deviceName) {
        try {
          const resolved = await this._resolveDevice(deviceName, deviceId);
          device = resolved.device;
        } catch (err) {
          if (err.ambiguous) {
            return {
              success: false,
              ambiguous: true,
              error: err.message,
              matches: err.matches
            };
          }
          return { success: false, error: err.message };
        }
      }

      // Select the correct API method and compute the effective ownerUri filter
      let allCards;
      if (cardType === 'trigger') {
        allCards = await this.api.flow.getFlowCardTriggers();
      } else if (cardType === 'condition') {
        allCards = await this.api.flow.getFlowCardConditions();
      } else {
        allCards = await this.api.flow.getFlowCardActions();
      }

      // Apply filter: by device or by explicit ownerUri
      const effectiveOwnerUri = device ? ('homey:device:' + device.id) : null;
      const filteredCards = Object.values(allCards).filter(card => {
        if (effectiveOwnerUri) return card.ownerUri === effectiveOwnerUri || card.ownerUri === device.uri;
        if (ownerUri) return card.ownerUri === ownerUri;
        return false;
      });

      const formatted = filteredCards.map(card => ({
        id: card.id,
        title: card.titleFormatted || card.title,
        args: card.args || [],
        // Include tokens only for action cards (triggers/conditions don't need them for flow creation)
        ...(cardType === 'action' ? { tokens: card.tokens || [] } : {})
      }));

      return {
        success: true,
        cardType,
        ...(device ? { deviceName: device.name } : { ownerUri: ownerUri || effectiveOwnerUri }),
        count: formatted.length,
        cards: formatted
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
   * @param {string|null} [deviceId=null] - Optional device UUID to force execution on a specific device.
   * @returns {Promise<Object>} Result with `success`, `message`, optional `tokens`, and optional `_imageData`.
   * @throws Never — errors are returned as `{ success: false, error }`.
   * @example
   * const result = await adapt  async runActionCard(deviceName, cardId, args = {}, deviceId = null) {
    try {
      await this.initialize();

      // Normalize args if passed as a stringified JSON string or array by the model
      const tempCard = { id: cardId, args };
      await this._normalizeCardArgs(tempCard, 'runActionCard');
      args = tempCard.args || {};

      const devices = await this.api.devices.getDevices();
      const zones = await this.api.zones.getZones();
      let device;

      // Resolve device using _resolveDevice helper
      try {
        let targetId = deviceId;
        if (!targetId) {
          const deviceIdMatch = cardId && cardId.match(/^homey:device:([^:]+):/);
          if (deviceIdMatch) {
            targetId = deviceIdMatch[1];
          }
        }
        const resolved = await this._resolveDevice(deviceName, targetId);
        device = resolved.device;
      } catch (err) {
        if (err.ambiguous) {
          return {
            success: false,
            ambiguous: true,
            error: err.message,
            matches: err.matches
          };
        }
        return { success: false, error: err.message };
      }

      const card = await this.api.flow.getFlowCardAction({ id: cardId, uri: 'homey:device:' + device.id });
      if (!card) {
        return { success: false, error: `Action card "${cardId}" not found on device "${device.name}". Call list_device_actions with deviceName="${device.name}" to get valid card IDs, then retry run_action_card.` };
      }

      // Pre-execution validation: verify all required args are populated for this action card.
      if (card.args && Array.isArray(card.args)) {
        const requiredArgs = card.args.filter(a => a.required !== false);
        const missingArgs = [];

        for (const argDef of requiredArgs) {
          const val = args && args[argDef.name];
          // Allow Homey token syntax [[...]] as a valid value regardless of type
          const isToken = typeof val === 'string' && /^\[\[.+]]$/.test(val.trim());
          if (isToken) continue;

          const isEmpty = val === undefined || val === null || val === '' || val === 'null';
          if (isEmpty) {
            missingArgs.push({ name: argDef.name, type: argDef.type });
          }
        }

        if (missingArgs.length > 0) {
          const schemaHint = requiredArgs.map(a => `${a.name} (${a.type})`).join(', ');
          const missing = missingArgs.map(a => `${a.name} (${a.type})`).join(', ');
          const issueDetails = `Action card "${cardId}" is missing required arguments: [${missing}]. Full schema: { ${schemaHint} }`;
          this.homey.log(`[runActionCard] Pre-execution validation failed: ${issueDetails}`);
          return {
            success: false,
            error: `Cannot run action card: missing required arguments. Fix all issues and retry: ${issueDetails}`
          };
        }
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

      // Enrich error feedback for 'Missing argument' failures:
      // parse the card ID from the error message and append the expected schema.
      const missingArgMatch = error.message && error.message.match(/Missing argument '([^']+)' for card '([^']+)'/);
      if (missingArgMatch && card && card.id === missingArgMatch[2]) {
        try {
          if (card.args && Array.isArray(card.args)) {
            const schemaHint = card.args.map(a => `${a.name} (type: ${a.type}${a.required === false ? ', optional' : ', required'})`).join(', ');
            const enrichedMessage = `${error.message}. Expected args for this card: { ${schemaHint} }. Current args sent: ${JSON.stringify(args)}. Fix this card and retry.`;
            return { success: false, error: enrichedMessage };
          }
        } catch (enrichErr) {
          this.homey.error(`[runActionCard] Error enriching validation message:`, enrichErr);
        }
      }

      return { success: false, error: error.message };
    }
  }

  /**
   * Retrieves the current image from a device (camera, doorbell, etc.).
   *
   * @public
   * @param {string} deviceName - Device name (case-insensitive).
   * @param {string|null} [deviceId=null] - Optional device UUID.
   * @returns {Promise<Object>} Result with `success`, `_imageData`, `_imageMimeType`, `_hasImage`, `imageId`, `lastUpdated`.
   * @throws Never — errors are returned as `{ success: false, error }`.
   * @example
   * const result = await adapter.getDeviceImage('Cam Cucina');
   * // { success: true, _imageData: '<base64>', _hasImage: true, ... }
   */
  async getDeviceImage(deviceName, deviceId = null) {
    if (!deviceName && !deviceId) {
      return { success: false, error: "Missing required parameter: provide 'deviceName' or 'deviceId'." };
    }

    try {
      await this.initialize();
      const devices = await this.api.devices.getDevices();
      const zones = await this.api.zones.getZones();
      let device;

      try {
        const resolved = await this._resolveDevice(deviceName, deviceId);
        device = resolved.device;
      } catch (err) {
        if (err.ambiguous) {
          return {
            success: false,
            ambiguous: true,
            error: err.message,
            matches: err.matches
          };
        }
        return { success: false, error: err.message };
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
   * @param {string|null} [deviceId=null] - Optional device UUID.
   * @returns {Promise<Object>} Result with `success`, `device`, `logs`, `count`, `message`.
   * @throws Never — errors are returned as `{ success: false, error }`.
   * @example
   * const result = await adapter.getDeviceHistory('Daikin Sala');
   * // { success: true, logs: [{ id: 'measure_temperature', name: 'Temperature', ... }] }
   */
  async getDeviceHistory(deviceName, deviceId = null) {
    if (!deviceName && !deviceId) {
      return { success: false, error: "Missing required parameter: provide 'deviceName' or 'deviceId'." };
    }

    await this.initialize();
    const devices = await this.api.devices.getDevices();
    const zones = await this.api.zones.getZones();
    let device;

    try {
      const resolved = await this._resolveDevice(deviceName, deviceId);
      device = resolved.device;
    } catch (err) {
      if (err.ambiguous) {
        return {
          success: false,
          ambiguous: true,
          error: err.message,
          matches: err.matches
        };
      }
      return { success: false, error: err.message };
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
        message: `Found ${formattedLogs.length} log(s) for ${device.name}. Use get_device_logs with the log ID to retrieve actual data.`
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
   * @param {string} resolution - Time resolution.
   * @param {string|null} [deviceId=null] - Optional device UUID.
   * @returns {Promise<Object>} Result with `success`, `entries`, `statistics`, `timezone`.
   * @throws Never — errors are returned as `{ success: false, error }`.
   * @example
   * const result = await adapter.getLogEntries('Daikin Sala', 'measure_temperature', 'last7Days');
   * // { success: true, entries: [{ timestamp: '2026-02-15T12:00:00', value: 21.5 }], statistics: { min, max, average } }
   */
  async getLogEntries(deviceName, logId, resolution, deviceId = null) {
    if (!deviceName && !deviceId) {
      return { success: false, error: "Missing required parameter: provide 'deviceName' or 'deviceId'." };
    }

    await this.initialize();
    const devices = await this.api.devices.getDevices();
    const zones = await this.api.zones.getZones();
    let device;

    try {
      const resolved = await this._resolveDevice(deviceName, deviceId);
      device = resolved.device;
    } catch (err) {
      if (err.ambiguous) {
        return {
          success: false,
          ambiguous: true,
          error: err.message,
          matches: err.matches
        };
      }
      return { success: false, error: err.message };
    }

    try {
      const logs = await device.getLogs();
      const log = logs[logId];

      if (!log) {
        const availableLogIds = Object.keys(logs);
        return {
          success: false,
          error: `Log "${logId}" not found for device "${deviceName}". Call get_device_logs with deviceName="${deviceName}" to get valid log IDs, then retry get_device_logs using one of the exact IDs in availableLogs.`,
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
    const method = flowType === 'advanced' ? 'triggerAdvancedFlow' : 'triggerFlow';
    const argsStr = args && Object.keys(args).length > 0 ? JSON.stringify(args) : 'null';
    const code = `await Homey.flow.${method}({ id: \"${flowId}\" }, ${argsStr});`;

    this.homey.log(`[HomeyMCPAdapter] Executing via HomeyScript: ${code}`);
    await this._executeHomeyScript(code);
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
    const argsJson = JSON.stringify(args).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const code = `return await Homey.flow.runFlowCardAction({ id: "${cardId}", uri: "${deviceUri}", args: JSON.parse("${argsJson}") });`;

    this.homey.log(`[HomeyMCPAdapter] Executing action via HomeyScript: ${cardId}`);
    return await this._executeHomeyScript(code);
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
  /**
   * Filters out devices that are not intended to be visible to Gemini.
   *
   * This includes:
   * 1. Members of a virtual group (redundant with the group device itself).
   * 2. Devices that the user has explicitly hidden in the Homey UI (device.hidden === true).
   *
   * @private
   * @param {Object|Object[]} devices - Map or Array of Homey device objects.
   * @returns {Object[]} Filtered array of devices.
   */
  _filterVisibleDevices(devices) {
    const deviceArray = Array.isArray(devices) ? devices : Object.values(devices);
    const excludedIds = new Set();

    // Identify all member IDs that belong to at least one group
    deviceArray.forEach(d => {
      const memberIds = d.settings?.deviceIds;
      if (Array.isArray(memberIds)) {
        memberIds.forEach(id => excludedIds.add(id));
      }
    });

    // Return only devices that are NOT in the excluded list AND are NOT hidden
    return deviceArray.filter(d => {
      const isGroupMember = excludedIds.has(d.id);
      const isHidden = d.hidden === true;
      return !isGroupMember && !isHidden;
    });
  }

  /**
   * Returns a minimal list of user-installed Homey apps with their ownerUri.
   *
   * Used by Gemini to discover app-scoped flow trigger/condition card owners
   * before calling `discoverFlowCards(cardType='trigger', ownerUri='...')`.
   * Only fields needed for flow card filtering are returned to minimise token usage.
   *
   * @public
   * @returns {Promise<Object>} Result with `success`, `count`, `apps` array of `{ name, ownerUri }`.
   * @throws Never — errors are returned as `{ success: false, error }`.
   * @example
   * const result = await adapter.listInstalledApps();
   * // { success: true, count: 12, apps: [{ name: 'HomeyScript', ownerUri: 'homey:app:com.athom.homeyscript' }] }
   */
  async listInstalledApps() {
    try {
      await this.initialize();
      const appsObj = await this.api.apps.getApps();
      const apps = Object.values(appsObj)
        .filter(a => a.uri && a.uri.startsWith('homey:app:'))
        .map(a => ({ name: a.name || a.id, ownerUri: a.uri }));

      return { success: true, count: apps.length, apps };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Returns the list of built-in Homey system managers with their ownerUri.
   *
   * Attempts to fetch managers from the API first; if none are found (API does not
   * expose them), falls back to a curated hardcoded list of the most common managers.
   * Only fields needed for flow card filtering are returned to minimise token usage.
   *
   * @public
   * @returns {Promise<Object>} Result with `success`, `count`, `managers` array of `{ name, ownerUri }`, and `source`.
   * @throws Never — errors are returned as `{ success: false, error }`.
   * @example
   * const result = await adapter.listSystemManagers();
   * // { success: true, count: 6, source: 'hardcoded', managers: [{ name: 'Clock', ownerUri: 'homey:manager:clock' }] }
   */
  async listSystemManagers() {
    /** @type {Array<{name: string, ownerUri: string}>} */
    const MANAGERS = [
      { name: 'Clock',        ownerUri: 'homey:manager:cron' },
      { name: 'Geolocation',  ownerUri: 'homey:manager:geolocation' },
      { name: 'Presence',     ownerUri: 'homey:manager:presence' },
      { name: 'Alarms',       ownerUri: 'homey:manager:alarms' },
      { name: 'Notifications', ownerUri: 'homey:manager:notifications' },
      { name: 'Logic',        ownerUri: 'homey:manager:logic' },
      { name: 'Mobile',       ownerUri: 'homey:manager:mobile' },
      { name: 'System',       ownerUri: 'homey:manager:system' }
    ];

    return { success: true, count: MANAGERS.length, source: 'hardcoded', managers: MANAGERS };
  }

  /**
   * Creates, updates, or deletes a Standard Homey Flow.
   *
   * Advanced Flows are explicitly rejected. The `update` and `delete` operations
   * accept either `flowId` (direct) or `flowName` (resolved via `api.flow.getFlows()`).
   *
   * @public
   * @param {Object} args - Arguments forwarded from the MCP tool call.
   * @param {'create'|'update'|'delete'} args.action - Operation to perform.
   * @param {string} [args.name] - Flow name. Required for 'create'.
   * @param {string} [args.flowId] - Flow ID (takes precedence over flowName for lookup).
   * @param {string} [args.flowName] - Flow name for lookup when flowId is absent.
   * @param {Object} [args.trigger] - Trigger card config `{ id, args }`. Required for 'create'. Do NOT include 'uri'.
   * @param {Array}  [args.conditions=[]] - Condition card configs `[{ id, args, inverted? }]`. Do NOT include 'uri'.
   * @param {Array}  [args.actions] - Action card configs `[{ id, args, group, delay, duration }]`. Required for 'create'. Do NOT include 'uri'.
   * @param {boolean} [args.enabled=true] - Whether the flow is enabled.
   * @returns {Promise<Object>} Result with `success`, `flow`, and `message`.
   * @throws Never — errors are returned as `{ success: false, error }`.
   * @example
   * const r = await adapter.manageFlow({
   *   action: 'create',
   *   name: 'Evening Lights',
   *   trigger: { id: 'homey:manager:clock:time', args: { time: '20:00:00' } },
   *   conditions: [],
   *   actions: [{ id: 'homey:device:UUID:onoff', args: { onoff: true }, group: 'then', delay: null, duration: null }]
   * });
   */
  async manageFlow(args) {
    const { action, name, flowId, flowName, trigger, conditions = [], actions, enabled = true } = args;

    if (!action) {
      return { success: false, error: "Missing required parameter 'action'. Must be 'create', 'update', or 'delete'." };
    }

    // Normalize card args if passed as stringified JSON strings or arrays by the model.
    // This is a defensive fallback — the model MUST always pass args as a native JSON object.
    // In Standard Flows, the cards MUST NOT contain 'ownerUri' or 'uri' (they are inferred implicitly by Homey).
    // Also, each condition MUST have a valid 'group' identifier (e.g. 'group1').
    if (trigger) {
      await this._normalizeCardArgs(trigger, 'manageFlow:trigger');
      delete trigger.ownerUri;
      delete trigger.uri;
    }
    if (conditions && Array.isArray(conditions)) {
      for (const cond of conditions) {
        if (cond) {
          await this._normalizeCardArgs(cond, 'manageFlow:condition');
          delete cond.ownerUri;
          delete cond.uri;
          if (cond.group === undefined || cond.group === null || cond.group === '') {
            cond.group = 'group1';
            this.homey.log(`[manageFlow] Condition missing group. Set default "group1".`);
          }
        }
      }
    }
    if (actions && Array.isArray(actions)) {
      for (const act of actions) {
        if (act) {
          await this._normalizeCardArgs(act, 'manageFlow:action');
          delete act.ownerUri;
          delete act.uri;
        }
      }
    }

    try {
      await this.initialize();

      // ── Helper: resolve a Standard Flow by ID or name ──────────────────────
      const _resolveStandardFlow = async (id, nameHint) => {
        const standardFlows = await this.api.flow.getFlows();
        if (id) {
          const f = standardFlows[id];
          if (!f) return { error: `Standard Flow with id "${id}" not found.` };
          return { flow: f };
        }
        if (!nameHint) return { error: "Provide 'flowId' or 'flowName' to identify the flow." };
        const f = Object.values(standardFlows).find(fl => fl.name.toLowerCase() === nameHint.toLowerCase());
        if (!f) {
          // Check if it exists as Advanced Flow and return a helpful error
          const advancedFlows = await this.api.flow.getAdvancedFlows();
          const adv = Object.values(advancedFlows).find(fl => fl.name.toLowerCase() === nameHint.toLowerCase());
          if (adv) return { error: `"${nameHint}" is an Advanced Flow. Advanced Flows cannot be modified via manage_flow.` };
          return { error: `Standard Flow "${nameHint}" not found. Call discover_flows to see available flows.` };
        }
        return { flow: f };
      };

      // ── CREATE ──────────────────────────────────────────────────────────────
      if (action === 'create') {
        if (!name) return { success: false, error: "Missing required parameter 'name' for action='create'." };
        if (!trigger) return { success: false, error: "Missing required parameter 'trigger' for action='create'." };
        if (!actions || actions.length === 0) return { success: false, error: "Parameter 'actions' must contain at least one item for action='create'." };

        // Pre-execution validation: verify all required args are populated for every card in the Standard Flow.
        const cardsToValidate = {};
        if (trigger) {
          cardsToValidate['trigger'] = { ...trigger, type: 'trigger' };
        }
        if (conditions && Array.isArray(conditions)) {
          conditions.forEach((c, idx) => {
            if (c) cardsToValidate[`condition_${idx}`] = { ...c, type: 'condition' };
          });
        }
        if (actions && Array.isArray(actions)) {
          actions.forEach((a, idx) => {
            if (a) cardsToValidate[`action_${idx}`] = { ...a, type: 'action' };
          });
        }

        const validationIssues = await this._validateAdvancedFlowCards(cardsToValidate, 'manageFlow');
        if (validationIssues.length > 0) {
          const issueDetails = validationIssues.map(v => {
            const schemaHint = v.requiredArgs.map(a => `${a.name} (${a.type})`).join(', ');
            const missing = v.missingArgs.map(a => `${a.name} (${a.type})`).join(', ');
            return `Card "${v.cardId}" [key: ${v.cardKey}]: missing required args [${missing}]. Full schema: { ${schemaHint} }`;
          }).join('\n');
          this.homey.log(`[manageFlow] Pre-execution validation failed:\n${issueDetails}`);
          return {
            success: false,
            error: `Cannot create Standard Flow: one or more cards have missing required arguments. Fix all issues and retry in a single call:\n${issueDetails}`
          };
        }

        const flowObj = { name, enabled, trigger, conditions: conditions ?? [], actions };
        this.homey.log(`[manageFlow] Creating flow: ${name}`);

        // Robust base64 encoding to avoid escaping issues in HomeyScript
        const base64Str = Buffer.from(JSON.stringify(flowObj)).toString('base64');
        const code = `return await Homey.flow.createFlow({ flow: JSON.parse(Buffer.from("${base64Str}", "base64").toString("utf8")) });`;

        const created = await this._executeHomeyScript(code);
        return {
          success: true,
          flow: { id: created.id, name: created.name, enabled: created.enabled },
          message: `Standard Flow "${created.name}" created successfully (id: ${created.id})`
        };
      }

      // ── UPDATE ──────────────────────────────────────────────────────────────
      if (action === 'update') {
        const { flow, error: resolveError } = await _resolveStandardFlow(flowId, flowName);
        if (resolveError) return { success: false, error: resolveError };

        const updates = {};
        if (name !== undefined) updates.name = name;
        if (trigger !== undefined) updates.trigger = trigger;
        if (conditions !== undefined) updates.conditions = conditions;
        if (actions !== undefined) updates.actions = actions;
        if (enabled !== undefined) updates.enabled = enabled;

        this.homey.log(`[manageFlow] Updating flow id=${flow.id} with keys: ${Object.keys(updates).join(', ')}`);
        const updatedFlowObj = { ...flow, ...updates };

        // Robust base64 encoding to avoid escaping issues in HomeyScript
        const base64Str = Buffer.from(JSON.stringify(updatedFlowObj)).toString('base64');
        const code = `return await Homey.flow.updateFlow({ id: "${flow.id}", flow: JSON.parse(Buffer.from("${base64Str}", "base64").toString("utf8")) });`;

        const updated = await this._executeHomeyScript(code);
        return {
          success: true,
          flow: { id: updated.id, name: updated.name, enabled: updated.enabled },
          message: `Standard Flow "${updated.name}" updated successfully`
        };
      }

      // ── DELETE ──────────────────────────────────────────────────────────────
      if (action === 'delete') {
        const { flow, error: resolveError } = await _resolveStandardFlow(flowId, flowName);
        if (resolveError) return { success: false, error: resolveError };

        this.homey.log(`[manageFlow] Deleting flow: ${flow.name} (id=${flow.id})`);
        await this._executeHomeyScript(`return await Homey.flow.deleteFlow({ id: "${flow.id}" });`);
        return {
          success: true,
          flow: { id: flow.id, name: flow.name },
          message: `Standard Flow "${flow.name}" deleted successfully`
        };
      }

      return { success: false, error: `Unknown action '${action}'. Must be 'create', 'update', or 'delete'.` };

    } catch (error) {
      this.homey.error(`[manageFlow] Error:`, error);

      // Enrich error feedback for 'Missing argument' failures:
      // parse the card ID from the error message and append the expected schema.
      const missingArgMatch = error.message && error.message.match(/Missing argument '([^']+)' for card '([^']+)'/);
      if (missingArgMatch) {
        const missingArgName = missingArgMatch[1];
        const cardId = missingArgMatch[2];

        // Find the offending card among trigger, conditions or actions
        let offendingCard = null;
        let cardType = 'action';

        if (trigger && trigger.id === cardId) {
          offendingCard = trigger;
          cardType = 'trigger';
        } else if (conditions && Array.isArray(conditions)) {
          offendingCard = conditions.find(c => c && c.id === cardId);
          cardType = 'condition';
        } else if (actions && Array.isArray(actions)) {
          offendingCard = actions.find(a => a && a.id === cardId);
          cardType = 'action';
        }

        if (offendingCard) {
          try {
            // Reconstruct ownerUri on a temp copy to query Homey API without modifying the original card
            const tempCard = { ...offendingCard };
            this._ensureCardUri(tempCard);
            let cardDef = null;
            if (cardType === 'trigger') {
              cardDef = await this.api.flow.getFlowCardTrigger({ id: tempCard.id, uri: tempCard.ownerUri }).catch(() => null);
            } else if (cardType === 'condition') {
              cardDef = await this.api.flow.getFlowCardCondition({ id: tempCard.id, uri: tempCard.ownerUri }).catch(() => null);
            } else {
              cardDef = await this.api.flow.getFlowCardAction({ id: tempCard.id, uri: tempCard.ownerUri }).catch(() => null);
            }
            if (cardDef && Array.isArray(cardDef.args)) {
              const schemaHint = cardDef.args.map(a => `${a.name} (type: ${a.type}${a.required === false ? ', optional' : ', required'})`).join(', ');
              const enrichedMessage = `${error.message}. Expected args for this card: { ${schemaHint} }. Current args sent: ${JSON.stringify(offendingCard.args)}. Fix this card and retry.`;
              return { success: false, error: enrichedMessage };
            }
          } catch (enrichErr) {
            this.homey.error(`[manageFlow] Error enriching validation message:`, enrichErr);
          }
        }
      }

      return { success: false, error: error.message };
    }
  }

  /**
   * Creates, updates, or deletes an Advanced Flow in Homey Pro.
   *
   * Interfaces with the HomeyScript proxy script using the privileged `Homey.flow.createAdvancedFlow`,
   * `Homey.flow.updateAdvancedFlow`, and `Homey.flow.deleteAdvancedFlow` methods.
   * Automatically computes layout coordinates for any cards missing 'x' or 'y'.
   *
   * @public
   * @param {Object} args - Arguments forwarded from the MCP tool call.
   * @param {'create'|'update'|'delete'} args.action - Operation to perform.
   * @param {string} [args.name] - Name for the Advanced Flow (required for 'create').
   * @param {string} [args.flowId] - Flow UUID (required for 'update' and 'delete' if known).
   * @param {string} [args.flowName] - Flow name for lookup fallback.
   * @param {Object} [args.cards] - Map of card objects representing nodes.
   * @param {boolean} [args.enabled=true] - Initial enabled state.
   * @returns {Promise<Object>} Execution result containing `success` and a status `message`.
   * @throws Never — errors are caught and returned as `{ success: false, error }`.
   * @example
   * const result = await adapter.manageAdvancedFlow({
   *   action: 'create',
   *   name: 'Turn Lights On At 8',
   *   cards: { ... }
   * });
   */
  async manageAdvancedFlow(args) {
    const { action, name, flowId, flowName, cards, enabled = true } = args;

    if (!action) {
      return { success: false, error: "Missing required parameter 'action'. Must be 'create', 'update', or 'delete'." };
    }

    // Normalize card args if passed as stringified JSON strings or arrays by the model.
    // This is a defensive fallback — the model MUST always pass args as a native JSON object.
    if (cards && typeof cards === 'object') {
      for (const key of Object.keys(cards)) {
        const card = cards[key];
        await this._normalizeCardArgs(card, 'manageAdvancedFlow');
        this._ensureCardUri(card);

        // NATIVE LOGIC CARDS FIX:
        // 'any', 'all', 'start' and 'delay' nodes are native to Advanced Flow engine and do not have an 'id' or 'ownerUri'.
        // If the model hallucinated an id (e.g. 'homey:manager:logic:any'), strip it out here
        // to prevent Homey from attempting to render it as a standard action card.
        if (card.type === 'any' || card.type === 'all' || card.type === 'start' || card.type === 'delay') {
          delete card.id;
          delete card.ownerUri;
        }
      }
    }

    try {
      await this.initialize();

      // Helper to resolve an Advanced Flow by ID or name
      const _resolveAdvancedFlow = async (id, nameHint) => {
        const advancedFlows = await this.api.flow.getAdvancedFlows();
        if (id) {
          const f = advancedFlows[id];
          if (!f) return { error: `Advanced Flow with id "${id}" not found.` };
          return { flow: f };
        }
        if (!nameHint) return { error: "Provide 'flowId' or 'flowName' to identify the flow." };
        const f = Object.values(advancedFlows).find(fl => fl.name.toLowerCase() === nameHint.toLowerCase());
        if (!f) {
          // Check if it exists as Standard Flow and return a helpful error
          const standardFlows = await this.api.flow.getFlows();
          const std = Object.values(standardFlows).find(fl => fl.name.toLowerCase() === nameHint.toLowerCase());
          if (std) return { error: `"${nameHint}" is a Standard Flow. Standard Flows cannot be modified via manage_advanced_flow.` };
          return { error: `Advanced Flow "${nameHint}" not found. Call discover_flows to see available flows.` };
        }
        return { flow: f };
      };

      // ── CREATE ──────────────────────────────────────────────────────────────
      if (action === 'create') {
        if (!name) return { success: false, error: "Missing required parameter 'name' for action='create'." };
        if (!cards || Object.keys(cards).length === 0) {
          return { success: false, error: "Missing required parameter 'cards' for action='create'. Must contain at least one node." };
        }

        // Apply auto-layout coordinates if they are not provided
        const finalizedCards = this._applyAdvancedFlowAutoLayout(cards);

        // Pre-execution validation: verify all required args are populated for every card.
        const validationIssues = await this._validateAdvancedFlowCards(finalizedCards, 'manageAdvancedFlow');
        if (validationIssues.length > 0) {
          const issueDetails = validationIssues.map(v => {
            const schemaHint = v.requiredArgs.map(a => `${a.name} (${a.type})`).join(', ');
            const missing = v.missingArgs.map(a => `${a.name} (${a.type})`).join(', ');
            return `Card "${v.cardId}" [key: ${v.cardKey}]: missing required args [${missing}]. Full schema: { ${schemaHint} }`;
          }).join('\n');
          this.homey.log(`[manageAdvancedFlow] Pre-execution validation failed:\n${issueDetails}`);
          return {
            success: false,
            error: `Cannot create Advanced Flow: one or more cards have missing required arguments. Fix all issues and retry in a single call:\n${issueDetails}`
          };
        }

        const advancedflow = { name, enabled, cards: finalizedCards };
        this.homey.log(`[manageAdvancedFlow] Creating advanced flow: ${name}`);

        // Robust base64 encoding to avoid string escaping issues inside HomeyScript code
        const base64Str = Buffer.from(JSON.stringify(advancedflow)).toString('base64');
        const code = `return await Homey.flow.createAdvancedFlow({ advancedflow: JSON.parse(Buffer.from("${base64Str}", "base64").toString("utf8")) });`;

        const created = await this._executeHomeyScript(code);
        return {
          success: true,
          flow: { id: created.id, name: created.name, enabled: created.enabled },
          message: `Advanced Flow "${created.name}" created successfully (id: ${created.id})`
        };
      }

      // ── UPDATE ──────────────────────────────────────────────────────────────
      if (action === 'update') {
        const { flow, error: resolveError } = await _resolveAdvancedFlow(flowId, flowName);
        if (resolveError) return { success: false, error: resolveError };

        const updates = {};
        if (name !== undefined) updates.name = name;
        if (enabled !== undefined) updates.enabled = enabled;
        if (cards !== undefined) {
          const finalizedCards = this._applyAdvancedFlowAutoLayout(cards);
          updates.cards = finalizedCards;
        }

        this.homey.log(`[manageAdvancedFlow] Updating advanced flow id=${flow.id} with keys: ${Object.keys(updates).join(', ')}`);
        const updatedFlowObj = { ...flow, ...updates };

        // Robust base64 encoding to avoid escaping issues in HomeyScript
        const base64Str = Buffer.from(JSON.stringify(updatedFlowObj)).toString('base64');
        const code = `return await Homey.flow.updateAdvancedFlow({ id: "${flow.id}", advancedflow: JSON.parse(Buffer.from("${base64Str}", "base64").toString("utf8")) });`;

        const updated = await this._executeHomeyScript(code);
        return {
          success: true,
          flow: { id: updated.id, name: updated.name, enabled: updated.enabled },
          message: `Advanced Flow "${updated.name}" updated successfully`
        };
      }

      // ── DELETE ──────────────────────────────────────────────────────────────
      if (action === 'delete') {
        const { flow, error: resolveError } = await _resolveAdvancedFlow(flowId, flowName);
        if (resolveError) return { success: false, error: resolveError };

        this.homey.log(`[manageAdvancedFlow] Deleting advanced flow: ${flow.name} (id=${flow.id})`);
        await this._executeHomeyScript(`return await Homey.flow.deleteAdvancedFlow({ id: "${flow.id}" });`);
        return {
          success: true,
          flow: { id: flow.id, name: flow.name },
          message: `Advanced Flow "${flow.name}" deleted successfully`
        };
      }

      return { success: false, error: `Unknown action '${action}'. Must be 'create', 'update', or 'delete'.` };

    } catch (error) {
      this.homey.error(`[manageAdvancedFlow] Error:`, error);

      // Enrich error feedback for 'Missing argument' failures:
      // parse the card ID from the error message and append the expected schema.
      const missingArgMatch = error.message && error.message.match(/Missing argument '([^']+)' for card '([^']+)'/);
      if (missingArgMatch && cards && typeof cards === 'object') {
        const missingArgName = missingArgMatch[1];
        const cardId = missingArgMatch[2];
        const offendingCard = Object.values(cards).find(c => c && c.id === cardId);
        if (offendingCard) {
          try {
            this._ensureCardUri(offendingCard);
            const cardType = offendingCard.type || 'action';
            let cardDef = null;
            if (cardType === 'trigger') {
              cardDef = await this.api.flow.getFlowCardTrigger({ id: offendingCard.id, uri: offendingCard.ownerUri }).catch(() => null);
            } else if (cardType === 'condition') {
              cardDef = await this.api.flow.getFlowCardCondition({ id: offendingCard.id, uri: offendingCard.ownerUri }).catch(() => null);
            } else {
              cardDef = await this.api.flow.getFlowCardAction({ id: offendingCard.id, uri: offendingCard.ownerUri }).catch(() => null);
            }
            if (cardDef && Array.isArray(cardDef.args)) {
              const schemaHint = cardDef.args.map(a => `${a.name} (type: ${a.type}${a.required === false ? ', optional' : ', required'})`).join(', ');
              const enrichedMessage = `${error.message}. Expected args for this card: { ${schemaHint} }. Current args sent: ${JSON.stringify(offendingCard.args)}. Fix this card and retry.`;
              return { success: false, error: enrichedMessage };
            }
          } catch (enrichErr) {
            this.homey.error(`[manageAdvancedFlow] Error enriching validation message:`, enrichErr);
          }
        }
      }

      return { success: false, error: error.message };
    }
  }

  /**
   * Validates that all required arguments are populated for every card in an Advanced Flow map.
   *
   * For each card in the `cards` object, this method fetches the official card schema from
   * the Homey API and checks that every required argument has a non-null, non-empty value.
   * Arguments using the Homey token syntax (`[[...]]`) are considered valid regardless of type.
   *
   * This method is called as a pre-execution gate inside {@link HomeyMCPAdapter#manageAdvancedFlow}
   * before the flow is submitted to Homey, allowing the model to receive a complete list of
   * all missing arguments across all cards in a single error message rather than one at a time.
   *
   * @private
   * @async
   * @param {Object} cards - The map of card key → card objects to validate.
   * @param {string} contextLabel - Label for log output (e.g. `'manageAdvancedFlow'`).
   * @returns {Promise<Array<{cardKey: string, cardId: string, missingArgs: Array<{name: string, type: string}>, requiredArgs: Array<{name: string, type: string}>}>>}
   *   Array of validation issues. Empty array means all cards are valid.
   * @example
   * const issues = await this._validateAdvancedFlowCards(finalizedCards, 'manageAdvancedFlow');
   * if (issues.length > 0) { ... }
   */
  async _validateAdvancedFlowCards(cards, contextLabel) {
    if (!cards || typeof cards !== 'object') return [];

    const issues = [];

    for (const [cardKey, card] of Object.entries(cards)) {
      if (!card || !card.id) continue;

      try {
        this._ensureCardUri(card);
        const cardType = card.type || 'action';
        let cardDef = null;

        if (cardType === 'trigger') {
          cardDef = await this.api.flow.getFlowCardTrigger({ id: card.id, uri: card.ownerUri }).catch(() => null);
        } else if (cardType === 'condition') {
          cardDef = await this.api.flow.getFlowCardCondition({ id: card.id, uri: card.ownerUri }).catch(() => null);
        } else {
          cardDef = await this.api.flow.getFlowCardAction({ id: card.id, uri: card.ownerUri }).catch(() => null);
        }

        if (!cardDef || !Array.isArray(cardDef.args)) continue;

        const requiredArgs = cardDef.args.filter(a => a.required !== false);
        const missingArgs = [];

        for (const argDef of requiredArgs) {
          const val = card.args && card.args[argDef.name];

          // Allow Homey token syntax [[...]] as a valid value regardless of type
          const isToken = typeof val === 'string' && /^\[\[.+]]$/.test(val.trim());
          if (isToken) continue;

          // Check for null, undefined, empty string, or the sentinel string "null"
          const isEmpty = val === undefined || val === null || val === '' || val === 'null';
          if (isEmpty) {
            missingArgs.push({ name: argDef.name, type: argDef.type });
          }
        }

        if (missingArgs.length > 0) {
          issues.push({
            cardKey,
            cardId: card.id,
            missingArgs,
            requiredArgs: requiredArgs.map(a => ({ name: a.name, type: a.type }))
          });
          this.homey.log(`[${contextLabel}] [pre-validation] Card "${card.id}" [key: ${cardKey}]: missing args: ${missingArgs.map(a => a.name).join(', ')}`);
        }
      } catch (err) {
        this.homey.error(`[${contextLabel}] [pre-validation] Error validating card "${card.id}":`, err);
      }
    }

    return issues;
  }

  /**
   * Applies an automatic spatial layout to Advanced Flow cards using a graph-based BFS leveling algorithm.
   *
   * Analyzes card outputs (outputSuccess, outputError, outputTrue, outputFalse) to reconstruct the directed
   * acyclic graph (DAG) structure. Distributes nodes along columns (x coordinates) and centers them
   * vertically (y coordinates) to prevent overlapping on the visual canvas.
   *
   * @private
   * @param {Object} cards - The map of cards to layout.
   * @returns {Object} The cards map with calculated x and y properties where missing.
   * @example
   * const cardsWithCoords = this._applyAdvancedFlowAutoLayout(cards);
   */
  _applyAdvancedFlowAutoLayout(cards) {
    if (!cards || typeof cards !== 'object') return cards;

    // 1. Build child map and incoming link counts
    const uuids = Object.keys(cards);
    const children = {};
    const incoming = {};

    uuids.forEach(uuid => {
      children[uuid] = [];
      incoming[uuid] = 0;
    });

    uuids.forEach(uuid => {
      const card = cards[uuid];
      const outputs = [
        ...(card.outputSuccess || []),
        ...(card.outputError || []),
        ...(card.outputTrue || []),
        ...(card.outputFalse || [])
      ];

      outputs.forEach(childUuid => {
        if (children[uuid] && !children[uuid].includes(childUuid)) {
          children[uuid].push(childUuid);
        }
        if (incoming[childUuid] !== undefined) {
          incoming[childUuid]++;
        }
      });
    });

    // 2. Queue roots (nodes with 0 incoming links, or type = 'trigger')
    const queue = [];
    const levels = {};

    uuids.forEach(uuid => {
      if (incoming[uuid] === 0 || cards[uuid].type === 'trigger') {
        queue.push({ uuid, level: 0 });
        levels[uuid] = 0;
      }
    });

    // Fallback: if all nodes have incoming links, queue everything
    if (queue.length === 0 && uuids.length > 0) {
      queue.push({ uuid: uuids[0], level: 0 });
      levels[uuids[0]] = 0;
    }

    // 3. BFS leveling with protection against infinite loops
    let steps = 0;
    const maxSteps = 1000;
    while (queue.length > 0 && steps < maxSteps) {
      steps++;
      const { uuid, level } = queue.shift();
      const currentLevel = Math.max(levels[uuid] || 0, level);
      levels[uuid] = currentLevel;

      const nextLevel = currentLevel + 1;
      (children[uuid] || []).forEach(childUuid => {
        if (levels[childUuid] === undefined || levels[childUuid] < nextLevel) {
          levels[childUuid] = nextLevel;
          queue.push({ uuid: childUuid, level: nextLevel });
        }
      });
    }

    // 4. Assign default level for any remaining cards
    uuids.forEach(uuid => {
      if (levels[uuid] === undefined) {
        levels[uuid] = 0;
      }
    });

    // 5. Group by level to calculate coordinates
    const levelGroups = {};
    uuids.forEach(uuid => {
      const lvl = levels[uuid];
      if (!levelGroups[lvl]) {
        levelGroups[lvl] = [];
      }
      levelGroups[lvl].push(uuid);
    });

    // 6. Set coordinates (x spacing: 450px, y spacing: 160px, center around y=400)
    Object.entries(levelGroups).forEach(([lvlStr, group]) => {
      const lvl = parseInt(lvlStr, 10);
      const xCoord = 50 + lvl * 450;
      const count = group.length;

      group.forEach((uuid, index) => {
        const card = cards[uuid];
        const yCoord = 400 - ((count - 1) / 2) * 160 + index * 160;

        // Logic and control nodes (ALL, ANY, START and DELAY) have a significantly smaller width
        // compared to standard trigger/action cards (~250px).
        // Adding a positive X offset centers them inside the 450px column gap,
        // preventing them from appearing uncomfortably shifted 'to the left'.
        let finalX = xCoord;
        if (card.type === 'any') {
          finalX += 150;
        } else if (card.type === 'all') {
          finalX += 100;
        } else if (card.type === 'start') {
          finalX += 100;
        } else if (card.type === 'delay') {
          finalX += 100;
        }

        if (card.x === undefined || card.x === null) {
          card.x = finalX;
        }
        if (card.y === undefined || card.y === null) {
          card.y = Math.round(yCoord);
        }
      });
    });

    return cards;
  }


  // ── Flow Inspection ─────────────────────────────────────────────────────────

  /**
   * Retrieves the complete internal structure of a Homey Flow (Standard or Advanced).
   *
   * Resolves the flow by ID first, then falls back to case-insensitive name matching.
   * The returned object strips all geometric/layout data (x, y, width, etc.) from
   * Advanced Flows to minimise token usage when passed to Gemini.
   *
   * @public
   * @param {string} [flowId] - Unique UUID of the flow. Takes priority over flowName.
   * @param {string} [flowName] - Exact name of the flow (case-insensitive). Used if flowId is absent.
   * @returns {Promise<Object>} Result with `success`, `type` ('standard'|'advanced'), `flow` details, and `message`.
   * @throws Never — errors are returned as `{ success: false, error }`.
   * @example
   * // By ID (preferred)
   * const result = await adapter.discoverFlowDetails('4599a377-c4a3-4f09-9a18-2ebb421ab0ad');
   * // By name (fallback)
   * const result = await adapter.discoverFlowDetails(null, 'Saluto Echo Studio');
   */
  async discoverFlowDetails(flowId, flowName) {
    if (!flowId && !flowName) {
      return { success: false, error: "Provide either 'flowId' or 'flowName' to retrieve flow details." };
    }

    try {
      await this.initialize();

      const standardFlows = await this.api.flow.getFlows();
      const advancedFlows = await this.api.flow.getAdvancedFlows();

      let flow = null;
      let flowType = 'standard';

      if (flowId) {
        flow = standardFlows[flowId];
        if (!flow) {
          flow = advancedFlows[flowId];
          if (flow) flowType = 'advanced';
        }
      } else {
        flow = Object.values(standardFlows).find(f => f.name.toLowerCase() === flowName.toLowerCase());
        if (!flow) {
          flow = Object.values(advancedFlows).find(f => f.name.toLowerCase() === flowName.toLowerCase());
          if (flow) flowType = 'advanced';
        }
      }

      if (!flow) {
        const allNames = [
          ...Object.values(standardFlows).map(f => f.name),
          ...Object.values(advancedFlows).map(f => f.name)
        ];
        const suggestion = this._suggestDeviceClass(flowId || flowName, allNames);
        return {
          success: false,
          error: `Flow not found.${suggestion ? ` Did you mean "${suggestion}"?` : ''} Use discover_flows to obtain a valid flow ID or name.`,
          suggestion: suggestion || null
        };
      }

      this.homey.log(`[discoverFlowDetails] Inspecting ${flowType} flow: ${flow.name} (id=${flow.id})`);

      const cleaned = flowType === 'standard'
        ? this._cleanStandardFlow(flow)
        : this._cleanAdvancedFlow(flow);

      return {
        success: true,
        type: flowType,
        flow: cleaned,
        message: `Successfully retrieved details for ${flowType} Flow "${flow.name}"`
      };

    } catch (error) {
      this.homey.error('[discoverFlowDetails] Error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Returns a cleaned representation of a Standard Flow, keeping only functional data.
   *
   * Strips non-semantic fields (timestamps, internal Athom metadata, etc.) to reduce
   * the number of tokens sent to Gemini when the flow object is part of a function result.
   *
   * @private
   * @param {Object} flow - The raw Standard Flow object from the Homey API.
   * @returns {Object} Cleaned flow with `id`, `name`, `enabled`, `trigger`, `conditions`, `actions`.
   * @example
   * const cleaned = this._cleanStandardFlow(rawFlow);
   * // { id: '...', name: 'Evening Lights', enabled: true, trigger: {...}, conditions: [], actions: [...] }
   */
  _cleanStandardFlow(flow) {
    return {
      id: flow.id,
      name: flow.name,
      enabled: flow.enabled !== false,
      trigger: flow.trigger ? {
        id: flow.trigger.id,
        args: flow.trigger.args || {}
      } : null,
      conditions: Array.isArray(flow.conditions)
        ? flow.conditions.map(c => ({
            id: c.id,
            args: c.args || {},
            group: c.group || null,
            inverted: c.inverted !== false
          }))
        : [],
      actions: Array.isArray(flow.actions)
        ? flow.actions.map(a => ({
            id: a.id,
            args: a.args || {},
            group: a.group || 'then',
            delay: a.delay || null,
            duration: a.duration || null
          }))
        : []
    };
  }

  /**
   * Returns a cleaned representation of an Advanced Flow, stripping all geometric/layout data.
   *
   * Advanced Flows from the Homey API contain large amounts of x/y coordinate, size, and
   * styling metadata for the visual canvas. This method discards all of that, keeping only
   * the semantic card data (type, card ID, and arguments) that Gemini needs to understand
   * the automation logic.
   *
   * @private
   * @param {Object} flow - The raw Advanced Flow object from the Homey API.
   * @returns {Object} Cleaned flow with `id`, `name`, `enabled`, and `cards` map.
   * @example
   * const cleaned = this._cleanAdvancedFlow(rawFlow);
   * // { id: '...', name: 'Spegni Daikin', enabled: true, cards: { '<cardKey>': { type, id, args }, ... } }
   */
  _cleanAdvancedFlow(flow) {
    const cards = {};

    if (flow.cards && typeof flow.cards === 'object') {
      Object.entries(flow.cards).forEach(([key, card]) => {
        cards[key] = {
          type: card.type || null,
          id: card.id || null,
          args: card.args || {},
          ...(card.delay ? { delay: card.delay } : {}),
          ...(card.duration ? { duration: card.duration } : {})
        };
      });
    }

    return {
      id: flow.id,
      name: flow.name,
      enabled: flow.enabled !== false,
      cards
    };
  }

  /**
   * Infers the most likely primary argument key name for a given Homey flow card ID.
   *
   * Used as a defensive fallback when the Gemini model incorrectly passes an array instead
   * of an object for the `args` field of an Advanced Flow card node. This method applies a
   * pattern-based lookup against known card ID suffixes and app URIs to return the first
   * (and usually only) argument key expected by the card.
   *
   * **Known mappings (non-exhaustive):**
   * - `echo-speak` / `say` → `message`
   * - `alexa-command` / `command` / `speak` → `command`
   * - `text` / `prompt` / `question` / `notification` → `text`
   * - `homey:manager:notifications:create_notification` → `text`
   * - Any Gemini AI card (`com.dimapp.geminiai`) → `prompt`
   *
   * @private
   * @param {string} cardId - The full card ID string (e.g. `'homey:device:UUID:echo-speak'`
   *   or `'homey:app:com.dimapp.geminiai:ask'`).
   * @returns {string} Inferred argument key. Defaults to `'text'` if no pattern matches.
   * @example
   * this._inferFirstArgKey('homey:device:abc123:echo-speak'); // → 'message'
   * this._inferFirstArgKey('homey:app:com.dimapp.geminiai:ask'); // → 'prompt'
   * this._inferFirstArgKey('homey:manager:cron:time_exactly'); // → 'time'
   */
  _inferFirstArgKey(cardId) {
    if (!cardId || typeof cardId !== 'string') return 'text';

    const id = cardId.toLowerCase();

    // Speaker / TTS cards
    if (id.includes('echo-speak') || id.includes('echo_speak') || id.includes('say')) return 'message';
    if (id.includes('alexa-command') || id.endsWith(':command') || id.includes('alexa_command')) return 'command';
    if (id.includes('speak') && !id.includes('echo')) return 'message';
    if (id.includes('tts') || id.includes('text_to_speech')) return 'text';

    // Gemini AI cards
    if (id.includes('com.dimapp.geminiai')) return 'prompt';

    // Notification cards
    if (id.includes('notification')) return 'text';

    // Clock / time cards
    if (id.includes('time_exactly') || id.includes('cron:time')) return 'time';

    // Logic / variable cards
    if (id.includes('logic') && id.includes('set')) return 'value';

    // Generic fallback
    return 'text';
  }

  /**
   * Normalizes a card's `args` property in case it was incorrectly formatted by the model.
   *
   * Applies a three-phase pipeline:
   *
   * **Phase 1 — Structural repair**: If `args` is a JSON string it is parsed into an object.
   * If `args` is an array (incorrectly serialized by the model), the first element is
   * reassigned under the key inferred by {@link HomeyMCPAdapter#_inferFirstArgKey}.
   *
   * **Phase 2 — Schema fetch**: Fetches the official card definition from the Homey API
   * to obtain the full argument schema (names, types, constraints).
   *
   * **Phase 3 — Per-type coercion**: For each argument defined in the schema the raw
   * value supplied by the model is coerced to the correct JS type:
   * - `text` / `date` / `time` / `color` → `String`
   * - `number` → `Number`, clamped to `[min, max]`
   * - `range` → `parseFloat`, clamped to `[min, max]` (default 0–1)
   * - `checkbox` → `Boolean`
   * - `dropdown` → validated against `argDef.values`; resolves by `id` first,
   *   then case-insensitive label match, then first available option as fallback
   * - `multiselect` → array of valid `id` strings filtered against `argDef.values`
   * - `autocomplete` / `device` → string resolved to autocomplete object via
   *   `getFlowCardAutocomplete` API call (case-insensitive name match, first result fallback)
   * - `droptoken` and any unknown type → left untouched
   *
   * This is a defensive fallback layer for both Standard and Advanced Flows. All mutations
   * are performed **in place** on the `card` object.
   *
   * @private
   * @async
   * @param {Object} card - The card object to normalize.
   * @param {string} card.id - The card identifier (e.g. `'homey:device:UUID:onoff'`).
   * @param {string} [card.ownerUri] - The ownerUri of the card. Inferred from `id` if absent.
   * @param {string} [card.type='action'] - Card type: `'trigger'`, `'condition'` or `'action'`.
   * @param {*} card.args - The raw arguments to normalize. Mutated in place.
   * @param {string} contextLabel - Label used in log outputs (e.g. `'manageFlow'`, `'manageAdvancedFlow'`).
   * @returns {Promise<void>} Resolves when normalization is complete.
   * @example
   * // String args — phase 1 parses, phase 3 coerces
   * const card = { id: 'homey:device:123:onoff', type: 'action', args: '{"onoff": true}' };
   * await this._normalizeCardArgs(card, 'manageFlow');
   * // card.args → { onoff: true }
   *
   * @example
   * // Dropdown with label instead of id
   * const card = { id: 'homey:manager:cron:time_exactly', type: 'trigger', args: { when: 'Monday' } };
   * await this._normalizeCardArgs(card, 'manageAdvancedFlow');
   * // card.args.when → 'mon'  (resolved by label match)
   */
  async _normalizeCardArgs(card, contextLabel) {
    if (!card) return;
    if (card.args === null) {
      card.args = {};
    }
    if (card.args === undefined) return;

    // Step 1: If args is a JSON string, parse it into an object.
    if (typeof card.args === 'string') {
      try {
        const parsed = JSON.parse(card.args);
        card.args = parsed;
        this.homey.log(`[${contextLabel}] [normalize] Card (${card.id}): args was a JSON string, parsed into object.`);
      } catch (e) {
        try {
          // Fallback parsing: if model passes valid JS object literal instead of standard JSON (e.g. unquoted keys or single quotes)
          const parsed = (new Function(`return (${card.args})`))();
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            card.args = parsed;
            this.homey.log(`[${contextLabel}] [normalize] Card (${card.id}): args was a JS object literal, parsed via fallback evaluation.`);
          } else {
            throw new Error('Not a plain object');
          }
        } catch (fallbackError) {
          this.homey.log(`[${contextLabel}] [normalize] Card (${card.id}): args is a non-parseable string. Wrapping as { text: "..." }.`);
          card.args = { text: card.args };
        }
      }
    }

    // Step 2: If args is an array, reconstruct object using card schema or heuristic key.
    if (Array.isArray(card.args)) {
      if (card.args.length === 1 && typeof card.args[0] === 'object' && card.args[0] !== null && !Array.isArray(card.args[0])) {
        this.homey.log(`[${contextLabel}] [normalize] Card (${card.id}): args was a single-object array. Extracting object directly.`);
        card.args = card.args[0];
      } else {
        const argKey = this._inferFirstArgKey(card.id);
        const value = card.args.length > 0 ? card.args[0] : null;
        this.homey.log(`[${contextLabel}] [normalize] Card (${card.id}): args was an array ${JSON.stringify(card.args)}. Inferring key="${argKey}", reconstructing as { ${argKey}: "${value}" }.`);
        card.args = value !== null ? { [argKey]: value } : {};
      }
    }

    // Step 3: Schema-driven per-argument type normalization.
    if (card.args && typeof card.args === 'object' && !Array.isArray(card.args)) {
      try {
        await this.initialize();
        this._ensureCardUri(card);
        const cardType = card.type || 'action';
        let cardDef = null;

        // Fetch card schema from the Homey API.
        if (cardType === 'trigger') {
          cardDef = await this.api.flow.getFlowCardTrigger({ id: card.id, uri: card.ownerUri }).catch(() => null);
        } else if (cardType === 'condition') {
          cardDef = await this.api.flow.getFlowCardCondition({ id: card.id, uri: card.ownerUri }).catch(() => null);
        } else {
          cardDef = await this.api.flow.getFlowCardAction({ id: card.id, uri: card.ownerUri }).catch(() => null);
        }

        if (cardDef && Array.isArray(cardDef.args)) {
          for (const argDef of cardDef.args) {
            const argName = argDef.name;
            const argType = argDef.type;
            const rawVal = card.args[argName];

            // Skip args not provided by the model (optional args may be absent).
            if (rawVal === undefined) continue;

            switch (argType) {

              // --- text, date, time, color: ensure string ---
              case 'text':
              case 'date':
              case 'time':
              case 'color': {
                if (typeof rawVal !== 'string') {
                  const coerced = String(rawVal);
                  this.homey.log(`[${contextLabel}] [normalize] Card (${card.id}): arg "${argName}" type="${argType}" coerced ${JSON.stringify(rawVal)} -> "${coerced}".`);
                  card.args[argName] = coerced;
                }
                break;
              }

              // --- number: ensure numeric, clamp to min/max if defined ---
              case 'number': {
                const num = Number(rawVal);
                if (isNaN(num)) {
                  this.homey.log(`[${contextLabel}] [normalize] Card (${card.id}): arg "${argName}" type="number" could not parse "${rawVal}", removing arg.`);
                  delete card.args[argName];
                  break;
                }
                let clamped = num;
                if (argDef.min !== undefined && clamped < argDef.min) clamped = argDef.min;
                if (argDef.max !== undefined && clamped > argDef.max) clamped = argDef.max;
                if (clamped !== rawVal) {
                  this.homey.log(`[${contextLabel}] [normalize] Card (${card.id}): arg "${argName}" type="number" coerced ${JSON.stringify(rawVal)} -> ${clamped}.`);
                }
                card.args[argName] = clamped;
                break;
              }

              // --- range: same as number, but typically a float between 0 and 1 ---
              case 'range': {
                const flt = parseFloat(rawVal);
                if (isNaN(flt)) {
                  this.homey.log(`[${contextLabel}] [normalize] Card (${card.id}): arg "${argName}" type="range" could not parse "${rawVal}", removing arg.`);
                  delete card.args[argName];
                  break;
                }
                let clampedFlt = flt;
                const rMin = argDef.min !== undefined ? argDef.min : 0;
                const rMax = argDef.max !== undefined ? argDef.max : 1;
                if (clampedFlt < rMin) clampedFlt = rMin;
                if (clampedFlt > rMax) clampedFlt = rMax;
                if (clampedFlt !== rawVal) {
                  this.homey.log(`[${contextLabel}] [normalize] Card (${card.id}): arg "${argName}" type="range" coerced ${JSON.stringify(rawVal)} -> ${clampedFlt}.`);
                }
                card.args[argName] = clampedFlt;
                break;
              }

              // --- checkbox: coerce to boolean ---
              case 'checkbox': {
                let bool;
                if (typeof rawVal === 'boolean') {
                  bool = rawVal;
                } else if (typeof rawVal === 'string') {
                  bool = rawVal.toLowerCase() === 'true' || rawVal === '1';
                } else {
                  bool = Boolean(rawVal);
                }
                if (bool !== rawVal) {
                  this.homey.log(`[${contextLabel}] [normalize] Card (${card.id}): arg "${argName}" type="checkbox" coerced ${JSON.stringify(rawVal)} -> ${bool}.`);
                }
                card.args[argName] = bool;
                break;
              }

              // --- dropdown: validate against allowed values, pick best match ---
              case 'dropdown': {
                const allowedValues = Array.isArray(argDef.values) ? argDef.values : [];
                if (allowedValues.length === 0) break;

                // Accept already-correct id strings or objects with an id field.
                const candidateId = (typeof rawVal === 'object' && rawVal !== null && rawVal.id)
                  ? String(rawVal.id)
                  : String(rawVal);

                const exactMatch = allowedValues.find(v => v.id === candidateId);
                if (exactMatch) {
                  // Value is already a valid id; keep as-is (Homey expects the raw id string).
                  if (card.args[argName] !== candidateId) {
                    this.homey.log(`[${contextLabel}] [normalize] Card (${card.id}): arg "${argName}" type="dropdown" normalized to id "${candidateId}".`);
                    card.args[argName] = candidateId;
                  }
                  break;
                }

                // Case-insensitive label match as fallback.
                const labelMatch = allowedValues.find(v => {
                  const label = v.label || v.title;
                  const labelText = label && typeof label === 'object' ? (label.en || Object.values(label)[0]) : String(label || '');
                  return labelText.toLowerCase() === candidateId.toLowerCase();
                });
                if (labelMatch) {
                  this.homey.log(`[${contextLabel}] [normalize] Card (${card.id}): arg "${argName}" type="dropdown" resolved label "${candidateId}" -> id "${labelMatch.id}".`);
                  card.args[argName] = labelMatch.id;
                  break;
                }

                // Fallback: first available option.
                this.homey.log(`[${contextLabel}] [normalize] Card (${card.id}): arg "${argName}" type="dropdown" no match for "${candidateId}", falling back to first option "${allowedValues[0].id}".`);
                card.args[argName] = allowedValues[0].id;
                break;
              }

              // --- multiselect: ensure array of valid ids ---
              case 'multiselect': {
                const allowedMs = Array.isArray(argDef.values) ? argDef.values : [];
                const allowedIds = allowedMs.map(v => v.id);

                // Normalize to array of strings.
                let candidates;
                if (Array.isArray(rawVal)) {
                  candidates = rawVal.map(v => (typeof v === 'object' && v !== null && v.id) ? String(v.id) : String(v));
                } else {
                  candidates = [String(rawVal)];
                }

                // Keep only valid ids.
                const valid = allowedIds.length > 0
                  ? candidates.filter(c => allowedIds.includes(c))
                  : candidates;

                this.homey.log(`[${contextLabel}] [normalize] Card (${card.id}): arg "${argName}" type="multiselect" resolved to [${valid.join(', ')}].`);
                card.args[argName] = valid;
                break;
              }

              // --- autocomplete / device: resolve string to object via Homey API ---
              case 'device':
              case 'autocomplete': {
                if (typeof rawVal === 'string' && rawVal.trim().length > 0) {
                  this.homey.log(`[${contextLabel}] [autocomplete] Resolving string "${rawVal}" for arg "${argName}" (type="${argType}") on card ${card.id}.`);

                  const options = await this.api.flow.getFlowCardAutocomplete({
                    id: card.id,
                    uri: card.ownerUri,
                    type: cardType,
                    name: argName,
                    query: rawVal
                  }).catch(err => {
                    this.homey.error(`[${contextLabel}] Autocomplete fetch failed for arg "${argName}":`, err.message);
                    return null;
                  });

                  if (Array.isArray(options) && options.length > 0) {
                    const match = options.find(opt => opt && opt.name && opt.name.toLowerCase() === rawVal.toLowerCase())
                                || options[0];
                    if (match) {
                      card.args[argName] = match;
                      this.homey.log(`[${contextLabel}] [autocomplete] Resolved "${rawVal}" -> ${JSON.stringify(match)}.`);
                    }
                  }
                }
                break;
              }

              // --- droptoken: injected by the model as [[...]] syntax — leave untouched ---
              default:
                break;
            }
          }
        }
      } catch (err) {
        this.homey.error(`[${contextLabel}] [normalize] Error during schema-driven normalization:`, err);
      }
    }
  }


  /**
   * Ensures that a card object has its `ownerUri` property correctly populated based on its `id`.
   *
   * In Homey, cards inside both Standard and Advanced flows must contain an `ownerUri` representing
   * the owner resource (e.g. `homey:device:UUID` for a device card, `homey:manager:name` for a manager,
   * or `homey:app:name` for an app card). If the model omits the `ownerUri` property, this method
   * reconstructs it by parsing the card's `id` — removing the last segment (the card action name)
   * to obtain the owner URI.
   *
   * @private
   * @param {Object} card - The card object containing at least an `id` property.
   * @param {string} card.id - The card identifier (e.g. `'homey:device:UUID:card_name'`).
   * @returns {void} The method mutates the card object in place.
   * @example
   * const card = { id: 'homey:device:123:onoff' };
   * this._ensureCardUri(card);
   * // card is now { id: 'homey:device:123:onoff', ownerUri: 'homey:device:123' }
   */
  _ensureCardUri(card) {
    if (!card || !card.id || typeof card.id !== 'string') return;
    if (card.ownerUri && typeof card.ownerUri === 'string' && card.ownerUri.trim().length > 0) return;

    const parts = card.id.split(':');
    if (parts.length > 1) {
      card.ownerUri = parts.slice(0, -1).join(':');
      this.homey.log(`[_ensureCardUri] Reconstructed missing ownerUri: "${card.ownerUri}" from card.id: "${card.id}"`);
    }
  }

  /**
   * Resolves a Homey device by ID or exact case-insensitive name, handling duplicate names.
   *
   * @private
   * @param {?string} deviceName - Name of the device to find (case-insensitive).
   * @param {?string} [deviceId] - Optional unique UUID of the device. Takes precedence.
   * @returns {Promise<{success: boolean, device: Object}>} The resolved device object.
   * @throws {Error} If the device is not found, or if multiple devices share the same name.
   * @example
   * const { device } = await this._resolveDevice('Living Room Light');
   */
  async _resolveDevice(deviceName, deviceId) {
    const devices = await this.api.devices.getDevices();
    const zones = await this.api.zones.getZones();
    const deviceList = Object.values(devices);

    // 1. Resolve by UUID (takes precedence)
    if (deviceId) {
      const device = deviceList.find(d => d.id === deviceId);
      if (!device) {
        throw new Error(`Device with ID "${deviceId}" not found.`);
      }
      return { success: true, device };
    }

    if (!deviceName) {
      throw new Error("Missing required parameter: provide 'deviceName' or 'deviceId'.");
    }

    // 2. Exact case-insensitive name matching
    const matches = deviceList.filter(d => d.name.toLowerCase() === deviceName.toLowerCase());

    if (matches.length === 0) {
      const err = new Error(`Device "${deviceName}" not found.`);
      err.notFound = true;
      throw err;
    }

    if (matches.length > 1) {
      // Ambiguity found (homonyms in different zones)
      const err = new Error(`Multiple devices named "${deviceName}" found.`);
      err.ambiguous = true;
      err.matches = matches.map(d => ({
        name: d.name,
        id: d.id,
        zone: d.zone && zones[d.zone] ? zones[d.zone].name : 'Unknown'
      }));
      throw err;
    }

    return { success: true, device: matches[0] };
  }

  /**
   * Executes arbitrary code via the HomeyScript proxy.
   *
   * @private
   * @param {string} code - The JavaScript code to execute.
   * @returns {Promise<*>} The result of the script execution.
   * @throws {Error} If execution fails.
   */
  async _executeHomeyScript(code) {
    const { scriptId } = await this._ensureHomeyScriptProxy();
    const response = await fetch(`${this._localUrl}/api/app/com.athom.homeyscript/script/${scriptId}/run`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this._sessionToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error('HomeyScript proxy script not found or HomeyScript is not installed. Please tell the user that HomeyScript must be installed from the Homey App Store to enable advanced device actions and flow management.');
      }
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();
    if (!result.success) {
      throw new Error(result.returns?.message || result.error || 'HomeyScript execution failed');
    }
    return result.returns;
  }
}

module.exports = { HomeyMCPAdapter };

