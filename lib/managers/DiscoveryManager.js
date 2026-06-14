'use strict';

/**
 * DiscoveryManager
 * 
 * Handles discovery, search, and home state aggregation (e.g., getting lists of devices, zones, and status summaries).
 */
class DiscoveryManager {
  /**
   * @param {import('homey')} homey - The Homey app instance.
   * @param {Object} adapter - The parent HomeyMCPAdapter instance.
   */
  constructor(homey, adapter) {
    this.homey = homey;
    this.adapter = adapter;
  }

  /**
   * Lists all devices in a specific zone (and its sub-zones).
   *
   * @public
   * @param {string} zoneName - The zone/room name to filter by.
   * @param {boolean|undefined} [includeHiddenGrouped] - Optional override for hidden/grouped device visibility.
   *   - `true`: force-include hidden and grouped devices, ignoring the global app setting.
   *   - `false`: force-exclude hidden and grouped devices, ignoring the global app setting.
   *   - `undefined` (default): defer to the global app setting.
   * @returns {Promise<Object>} MCP tool response with devices found in the zone.
   * @example
   * // Default behaviour (reads global setting)
   * await discoveryManager.listDevicesInZone('Living Room');
   * // Force-include hidden devices regardless of global setting
   * await discoveryManager.listDevicesInZone('Kitchen', true);
   */
  async listDevicesInZone(zoneName, includeHiddenGrouped = undefined) {
    if (!zoneName) {
      return { success: false, error: "Missing required parameter 'zoneName'. Please specify the room/zone name (e.g., 'Living Room', 'Kitchen')." };
    }

    try {
      await this.adapter.initialize();

      const devices = await this.adapter.api.devices.getDevices();
      const zones = await this.adapter.api.zones.getZones();

      const targetZone = Object.values(zones).find(z => z.name.toLowerCase() === zoneName.toLowerCase());

      if (!targetZone) {
        return { success: false, error: `Zone "${zoneName}" not found. Retry discover_devices using one of the exact names in availableZones.`, availableZones: Object.values(zones).map(z => z.name) };
      }

      const targetZoneIds = this._getAllChildZoneIds(targetZone.id, zones);
      let devicesInZone = Object.values(devices).filter(d => d.zone && targetZoneIds.includes(d.zone));

      devicesInZone = this._filterVisibleDevices(devicesInZone, includeHiddenGrouped);

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
        message: `Found ${deviceList.length} device(s) in ${zoneName}. Use discover_flow_cards(cardType="action", deviceName) to get available actions for a specific device.`
      };

    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async listZones() {
    await this.adapter.initialize();
    const zones = await this.adapter.api.zones.getZones();

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
   * Lists all devices in the home.
   *
   * @public
   * @param {boolean|undefined} [includeHiddenGrouped] - Optional override for hidden/grouped device visibility.
   *   - `true`: force-include hidden and grouped devices, ignoring the global app setting.
   *   - `false`: force-exclude hidden and grouped devices, ignoring the global app setting.
   *   - `undefined` (default): defer to the global app setting.
   * @returns {Promise<Object>} MCP tool response with all devices in the home.
   * @example
   * // Default behaviour (reads global setting)
   * await discoveryManager.listAllDevices();
   * // Force-exclude hidden devices regardless of global setting
   * await discoveryManager.listAllDevices(false);
   */
  async listAllDevices(includeHiddenGrouped = undefined) {
    try {
      await this.adapter.initialize();
      const devicesMap = await this.adapter.api.devices.getDevices();
      const zones = await this.adapter.api.zones.getZones();

      const devices = this._filterVisibleDevices(devicesMap, includeHiddenGrouped);

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
        message: `Found ${deviceList.length} device(s) in the home. Use discover_flow_cards(cardType="action", deviceName) to get available actions for a specific device.`
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Lists all devices of a specific class.
   *
   * @public
   * @param {string} deviceClass - The device class to filter by (e.g., 'light', 'thermostat').
   * @param {boolean|undefined} [includeHiddenGrouped] - Optional override for hidden/grouped device visibility.
   *   - `true`: force-include hidden and grouped devices, ignoring the global app setting.
   *   - `false`: force-exclude hidden and grouped devices, ignoring the global app setting.
   *   - `undefined` (default): defer to the global app setting.
   * @returns {Promise<Object>} MCP tool response with devices of the requested class.
   * @example
   * // Default behaviour (reads global setting)
   * await discoveryManager.listDevicesByClass('light');
   * // Force-include hidden lights
   * await discoveryManager.listDevicesByClass('light', true);
   */
  async listDevicesByClass(deviceClass, includeHiddenGrouped = undefined) {
    if (!deviceClass) {
      return {
        success: false,
        error: "Missing required parameter 'deviceClass'. Please specify the device class (e.g., 'light', 'thermostat', 'sensor').",
        availableClasses: Object.keys(this.adapter.deviceClasses.classes || {})
      };
    }

    await this.adapter.initialize();
    const devicesMap = await this.adapter.api.devices.getDevices();
    const zones = await this.adapter.api.zones.getZones();

    const allDevicesFiltered = this._filterVisibleDevices(devicesMap, includeHiddenGrouped);
    const normalizedClass = deviceClass.toLowerCase();

    const filteredDevices = allDevicesFiltered.filter(d => {
      const effectiveClass = (d.virtualClass || d.class)?.toLowerCase();
      return effectiveClass === normalizedClass;
    });

    if (filteredDevices.length === 0) {
      const actualClasses = [...new Set(Object.values(devicesMap)
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
      message: `Found ${deviceList.length} ${deviceClass} device(s). Use discover_flow_cards(cardType="action", deviceName) to get available actions for a specific device.`
    };
  }

  /**
   * Lists devices of a specific class within a specific zone (and its sub-zones).
   *
   * @public
   * @param {string} deviceClass - The device class to filter by.
   * @param {string} zoneName - The zone/room name to filter by.
   * @param {boolean|undefined} [includeHiddenGrouped] - Optional override for hidden/grouped device visibility.
   *   - `true`: force-include hidden and grouped devices, ignoring the global app setting.
   *   - `false`: force-exclude hidden and grouped devices, ignoring the global app setting.
   *   - `undefined` (default): defer to the global app setting.
   * @returns {Promise<Object>} MCP tool response with devices of the requested class in the given zone.
   * @example
   * await discoveryManager.listDevicesByClassInZone('light', 'Living Room');
   * await discoveryManager.listDevicesByClassInZone('light', 'Living Room', true);
   */
  async listDevicesByClassInZone(deviceClass, zoneName, includeHiddenGrouped = undefined) {
    if (!deviceClass || !zoneName) {
      return { success: false, error: "Missing required parameters 'deviceClass' and/or 'zoneName'." };
    }

    try {
      await this.adapter.initialize();
      const zones = await this.adapter.api.zones.getZones();
      const normalizedZoneInput = zoneName.toLowerCase();
      
      const targetZone = Object.values(zones).find(z => z.name.toLowerCase() === normalizedZoneInput);
      if (!targetZone) {
        return { success: false, error: `Zone '${zoneName}' not found.` };
      }

      const nestedZoneIds = this._getAllChildZoneIds(targetZone.id, zones);
      const devicesMap = await this.adapter.api.devices.getDevices();

      const allDevicesFiltered = this._filterVisibleDevices(devicesMap, includeHiddenGrouped);
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
        message: `Found ${devicesInZone.length} '${deviceClass}' in '${targetZone.name}'. Use discover_flow_cards(cardType="action", deviceName) to get available actions.`
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Returns a status summary of all devices of a specific class, optionally filtered by zone.
   *
   * @public
   * @param {string} deviceClass - The device class to query.
   * @param {string|null} [zoneName=null] - Optional zone name to restrict the query.
   * @param {boolean|undefined} [includeHiddenGrouped] - Optional override for hidden/grouped device visibility.
   *   - `true`: force-include hidden and grouped devices, ignoring the global app setting.
   *   - `false`: force-exclude hidden and grouped devices, ignoring the global app setting.
   *   - `undefined` (default): defer to the global app setting.
   * @returns {Promise<Object>} MCP tool response with on/off summary for the class.
   * @example
   * await discoveryManager.getDevicesStatusByClass('light');
   * await discoveryManager.getDevicesStatusByClass('light', 'Kitchen', false);
   */
  async getDevicesStatusByClass(deviceClass, zoneName = null, includeHiddenGrouped = undefined) {
    try {
      await this.adapter.initialize();

      if (!deviceClass || !this.adapter.deviceClasses.classes[deviceClass]) {
        const devices = await this.adapter.api.devices.getDevices();
        const actualClasses = [...new Set(Object.values(devices).map(d => d.class).filter(Boolean))];
        return { success: false, error: `Unknown device class: "${deviceClass}"`, availableClasses: actualClasses };
      }

      const devices = await this.adapter.api.devices.getDevices();
      const zones = await this.adapter.api.zones.getZones();

      const visibleDevices = this._filterVisibleDevices(devices, includeHiddenGrouped);
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

      const devicesWithState = classDevices.map(d => {
        const state = {};
        const capabilityKeys = Object.keys(d.capabilitiesObj || {});
        if (d.capabilitiesObj) {
          for (const [capName, capObj] of Object.entries(d.capabilitiesObj)) {
            state[capName] = capObj.value;
          }
        }
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
   * Returns a device count summary grouped by zone (or for a single zone if specified).
   *
   * @public
   * @param {string|null} [zoneName=null] - Optional zone name. If null, returns all zones.
   * @param {boolean|undefined} [includeHiddenGrouped] - Optional override for hidden/grouped device visibility.
   *   - `true`: force-include hidden and grouped devices, ignoring the global app setting.
   *   - `false`: force-exclude hidden and grouped devices, ignoring the global app setting.
   *   - `undefined` (default): defer to the global app setting.
   * @returns {Promise<Object>} MCP tool response with zone-level device count summary.
   * @example
   * await discoveryManager.getDeviceCountByZone();
   * await discoveryManager.getDeviceCountByZone('Kitchen', true);
   */
  async getDeviceCountByZone(zoneName = null, includeHiddenGrouped = undefined) {
    try {
      await this.adapter.initialize();
      const devicesMap = await this.adapter.api.devices.getDevices();
      const zones = await this.adapter.api.zones.getZones();

      const devicesArray = this._filterVisibleDevices(devicesMap, includeHiddenGrouped);

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

  async getDeviceClassInfo(className = null, searchTerm = null) {
    try {
      if (className) {
        const classLower = className.toLowerCase();
        const info = this.adapter.deviceClasses.classes[classLower];
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
        const allClasses = Object.keys(this.adapter.deviceClasses.classes);
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
        const matches = Object.entries(this.adapter.deviceClasses.classes)
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
            availableClasses: Object.keys(this.adapter.deviceClasses.classes).slice(0, 15)
          };
        }
        return { success: true, searchTerm, matchCount: matches.length, matches };
      }

      const allClasses = Object.entries(this.adapter.deviceClasses.classes).map(([id, info]) => ({
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
   * Searches for devices by keyword(s) in their name.
   *
   * @public
   * @param {string} query - Comma-separated keywords to search (e.g., 'luce, light, cucina').
   * @param {boolean|undefined} [includeHiddenGrouped] - Optional override for hidden/grouped device visibility.
   *   - `true`: force-include hidden and grouped devices, ignoring the global app setting.
   *   - `false`: force-exclude hidden and grouped devices, ignoring the global app setting.
   *   - `undefined` (default): defer to the global app setting.
   * @returns {Promise<Object>} MCP tool response with matching devices.
   * @example
   * await discoveryManager.searchDevices('cucina, kitchen');
   * await discoveryManager.searchDevices('cucina, kitchen', true);
   */
  async searchDevices(query, includeHiddenGrouped = undefined) {
    if (!query) {
      return { success: false, error: "Missing required parameter 'query'" };
    }

    try {
      await this.adapter.initialize();
      const devicesMap = await this.adapter.api.devices.getDevices();
      const zones = await this.adapter.api.zones.getZones();
      const keywords = query.toLowerCase().split(/[,\s]+/).filter(k => k.length > 2);

      const allDevicesFiltered = this._filterVisibleDevices(devicesMap, includeHiddenGrouped);

      if (keywords.length === 0) {
        return { success: false, error: 'Query too short or empty. Please provide valid keywords.' };
      }

      const matches = allDevicesFiltered.filter(d => {
        const nameLower = d.name.toLowerCase();
        return keywords.some(k => nameLower.includes(k));
      });

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
          ? `Found ${results.length} device(s) matching "${query}". Use discover_flow_cards(cardType="action", deviceName) to get available actions for a specific device.`
          : `No devices found matching any of: ${keywords.join(', ')}`
      };

    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async listInstalledApps() {
    try {
      await this.adapter.initialize();
      const appsObj = await this.adapter.api.apps.getApps();
      const apps = Object.values(appsObj)
        .filter(a => a.uri && a.uri.startsWith('homey:app:'))
        .map(a => ({ name: a.name || a.id, ownerUri: a.uri }));

      return { success: true, count: apps.length, apps };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async listSystemManagers() {
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

  // --- Helpers ---

  _getAllChildZoneIds(rootZoneId, zones) {
    const ids = [rootZoneId];
    const children = Object.values(zones).filter(z => z.parent === rootZoneId);
    for (const child of children) {
      ids.push(...this._getAllChildZoneIds(child.id, zones));
    }
    return ids;
  }

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
   * Filters out hidden devices and group-member devices based on a three-branch override logic.
   *
   * The override parameter `includeHiddenGrouped` supports bidirectional override:
   * - If `true`: skip all filtering (force-include hidden and grouped devices), regardless of the global app setting.
   * - If `false`: apply filtering (force-exclude hidden and grouped devices), regardless of the global app setting.
   * - If `undefined`: read the global app setting (`gemini_include_hidden_grouped`) to decide.
   *
   * @private
   * @param {Array<Object>|Object} devices - The array or map of Homey device objects to filter.
   * @param {boolean|undefined} [includeHiddenGrouped] - Optional per-call override. When omitted, defers to the global setting.
   * @returns {Array<Object>} The filtered (or unfiltered) list of devices.
   * @example
   * // Defer to global setting
   * const visible = this._filterVisibleDevices(devicesMap);
   * // Force-include regardless of global setting
   * const all = this._filterVisibleDevices(devicesMap, true);
   * // Force-exclude regardless of global setting
   * const filtered = this._filterVisibleDevices(devicesMap, false);
   */
  _filterVisibleDevices(devices, includeHiddenGrouped = undefined) {
    const deviceArray = Array.isArray(devices) ? devices : Object.values(devices);

    // Resolve the effective flag using the three-branch logic:
    // - explicit true/false override takes precedence over the global setting
    // - undefined defers to the global app setting
    const effectiveInclude = typeof includeHiddenGrouped === 'boolean'
      ? includeHiddenGrouped
      : this.homey.settings.get('gemini_include_hidden_grouped') === true;

    if (effectiveInclude) {
      return deviceArray;
    }

    const excludedIds = new Set();

    deviceArray.forEach(d => {
      const memberIds = d.settings?.deviceIds;
      if (Array.isArray(memberIds)) {
        memberIds.forEach(id => excludedIds.add(id));
      }
    });

    return deviceArray.filter(d => {
      const isGroupMember = excludedIds.has(d.id);
      const isHidden = d.hidden === true;
      return !isGroupMember && !isHidden;
    });
  }
}

module.exports = { DiscoveryManager };
