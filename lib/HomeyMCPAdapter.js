'use strict';

const { HomeyAPIV3Local } = require('homey-api');
const fs = require('fs');
const path = require('path');
const { getTools } = require('./ToolSchema');
const { Scheduler } = require('./Scheduler');
const { DeviceManager } = require('./managers/DeviceManager');
const { DiscoveryManager } = require('./managers/DiscoveryManager');
const { FlowManager } = require('./managers/FlowManager');

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
    
    /** @type {DeviceManager} Handles device operations */
    this.deviceManager = new DeviceManager(homey, this);
    
    /** @type {DiscoveryManager} Handles discovery operations */
    this.discoveryManager = new DiscoveryManager(homey, this);
    
    /** @type {FlowManager} Handles flow operations */
    this.flowManager = new FlowManager(homey, this);
  }

  // ── Public Methods ──────────────────────────────────────────────────────────

  /**
   * Initialises the HomeyAPI instance (idempotent).
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
   */
  async listTools() {
    return { tools: getTools() };
  }

  /**
   * Dispatches an MCP tool call to the corresponding adapter method.
   */
  async callTool(name, args) {
    try {
      await this.initialize();

      switch (name) {
        case 'control_device':
          return await this.deviceManager.controlDevice(args.deviceName, args.capability, args.value, args.deviceId || null);
        case 'trigger_flow':
          return await this.flowManager.triggerFlow(args.flowName, args.args);
        case 'get_device_state':
          return await this.deviceManager.getDeviceState(args.deviceName, args.deviceId);
        case 'discover_resources':
        case 'discover_devices': // Backward-compatible alias
          if (args.query) {
            return await this.discoveryManager.searchDevices(args.query);
          }
          if (args.type === 'app') return await this.discoveryManager.listInstalledApps();
          if (args.type === 'system') return await this.discoveryManager.listSystemManagers();
          if (args.zoneName && args.deviceClass) {
            return await this.discoveryManager.listDevicesByClassInZone(args.deviceClass, args.zoneName);
          } else if (args.zoneName) {
            return await this.discoveryManager.listDevicesInZone(args.zoneName);
          } else if (args.deviceClass) {
            return await this.discoveryManager.listDevicesByClass(args.deviceClass);
          }
          return await this.discoveryManager.listAllDevices();
        case 'list_zones':
          return await this.discoveryManager.listZones();
        case 'get_home_summary':
          if (args.deviceClass) {
            return await this.discoveryManager.getDevicesStatusByClass(args.deviceClass, args.zone || null);
          } else if (args.zone) {
            return await this.discoveryManager.getDeviceCountByZone(args.zone);
          }
          return await this.discoveryManager.getDeviceCountByZone(null);
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
          return await this.scheduler.scheduleCommand(args.command, args.executeAt, args.description);
        case 'schedule_command': // Backward-compatible alias
          return await this.scheduler.scheduleCommand(args.command, args.executeAt, args.description);
        case 'discover_flows':
          if (args.flowName) {
            return await this.flowManager.getFlowInfo(args.flowName);
          }
          return await this.flowManager.listFlows(args.enabled, args.folder, args.type);
        case 'search_devices': // Backward-compatible alias
          return await this.discoveryManager.searchDevices(args.query);
        case 'discover_flow_cards':
          return await this.flowManager.discoverFlowCards({
            cardType: args.cardType || 'action',
            deviceName: args.deviceName,
            deviceId: args.deviceId,
            filterByApp: args.ownerUri // keeping back-compat
          });
        case 'list_device_actions':
          return await this.flowManager.discoverFlowCards({ cardType: 'action', deviceName: args.deviceName, deviceId: args.deviceId });
        case 'run_action_card':
          return await this.flowManager.runActionCard(args.deviceName, args.cardId, args.args, args.deviceId);
        case 'get_device_image':
          return await this.deviceManager.getDeviceImage(args.deviceName, args.deviceId);
        case 'get_device_logs':
          if (!args.logId) {
            return await this.deviceManager.getDeviceHistory(args.deviceName, args.deviceId);
          }
          if (!args.resolution) {
            return {
              success: false,
              error: `Missing required parameter 'resolution' for log retrieval. Valid values: 'last24Hours', 'last7Days', 'last14Days', 'last31Days', 'last6Months', 'last1Years', 'last5Years'.`,
              availableResolutions: ['last24Hours', 'last7Days', 'last14Days', 'last31Days', 'last6Months', 'last1Years', 'last5Years']
            };
          }
          return await this.deviceManager.getLogEntries(args.deviceName, args.logId, args.resolution, args.deviceId);
        case 'manage_flow':
          return await this.flowManager.manageFlow(args);
        case 'manage_advanced_flow':
          return await this.flowManager.manageAdvancedFlow(args);
        case 'discover_flow_details':
          return await this.flowManager.discoverFlowDetails(args.flowId, args.flowName);
        case 'manage_device_firmware':
          return await this.deviceManager.manageDeviceFirmware(args);
        default:
          return { success: false, error: `Unknown tool: ${name}` };
      }
    } catch (error) {
      return { success: false, error: error.message, stack: error.stack };
    }
  }

  /**
   * Cleans up HomeyAPI resources.
   *
   * @public
   * @returns {Promise<void>}
   */
  async cleanup() {
    this.api = null;
  }
  
  /**
   * Restores scheduled commands.
   *
   * @public
   * @returns {Promise<void>}
   */
  async restoreScheduledCommands() {
    return await this.scheduler.restoreScheduledCommands();
  }
}

module.exports = { HomeyMCPAdapter };
