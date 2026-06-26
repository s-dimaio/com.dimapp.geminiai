'use strict';

/**
 * DeviceManager
 * 
 * Handles all device-related MCP tool calls (control, state, history, firmware, images).
 */
class DeviceManager {
  /**
   * @param {import('homey')} homey - The Homey app instance.
   * @param {Object} adapter - The parent HomeyMCPAdapter instance.
   */
  constructor(homey, adapter) {
    this.homey = homey;
    this.adapter = adapter;
  }

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
        error: `${err.message} You must **ALWAYS** call discover_resources first to see the exact resource names, then retry with the exact name.`,
        required_action: 'Call discover_resources to see available resources'
      };
    }

    if (!device.capabilitiesObj || !device.capabilitiesObj[capability]) {
      const availableCaps = Object.keys(device.capabilitiesObj || {});
      const suggestion = this._suggestCapability(capability, availableCaps);
      return {
        success: false,
        error: `Capability "${capability}" not found on device "${deviceName}". You must **ALWAYS** call discover_flow_cards(cardType="action", deviceName="${deviceName}") to find the correct Action Card for this operation.`,
        availableCapabilities: availableCaps,
        suggestion: suggestion ? `Did you mean '${suggestion}'?` : null,
        required_action: `Call discover_flow_cards with cardType="action" and deviceName="${deviceName}" to see available actions`
      };
    }

    const validation = this._validateCapabilityValue(capability, value);
    if (!validation.valid) {
      return { success: false, error: validation.error, expectedType: validation.expectedType, expectedRange: validation.expectedRange };
    }

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
        error: `Failed to set capability "${capability}" on "${deviceName}". This capability is read-only or requires a specific action. You must **ALWAYS** call discover_flow_cards(cardType="action", deviceName="${deviceName}") to find the correct Action Card.`,
        originalError: error.message,
        required_action: `Call discover_flow_cards with cardType="action" and deviceName="${deviceName}" to see available actions`
      };
    }

    let zoneName = 'Unknown';
    try {
      const zones = await this.adapter.api.zones.getZones();
      if (device.zone && zones[device.zone]) {
        zoneName = zones[device.zone].name;
      }
    } catch (error) {
      this.homey.log(`[DeviceManager] Failed to resolve zone for device "${device.name}":`, error.message);
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

  async getDeviceState(deviceName, deviceId = null) {
    if (!deviceName && !deviceId) {
      return { success: false, error: "Missing required parameter: provide 'deviceName' or 'deviceId'." };
    }

    await this.adapter.initialize();
    const zones = await this.adapter.api.zones.getZones();

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
        error: `${err.message} You must **ALWAYS** call discover_resources first to see the exact resource names, then retry.`
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

  async getDeviceImage(deviceName, deviceId = null) {
    if (!deviceName && !deviceId) {
      return { success: false, error: "Missing required parameter: provide 'deviceName' or 'deviceId'." };
    }

    try {
      await this.adapter.initialize();
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

  async getDeviceHistory(deviceName, deviceId = null) {
    if (!deviceName && !deviceId) {
      return { success: false, error: "Missing required parameter: provide 'deviceName' or 'deviceId'." };
    }

    await this.adapter.initialize();
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

  async getLogEntries(deviceName, logId, resolution, deviceId = null) {
    if (!deviceName && !deviceId) {
      return { success: false, error: "Missing required parameter: provide 'deviceName' or 'deviceId'." };
    }

    await this.adapter.initialize();
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

      const entries = await this.adapter.api.insights.getLogEntries({ id: log.id, resolution });
      const entriesArray = entries && entries.values ? entries.values : [];

      if (!entriesArray || entriesArray.length === 0) {
        return {
          success: true, device: deviceName, logId, logName: log.title || logId, resolution, entries: [],
          message: 'No data available for this time range.'
        };
      }

      let userTimezone = 'UTC';
      try {
        userTimezone = this.homey?.clock?.getTimezone?.() || 'UTC';
      } catch (e) {
        this.homey.log('[getLogEntries] Could not get timezone, using UTC');
      }

      const formattedEntries = entriesArray.map(entry => {
        const utcDate = new Date(entry.t);
        const utcDateStr = new Date(utcDate.toLocaleString('en-US', { timeZone: 'UTC' }));
        const localDateStr = new Date(utcDate.toLocaleString('en-US', { timeZone: userTimezone }));
        const offsetMs = localDateStr.getTime() - utcDateStr.getTime();
        const localDate = new Date(utcDate.getTime() + offsetMs);
        return {
          timestamp: localDate.toISOString().replace('Z', ''),
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
   * Manages device firmware updates (checking, listing, and installing)
   * for Matter, Zigbee, Z-Wave, and other supported devices.
   *
   * @public
   * @param {Object} params - Tool parameters.
   * @param {string} params.action - The action to perform: 'list', 'check', or 'install'.
   * @param {string} [params.deviceName] - The name of the target device (required for 'check' and 'install').
   * @param {string} [params.deviceId] - The UUID of the target device (required for 'check' and 'install').
   * @param {number} [params.softwareVersion] - The software version integer for Matter node installation.
   * @param {string} [params.versionString] - The version string (e.g. "0.0b0 / 1.0b8") for non-Matter device installation.
   * @returns {Promise<Object>} The operation result.
   */
  async manageDeviceFirmware({ action, deviceName, deviceId, softwareVersion, versionString }) {
    if (!action) {
      return { success: false, error: "Missing required parameter 'action'." };
    }

    await this.adapter.initialize();

    if (action === 'list') {
      try {
        const devices = await this.adapter.api.devices.getDevices();
        const deviceList = Object.values(devices);

        let matterNodes = {};
        try {
          matterNodes = await this.adapter.api.matter.getMatterNodes();
        } catch (e) {
          this.homey.log('[manageDeviceFirmware] Matter nodes not available:', e.message);
        }

        const promises = [];

        // Check Matter devices
        for (const [nodeId, node] of Object.entries(matterNodes)) {
          const matchingDevices = deviceList.filter(d => d.data && d.data.nodeCRUDItemId === nodeId);
          const matchingDevice = matchingDevices.find(d => d.data.nodeIndex === 0) || matchingDevices[0];
          
          const name = matchingDevice ? matchingDevice.name : `Matter Node (${nodeId})`;
          const matchedDeviceId = matchingDevice ? matchingDevice.id : nodeId;

          promises.push(
            this.adapter.api.matter.getNodeAvailableFirmwareUpdate({ id: nodeId })
              .then(updateInfo => ({
                target: 'matter',
                id: matchedDeviceId,
                matterNodeId: nodeId,
                name: name,
                status: 'supported',
                updateAvailable: !!(updateInfo && updateInfo.available === true),
                updateInfo: updateInfo || null
              }))
              .catch(err => ({
                target: 'matter',
                id: matchedDeviceId,
                matterNodeId: nodeId,
                name: name,
                status: 'error',
                error: err.message
              }))
          );
        }

        const results = await Promise.all(promises);

        // Check Zigbee/Z-Wave and other devices with firmwareUpdate property
        for (const device of deviceList) {
          // Skip Matter devices as they are already handled
          const isMatter = device.data && device.data.nodeCRUDItemId && matterNodes[device.data.nodeCRUDItemId];
          if (isMatter) continue;

          if (device.firmwareUpdate) {
            // A device is considered to have an update available if availableVersion is populated
            // or if the previous update attempt failed (state is 'error').
            const hasUpdate = !!device.firmwareUpdate.availableVersion || device.firmwareUpdate.state === 'error';
            let targetType = 'generic';
            if (device.flags && device.flags.includes('zigbee')) {
              targetType = 'zigbee';
            } else if (device.flags && device.flags.includes('zwave')) {
              targetType = 'zwave';
            }

            results.push({
              target: targetType,
              id: device.id,
              name: device.name,
              status: 'supported',
              updateAvailable: hasUpdate,
              updateInfo: {
                available: hasUpdate,
                currentVersion: device.firmwareUpdate.currentVersion || null,
                availableVersion: device.firmwareUpdate.availableVersion || null,
                state: device.firmwareUpdate.state || 'idle',
                requiresWake: !!device.firmwareUpdate.requiresWake,
                progress: device.firmwareUpdate.progress || null
              }
            });
          }
        }

        return {
          success: true,
          scannedCount: results.length,
          devices: results
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
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
          error: `${err.message} Please specify the device using its deviceId.`,
          matches: err.matches
        };
      }
      return { success: false, error: err.message };
    }

    let isMatter = false;
    let matterNodeId = device.data && device.data.nodeCRUDItemId ? device.data.nodeCRUDItemId : null;

    if (matterNodeId) {
      try {
        const matterNodes = await this.adapter.api.matter.getMatterNodes();
        if (matterNodes && matterNodes[matterNodeId]) {
          isMatter = true;
        }
      } catch (e) {
        // Ignore
      }
    }

    if (isMatter && matterNodeId) {
      if (action === 'check') {
        try {
          const updateInfo = await this.adapter.api.matter.getNodeAvailableFirmwareUpdate({ id: matterNodeId });
          let nodeInfo = null;
          let statusSummary = null;
          try {
            nodeInfo = await this.adapter.api.matter.getMatterNode({ id: matterNodeId });
            if (nodeInfo) {
              const currentVersion = nodeInfo.basicInformation ? nodeInfo.basicInformation.softwareVersionString : null;
              const pendingUpdate = nodeInfo.softwareVersionHistory ? nodeInfo.softwareVersionHistory.find(h => h.type !== 'initial') : null;
              const wakeUpHint = nodeInfo.icd ? nodeInfo.icd.userActiveModeTriggerHint : null;
              
              statusSummary = {
                currentVersion,
                pendingVersion: pendingUpdate ? pendingUpdate.softwareVersionString : null,
                updateState: pendingUpdate ? pendingUpdate.type : 'up_to_date',
                wakeUpHint
              };
            }
          } catch (e) {
            this.homey.log('[manageDeviceFirmware] Failed to get Matter node details:', e.message);
          }
          return {
            success: true,
            target: 'matter',
            deviceId: device.id,
            matterNodeId,
            deviceName: device.name,
            updateInfo,
            nodeInfo,
            statusSummary,
            message: updateInfo ? this.homey.__('prompt.firmware.matter_available') : this.homey.__('prompt.firmware.matter_not_available')
          };
        } catch (error) {
          return { success: false, target: 'matter', error: error.message };
        }
      } else if (action === 'install') {
        if (softwareVersion === undefined || softwareVersion === null) {
          return { success: false, error: this.homey.__('prompt.firmware.missing_software_version') };
        }
        try {
          const result = await this.adapter.api.matter.installNodeAvailableFirmwareUpdate({ id: matterNodeId, softwareVersion });
          return {
            success: true,
            target: 'matter',
            deviceId: device.id,
            matterNodeId,
            deviceName: device.name,
            result,
            message: this.homey.__('prompt.firmware.matter_initiated', { version: String(softwareVersion) })
          };
        } catch (error) {
          return { success: false, target: 'matter', error: error.message };
        }
      }
    }

    // Universal Non-Matter device firmware updates (Zigbee, Z-Wave, generic)
    if (device.firmwareUpdate) {
      const targetType = device.flags && device.flags.includes('zigbee') ? 'zigbee' : (device.flags && device.flags.includes('zwave') ? 'zwave' : 'generic');

      if (action === 'check') {
        const hasUpdate = !!device.firmwareUpdate.availableVersion || device.firmwareUpdate.state === 'error';
        const statusSummary = {
          currentVersion: device.firmwareUpdate.currentVersion,
          pendingVersion: device.firmwareUpdate.availableVersion,
          updateState: device.firmwareUpdate.state || 'up_to_date',
          wakeUpHint: device.firmwareUpdate.requiresWake ? this.homey.__('prompt.firmware.requires_wake_hint') : null
        };

        let message;
        if (device.firmwareUpdate.state === 'error') {
          message = this.homey.__('prompt.firmware.universal_error');
        } else if (hasUpdate) {
          message = this.homey.__('prompt.firmware.universal_available', { version: device.firmwareUpdate.availableVersion || '' });
        } else {
          message = this.homey.__('prompt.firmware.universal_not_available');
        }

        return {
          success: true,
          target: targetType,
          deviceId: device.id,
          deviceName: device.name,
          updateInfo: {
            available: hasUpdate,
            currentVersion: device.firmwareUpdate.currentVersion || null,
            availableVersion: device.firmwareUpdate.availableVersion || null,
            state: device.firmwareUpdate.state || 'idle',
            requiresWake: !!device.firmwareUpdate.requiresWake,
            progress: device.firmwareUpdate.progress || null
          },
          statusSummary,
          message
        };
      } else if (action === 'install') {
        return {
          success: false,
          error: this.homey.__('prompt.firmware.not_authorized')
        };
      }
    }

    return {
      success: false,
      error: this.homey.__('prompt.firmware.not_supported', { name: device.name })
    };
  }

  // --- Helpers ---

  async _resolveDevice(deviceName, deviceId) {
    await this.adapter.initialize();
    const devices = await this.adapter.api.devices.getDevices();
    const zones = await this.adapter.api.zones.getZones();
    const deviceList = Object.values(devices);

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

    const matches = deviceList.filter(d => d.name.toLowerCase() === deviceName.toLowerCase());

    if (matches.length === 0) {
      const err = new Error(`Device "${deviceName}" not found.`);
      err.notFound = true;
      throw err;
    }

    if (matches.length > 1) {
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

  _validateCapabilityValue(capability, value) {
    return { valid: true };
  }

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

  async _fetchDeviceImage(deviceId) {
    try {
      await this.adapter.initialize();
      const devices = await this.adapter.api.devices.getDevices();
      const device = Object.values(devices).find(d => d.id === deviceId);

      if (!device) throw new Error(`Device ${deviceId} not found`);
      if (!device.images || device.images.length === 0) {
        this.homey.log(`[DeviceManager] Device has no images array or empty`);
        return null;
      }

      const response = await fetch(`${this.adapter._localUrl}/api/manager/images/image`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${this.adapter._sessionToken}`, 'Content-Type': 'application/json' },
      });

      if (!response.ok) throw new Error(`Failed to fetch images: HTTP ${response.status}`);

      const allImages = await response.json();
      const deviceImageIds = device.images
        .filter(img => img.imageObj && img.imageObj.id)
        .map(img => img.imageObj.id);

      const deviceImages = Object.values(allImages).filter(img => deviceImageIds.includes(img.id));

      if (deviceImages.length === 0) {
        this.homey.log(`[DeviceManager] No matching images found after filtering`);
        return null;
      }

      const latestImage = deviceImages.sort((a, b) => new Date(b.lastUpdated) - new Date(a.lastUpdated))[0];

      const imageResponse = await fetch(`${this.adapter._localUrl}${latestImage.url}`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${this.adapter._sessionToken}` },
      });

      if (!imageResponse.ok) throw new Error(`Failed to download image: HTTP ${imageResponse.status}`);

      const imageBuffer = await imageResponse.arrayBuffer();
      const bufferSize = imageBuffer.byteLength;

      const MAX_IMAGE_SIZE = 4 * 1024 * 1024;
      if (bufferSize > MAX_IMAGE_SIZE) {
        throw new Error(`Image too large: ${(bufferSize / 1024 / 1024).toFixed(2)} MB (max 4MB)`);
      }

      const imageBase64 = Buffer.from(imageBuffer).toString('base64');
      const mimeType = imageResponse.headers.get('content-type') || 'image/jpeg';

      this.homey.log(`[DeviceManager] Fetched image for device ${deviceId}: ${(bufferSize / 1024).toFixed(2)} KB, type: ${mimeType}`);

      return { imageBase64, mimeType, imageId: latestImage.id, lastUpdated: latestImage.lastUpdated };

    } catch (error) {
      this.homey.error(`[DeviceManager] Error fetching device image:`, error);
      return null;
    }
  }
}

module.exports = { DeviceManager };
